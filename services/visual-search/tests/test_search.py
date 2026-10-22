from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import numpy as np
import pytest

from melon_visual_search.image_io import decode_image
from melon_visual_search.local_features import (
    extract_local_features,
    serialize_local_features,
)
from melon_visual_search.repository import RecallCandidate
from melon_visual_search.search import (
    NoIndexError,
    SearchEvidenceResult,
    SearchService,
    SearchUnavailableError,
)

FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures"
INDEX_VERSION = "visual-search-v1"


class FakeEmbedder:
    def embed(self, regions: object) -> np.ndarray:
        del regions
        vectors = np.zeros((10, 384), dtype=np.float32)
        vectors[:, 0] = 1.0
        return vectors


class FakeRepository:
    def __init__(
        self,
        candidates: list[RecallCandidate],
        *,
        has_ready: bool = True,
    ) -> None:
        self.candidates = candidates
        self.has_ready = has_ready
        self.recall_calls: list[tuple[UUID, str, tuple[UUID, ...]]] = []
        self.closed = False

    def close(self) -> None:
        self.closed = True

    def has_ready_documents(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        allowed_pattern_ids: list[UUID] | tuple[UUID, ...],
    ) -> bool:
        del owner_id, index_version, allowed_pattern_ids
        return self.has_ready

    def recall_candidates(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        allowed_pattern_ids: list[UUID] | tuple[UUID, ...],
        query_vectors: np.ndarray,
    ) -> tuple[RecallCandidate, ...]:
        assert query_vectors.dtype == np.float32
        assert query_vectors.shape == (10, 384)
        self.recall_calls.append(
            (owner_id, index_version, tuple(allowed_pattern_ids))
        )
        return tuple(self.candidates)


class FakeStorage:
    def __init__(self, archives: dict[tuple[UUID, str], bytes]) -> None:
        self.archives = archives
        self.reads: list[tuple[UUID, UUID, str, str]] = []

    def read_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
    ) -> bytes:
        self.reads.append((owner_id, pattern_id, index_version, preview_hash))
        return self.archives[(pattern_id, preview_hash)]


def _candidate(
    owner_id: UUID,
    pattern_id: UUID,
    *,
    best_visual: float = 0.8,
    global_visual: float = 0.75,
    phash: str = "0000000000000000",
    preview_hash: str | None = None,
    document_id: UUID | None = None,
) -> RecallCandidate:
    fingerprint = preview_hash or uuid4().hex * 2
    return RecallCandidate(
        document_id=document_id or uuid4(),
        owner_id=owner_id,
        pattern_id=pattern_id,
        index_version=INDEX_VERSION,
        preview_hash=fingerprint,
        phash=phash,
        best_visual=best_visual,
        global_visual=global_visual,
    )


def _service(
    repository: FakeRepository,
    storage: FakeStorage,
    *,
    feature_cache_size: int = 128,
) -> SearchService:
    return SearchService(
        repository,
        storage,
        FakeEmbedder(),
        index_version=INDEX_VERSION,
        feature_cache_size=feature_cache_size,
    )


@pytest.fixture(scope="module")
def query_image() -> np.ndarray:
    return decode_image((FIXTURE_DIRECTORY / "checker-crop.jpg").read_bytes())


def test_search_never_returns_a_disallowed_or_foreign_pattern(
    query_image: np.ndarray,
) -> None:
    owner = uuid4()
    allowed = uuid4()
    disallowed = uuid4()
    foreign = uuid4()
    blank = np.zeros((256, 256, 3), dtype=np.uint8)
    features = extract_local_features(blank)
    archive = serialize_local_features(features)
    candidates = [
        _candidate(owner, allowed, phash=features.phash),
        _candidate(owner, disallowed, phash=features.phash),
        _candidate(uuid4(), foreign, phash=features.phash),
    ]
    storage = FakeStorage(
        {(item.pattern_id, item.preview_hash): archive for item in candidates}
    )
    service = _service(FakeRepository(candidates), storage)

    result = service.search(
        owner_id=owner,
        allowed_pattern_ids=[allowed],
        image=query_image,
    )

    assert [item.pattern_id for item in result.items] == [allowed]
    assert disallowed not in {item.pattern_id for item in result.items}
    assert foreign not in {item.pattern_id for item in result.items}


