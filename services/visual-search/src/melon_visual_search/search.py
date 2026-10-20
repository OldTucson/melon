from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID

import numpy as np
import numpy.typing as npt

from .image_io import ImageSearchError, Region, decode_image, make_regions
from .local_features import (
    LocalFeatures,
    extract_local_features,
    geometric_evidence,
    load_local_features,
    phash_distance,
)
from .repository import MAX_ALLOWED_PATTERN_IDS, RecallCandidate
from .scoring import (
    MatchEvidence,
    MatchKind,
    ScoringConfig,
    classify,
    load_scoring_config,
)

MAX_RERANK_CANDIDATES = 50
MAX_SEARCH_RESULTS = 30
DEFAULT_FEATURE_CACHE_SIZE = 128


class NoIndexError(RuntimeError):
    code = "NO_INDEX"

    def __init__(self) -> None:
        super().__init__(self.code)


class SearchUnavailableError(RuntimeError):
    code = "UNAVAILABLE"

    def __init__(self) -> None:
        super().__init__(self.code)


@dataclass(frozen=True)
class SearchItem:
    pattern_id: UUID
    kind: MatchKind
    score: float
    category_rank: int


@dataclass(frozen=True)
class SearchResult:
    width: int
    height: int
    items: tuple[SearchItem, ...]


class SearchRepository(Protocol):
    def close(self) -> None: ...

    def has_ready_documents(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        allowed_pattern_ids: Sequence[UUID],
    ) -> bool: ...

    def recall_candidates(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        allowed_pattern_ids: Sequence[UUID],
        query_vectors: npt.NDArray[np.float32],
    ) -> tuple[RecallCandidate, ...]: ...


class SearchFeatureStorage(Protocol):
    def read_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
    ) -> bytes: ...


class SearchEmbedder(Protocol):
    def embed(
        self,
        regions: Sequence[Region],
    ) -> npt.NDArray[np.float32]: ...


FeatureCacheKey = tuple[UUID, str, str]