def test_verified_crop_ranks_before_visual_neighbor(query_image: np.ndarray) -> None:
    owner = uuid4()
    source = uuid4()
    neighbor = uuid4()
    reference_image = decode_image((FIXTURE_DIRECTORY / "checker.png").read_bytes())
    source_features = extract_local_features(reference_image)
    neighbor_features = extract_local_features(
        np.zeros((512, 512, 3), dtype=np.uint8)
    )
    source_candidate = _candidate(
        owner,
        source,
        best_visual=0.82,
        global_visual=0.75,
        phash=source_features.phash,
    )
    neighbor_candidate = _candidate(
        owner,
        neighbor,
        best_visual=0.95,
        global_visual=0.92,
        phash=neighbor_features.phash,
    )
    storage = FakeStorage(
        {
            (source, source_candidate.preview_hash): serialize_local_features(
                source_features
            ),
            (neighbor, neighbor_candidate.preview_hash): serialize_local_features(
                neighbor_features
            ),
        }
    )
    service = _service(
        FakeRepository([neighbor_candidate, source_candidate]),
        storage,
    )

    result = service.search(owner, [source, neighbor], query_image)

    assert result.items[0].pattern_id == source
    assert result.items[0].kind in {"probable_source", "possible_source"}
    assert result.items[1].pattern_id == neighbor
    assert result.items[1].kind == "visually_similar"


def test_search_ranks_the_same_evidence_exposed_for_offline_calibration(
    query_image: np.ndarray,
) -> None:
    owner = uuid4()
    pattern = uuid4()
    reference = extract_local_features(query_image)
    candidate = _candidate(
        owner,
        pattern,
        best_visual=0.9,
        global_visual=0.85,
        phash=reference.phash,
    )
    service = _service(
        FakeRepository([candidate]),
        FakeStorage(
            {
                (pattern, candidate.preview_hash): serialize_local_features(reference),
            }
        ),
    )

    evidence = service.collect_evidence(
        owner,
        (pattern,),
        query_image,
        minimum_visual_similarity=0.0,
    )
    ranked = service.rank_evidence(evidence)
    online = service.search(owner, (pattern,), query_image)

    assert isinstance(evidence, SearchEvidenceResult)
    assert evidence.items[0].pattern_id == pattern
    assert ranked == online


def test_zero_allowed_ids_and_no_ready_index_raise_no_index(
    query_image: np.ndarray,
) -> None:
    owner = uuid4()
    empty_repository = FakeRepository([])
    service = _service(empty_repository, FakeStorage({}))

    with pytest.raises(NoIndexError):
        service.search(owner, [], query_image)
    assert empty_repository.recall_calls == []

    unavailable_repository = FakeRepository([], has_ready=False)
    with pytest.raises(NoIndexError):
        _service(unavailable_repository, FakeStorage({})).search(
            owner,
            [uuid4()],
            query_image,
        )
    assert unavailable_repository.recall_calls == []


def test_candidate_below_minimum_similarity_is_not_loaded_or_returned(
    query_image: np.ndarray,
) -> None:
    owner = uuid4()
    pattern = uuid4()
    candidate = _candidate(owner, pattern, best_visual=0.549)
    storage = FakeStorage({})
    service = _service(FakeRepository([candidate]), storage)

    result = service.search(owner, [pattern], query_image)

    assert result.items == ()
    assert storage.reads == []


def test_reranking_loads_at_most_fifty_candidates_and_returns_at_most_thirty(
    query_image: np.ndarray,
) -> None:
    owner = uuid4()
    blank = np.zeros((256, 256, 3), dtype=np.uint8)
    features = extract_local_features(blank)
    archive = serialize_local_features(features)
    candidates = [
        _candidate(
            owner,
            uuid4(),
            best_visual=0.7,
            global_visual=0.65,
            phash=features.phash,
        )
        for _ in range(60)
    ]
    storage = FakeStorage(
        {(item.pattern_id, item.preview_hash): archive for item in candidates}
    )
    service = _service(FakeRepository(candidates), storage)

    result = service.search(
        owner,
        [item.pattern_id for item in candidates],
        query_image,
    )

    assert len(storage.reads) == 50
    assert len(result.items) == 30
    assert list(result.items) == sorted(
        result.items,
        key=lambda item: (-item.category_rank, -item.score, str(item.pattern_id)),
    )


def test_feature_cache_is_bounded_and_keyed_by_document_hash_and_version(
    query_image: np.ndarray,
) -> None:
    owner = uuid4()
    first_pattern = uuid4()
    second_pattern = uuid4()
    blank = np.zeros((256, 256, 3), dtype=np.uint8)
    features = extract_local_features(blank)
    archive = serialize_local_features(features)
    first = _candidate(owner, first_pattern, phash=features.phash)
    second = _candidate(owner, second_pattern, phash=features.phash)
    storage = FakeStorage(
        {
            (first.pattern_id, first.preview_hash): archive,
            (second.pattern_id, second.preview_hash): archive,
        }
    )
    repository = FakeRepository([first])
    service = _service(repository, storage, feature_cache_size=1)

    service.search(owner, [first_pattern], query_image)
    service.search(owner, [first_pattern], query_image)
    assert len(storage.reads) == 1

    repository.candidates = [second]
    service.search(owner, [second_pattern], query_image)
    repository.candidates = [first]
    service.search(owner, [first_pattern], query_image)
    assert len(storage.reads) == 3

    new_hash = uuid4().hex * 2
    changed = replace(first, preview_hash=new_hash)
    storage.archives[(first_pattern, new_hash)] = archive
    repository.candidates = [changed]
    service.search(owner, [first_pattern], query_image)
    assert len(storage.reads) == 4


def test_corrupt_local_feature_archive_is_unavailable(
    query_image: np.ndarray,
) -> None:
    owner = uuid4()
    pattern = uuid4()
    candidate = _candidate(owner, pattern)
    service = _service(
        FakeRepository([candidate]),
        FakeStorage({(pattern, candidate.preview_hash): b"not-an-npz"}),
    )

    with pytest.raises(SearchUnavailableError):
        service.search(owner, [pattern], query_image)


def test_feature_archive_phash_must_match_the_ready_document(
    query_image: np.ndarray,
) -> None:
    owner = uuid4()
    pattern = uuid4()
    features = extract_local_features(np.zeros((256, 256, 3), dtype=np.uint8))
    mismatched_phash = (
        "f" * 16 if features.phash != "f" * 16 else "0" * 16
    )
    candidate = _candidate(owner, pattern, phash=features.phash)
    repository = FakeRepository([candidate])
    service = _service(
        repository,
        FakeStorage(
            {
                (pattern, candidate.preview_hash): serialize_local_features(features),
            }
        ),
    )

    service.search(owner, [pattern], query_image)
    repository.candidates = [replace(candidate, phash=mismatched_phash)]

    with pytest.raises(SearchUnavailableError):
        service.search(owner, [pattern], query_image)


def test_search_rejects_more_than_ten_thousand_allowed_ids(
    query_image: np.ndarray,
) -> None:
    service = _service(FakeRepository([]), FakeStorage({}))

    with pytest.raises(ValueError):
        service.search(uuid4(), [uuid4() for _ in range(10_001)], query_image)


def test_search_service_closes_its_repository() -> None:
    repository = FakeRepository([])
    service = _service(repository, FakeStorage({}))

    service.close()

    assert repository.closed