class SearchService:
    def __init__(
        self,
        repository: SearchRepository,
        storage: SearchFeatureStorage,
        embedder: SearchEmbedder,
        *,
        index_version: str,
        scoring_config: ScoringConfig | None = None,
        feature_cache_size: int = DEFAULT_FEATURE_CACHE_SIZE,
    ) -> None:
        if feature_cache_size <= 0:
            raise ValueError("feature_cache_size must be positive")
        self._repository = repository
        self._storage = storage
        self._embedder = embedder
        self._index_version = index_version
        self._scoring = scoring_config or load_scoring_config(
            Path(__file__).resolve().parents[2] / "config" / "scoring-v1.json"
        )
        self._feature_cache_size = feature_cache_size
        self._feature_cache: OrderedDict[FeatureCacheKey, LocalFeatures] = OrderedDict()
        self._feature_cache_lock = threading.Lock()

    def close(self) -> None:
        self._repository.close()

    def search_encoded(
        self,
        owner_id: UUID,
        allowed_pattern_ids: Sequence[UUID],
        encoded: bytes,
    ) -> SearchResult:
        return self.search(owner_id, allowed_pattern_ids, decode_image(encoded))

    def search(
        self,
        owner_id: UUID,
        allowed_pattern_ids: Sequence[UUID],
        image: npt.NDArray[np.uint8],
    ) -> SearchResult:
        if not isinstance(owner_id, UUID):
            raise ValueError("owner_id must be a UUID")
        if len(allowed_pattern_ids) > MAX_ALLOWED_PATTERN_IDS:
            raise ValueError("allowed_pattern_ids exceeds the supported limit")
        if any(not isinstance(pattern_id, UUID) for pattern_id in allowed_pattern_ids):
            raise ValueError("allowed_pattern_ids must contain UUID values")
        allowed_ids = tuple(dict.fromkeys(allowed_pattern_ids))
        if not allowed_ids:
            raise NoIndexError()
        if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3:
            raise ValueError("image must be an HxWx3 uint8 RGB array")

        try:
            has_ready = self._repository.has_ready_documents(
                owner_id=owner_id,
                index_version=self._index_version,
                allowed_pattern_ids=allowed_ids,
            )
        except Exception as error:
            raise SearchUnavailableError() from error
        if not has_ready:
            raise NoIndexError()

        regions = make_regions(image)
        try:
            query_vectors = self._validated_vectors(self._embedder.embed(regions))
            candidates = self._repository.recall_candidates(
                owner_id=owner_id,
                index_version=self._index_version,
                allowed_pattern_ids=allowed_ids,
                query_vectors=query_vectors,
            )
        except ImageSearchError:
            raise
        except Exception as error:
            raise SearchUnavailableError() from error

        query_features = extract_local_features(image)
        allowed_set = set(allowed_ids)
        ranked: list[SearchItem] = []
        for candidate in candidates[:MAX_RERANK_CANDIDATES]:
            if (
                candidate.owner_id != owner_id
                or candidate.pattern_id not in allowed_set
                or candidate.index_version != self._index_version
                or candidate.best_visual < self._scoring.minimum_visual_similarity
            ):
                continue
            try:
                reference_features = self._load_features(candidate)
                geometry = geometric_evidence(query_features, reference_features)
                classified = classify(
                    MatchEvidence(
                        best_visual=candidate.best_visual,
                        global_visual=candidate.global_visual,
                        phash_distance=phash_distance(
                            query_features.phash,
                            candidate.phash,
                        ),
                        inliers=geometry.inliers,
                        inlier_ratio=geometry.inlier_ratio,
                        coverage=geometry.coverage,
                    ),
                    self._scoring,
                )
            except Exception as error:
                raise SearchUnavailableError() from error
            if classified is None:
                continue
            ranked.append(
                SearchItem(
                    pattern_id=candidate.pattern_id,
                    kind=classified.kind,
                    score=classified.score,
                    category_rank=classified.category_rank,
                )
            )

        ranked.sort(
            key=lambda item: (
                -item.category_rank,
                -item.score,
                str(item.pattern_id),
            )
        )
        return SearchResult(
            width=int(image.shape[1]),
            height=int(image.shape[0]),
            items=tuple(ranked[:MAX_SEARCH_RESULTS]),
        )

    def _load_features(self, candidate: RecallCandidate) -> LocalFeatures:
        key = (
            candidate.document_id,
            candidate.preview_hash,
            candidate.index_version,
        )
        with self._feature_cache_lock:
            cached = self._feature_cache.get(key)
            if cached is not None:
                if cached.phash != candidate.phash:
                    raise SearchUnavailableError()
                self._feature_cache.move_to_end(key)
                return cached

        encoded = self._storage.read_features(
            candidate.owner_id,
            candidate.pattern_id,
            candidate.index_version,
            candidate.preview_hash,
        )
        loaded = load_local_features(encoded)
        if loaded.phash != candidate.phash:
            raise SearchUnavailableError()
        with self._feature_cache_lock:
            existing = self._feature_cache.get(key)
            if existing is not None:
                if existing.phash != candidate.phash:
                    raise SearchUnavailableError()
                self._feature_cache.move_to_end(key)
                return existing
            self._feature_cache[key] = loaded
            while len(self._feature_cache) > self._feature_cache_size:
                self._feature_cache.popitem(last=False)
        return loaded

    @staticmethod
    def _validated_vectors(value: object) -> npt.NDArray[np.float32]:
        if (
            not isinstance(value, np.ndarray)
            or value.dtype != np.float32
            or value.shape != (10, 384)
            or not np.isfinite(value).all()
        ):
            raise SearchUnavailableError()
        norms = np.linalg.norm(value, axis=1)
        if not np.allclose(norms, np.ones(10), rtol=1e-5, atol=1e-6):
            raise SearchUnavailableError()
        return np.ascontiguousarray(value, dtype=np.float32)
