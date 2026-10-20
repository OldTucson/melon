from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal, cast

IMAGE_SEARCH_SCORING_CONFIG_INVALID = "IMAGE_SEARCH_SCORING_CONFIG_INVALID"
SCORING_SCHEMA_VERSION = 1
MAX_SCORING_CONFIG_BYTES = 64 * 1024
MAX_EVIDENCE_INLIERS = 256

MatchKind = Literal["probable_source", "possible_source", "visually_similar"]
_CONFIG_FIELDS = {
    "schemaVersion",
    "version",
    "thresholds",
    "weights",
    "categoryOrder",
}


@dataclass(frozen=True)
class MatchEvidence:
    best_visual: float
    global_visual: float = 0.0
    phash_distance: int | None = None
    inliers: int = 0
    inlier_ratio: float = 0.0
    coverage: float = 0.0


@dataclass(frozen=True)
class GeometryThresholds:
    minimum_inliers: int
    minimum_inlier_ratio: float
    minimum_coverage: float


@dataclass(frozen=True)
class ScoringWeights:
    best_visual: float
    global_visual: float
    phash: float
    geometry: float


@dataclass(frozen=True)
class ScoringConfig:
    version: str
    minimum_visual_similarity: float
    probable_phash_distance: int
    possible_phash_distance: int
    probable_geometry: GeometryThresholds
    possible_geometry: GeometryThresholds
    weights: ScoringWeights
    category_order: Mapping[MatchKind, int]


@dataclass(frozen=True)
class ClassificationResult:
    kind: MatchKind
    score: float
    category_rank: int

    @property
    def ordering_key(self) -> tuple[int, float]:
        return (-self.category_rank, -self.score)


class ScoringConfigError(ValueError):
    def __init__(self, detail: str) -> None:
        self.code = IMAGE_SEARCH_SCORING_CONFIG_INVALID
        super().__init__(f"{self.code}: {detail}")


def _config_error(detail: str) -> ScoringConfigError:
    return ScoringConfigError(detail)


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _config_error("scoring config contains duplicate fields")
        result[key] = value
    return result


def _exact_mapping(
    value: object,
    expected: set[str],
    label: str,
) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or set(value) != expected:
        raise _config_error(f"{label} fields do not match the supported schema")
    return cast(Mapping[str, object], value)


def _number(
    value: object,
    label: str,
    *,
    minimum: float,
    maximum: float,
) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise _config_error(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise _config_error(f"{label} is outside the supported range")
    return result


def _integer(
    value: object,
    label: str,
    *,
    minimum: int,
    maximum: int,
) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not minimum <= value <= maximum
    ):
        raise _config_error(f"{label} is outside the supported range")
    return value


def _geometry_thresholds(value: object, label: str) -> GeometryThresholds:
    data = _exact_mapping(
        value,
        {"minimumInliers", "minimumInlierRatio", "minimumCoverage"},
        label,
    )
    return GeometryThresholds(
        minimum_inliers=_integer(
            data["minimumInliers"],
            f"{label} minimum inliers",
            minimum=4,
            maximum=MAX_EVIDENCE_INLIERS,
        ),
        minimum_inlier_ratio=_number(
            data["minimumInlierRatio"],
            f"{label} minimum inlier ratio",
            minimum=0.0,
            maximum=1.0,
        ),
        minimum_coverage=_number(
            data["minimumCoverage"],
            f"{label} minimum coverage",
            minimum=0.0,
            maximum=1.0,
        ),
    )


def load_scoring_config(path: Path) -> ScoringConfig:
    try:
        encoded = path.read_bytes()
        if not encoded or len(encoded) > MAX_SCORING_CONFIG_BYTES:
            raise _config_error("scoring config exceeds the byte limit")
        raw: object = json.loads(
            encoded.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except ScoringConfigError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _config_error("scoring config could not be read") from error

    data = _exact_mapping(raw, _CONFIG_FIELDS, "scoring config")
    if data["schemaVersion"] != SCORING_SCHEMA_VERSION:
        raise _config_error("scoring schema version is unsupported")
    if data["version"] != "scoring-v1":
        raise _config_error("scoring version is unsupported")

    thresholds = _exact_mapping(
        data["thresholds"],
        {
            "minimumVisualSimilarity",
            "probablePhashDistance",
            "possiblePhashDistance",
            "probableGeometry",
            "possibleGeometry",
        },
        "scoring thresholds",
    )
    minimum_visual_similarity = _number(
        thresholds["minimumVisualSimilarity"],
        "minimum visual similarity",
        minimum=0.0,
        maximum=1.0,
    )
    probable_phash_distance = _integer(
        thresholds["probablePhashDistance"],
        "probable pHash distance",
        minimum=0,
        maximum=64,
    )
    possible_phash_distance = _integer(
        thresholds["possiblePhashDistance"],
        "possible pHash distance",
        minimum=0,
        maximum=64,
    )
    probable_geometry = _geometry_thresholds(
        thresholds["probableGeometry"],
        "probable geometry",
    )
    possible_geometry = _geometry_thresholds(
        thresholds["possibleGeometry"],
        "possible geometry",
    )
    if probable_phash_distance >= possible_phash_distance:
        raise _config_error("probable pHash threshold must be stronger than possible")
    if (
        probable_geometry.minimum_inliers
        <= possible_geometry.minimum_inliers
        or probable_geometry.minimum_inlier_ratio
        <= possible_geometry.minimum_inlier_ratio
        or probable_geometry.minimum_coverage
        <= possible_geometry.minimum_coverage
    ):
        raise _config_error("probable geometry thresholds must all be stronger")

    weights_data = _exact_mapping(
        data["weights"],
        {"bestVisual", "globalVisual", "phash", "geometry"},
        "scoring weights",
    )
    weights = ScoringWeights(
        best_visual=_number(
            weights_data["bestVisual"],
            "best visual weight",
            minimum=0.0,
            maximum=1.0,
        ),
        global_visual=_number(
            weights_data["globalVisual"],
            "global visual weight",
            minimum=0.0,
            maximum=1.0,
        ),
        phash=_number(
            weights_data["phash"],
            "pHash weight",
            minimum=0.0,
            maximum=1.0,
        ),
        geometry=_number(
            weights_data["geometry"],
            "geometry weight",
            minimum=0.0,
            maximum=1.0,
        ),
    )
    if not math.isclose(
        sum(
            (
                weights.best_visual,
                weights.global_visual,
                weights.phash,
                weights.geometry,
            )
        ),
        1.0,
        rel_tol=0.0,
        abs_tol=1e-12,
    ):
        raise _config_error("scoring weights must sum to one")

    order_data = _exact_mapping(
        data["categoryOrder"],
        {"probable_source", "possible_source", "visually_similar"},
        "category order",
    )
    probable_rank = _integer(
        order_data["probable_source"],
        "probable source rank",
        minimum=1,
        maximum=100,
    )
    possible_rank = _integer(
        order_data["possible_source"],
        "possible source rank",
        minimum=1,
        maximum=100,
    )
    visual_rank = _integer(
        order_data["visually_similar"],
        "visually similar rank",
        minimum=1,
        maximum=100,
    )
    if not probable_rank > possible_rank > visual_rank:
        raise _config_error("category order must rank source evidence first")

    return ScoringConfig(
        version="scoring-v1",
        minimum_visual_similarity=minimum_visual_similarity,
        probable_phash_distance=probable_phash_distance,
        possible_phash_distance=possible_phash_distance,
        probable_geometry=probable_geometry,
        possible_geometry=possible_geometry,
        weights=weights,
        category_order={
            "probable_source": probable_rank,
            "possible_source": possible_rank,
            "visually_similar": visual_rank,
        },
    )


@lru_cache(maxsize=1)
def _default_config() -> ScoringConfig:
    service_root = Path(__file__).resolve().parents[2]
    return load_scoring_config(service_root / "config" / "scoring-v1.json")


def _valid_similarity(value: object) -> bool:
    return bool(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and -1.0 <= float(value) <= 1.0
    )


def _validate_evidence(evidence: MatchEvidence) -> None:
    valid_phash = evidence.phash_distance is None or (
        isinstance(evidence.phash_distance, int)
        and not isinstance(evidence.phash_distance, bool)
        and 0 <= evidence.phash_distance <= 64
    )
    valid_inliers = (
        isinstance(evidence.inliers, int)
        and not isinstance(evidence.inliers, bool)
        and 0 <= evidence.inliers <= MAX_EVIDENCE_INLIERS
    )
    valid_ratio = _valid_unit_interval(evidence.inlier_ratio)
    valid_coverage = _valid_unit_interval(evidence.coverage)
    if not (
        _valid_similarity(evidence.best_visual)
        and _valid_similarity(evidence.global_visual)
        and valid_phash
        and valid_inliers
        and valid_ratio
        and valid_coverage
    ):
        raise ValueError("match evidence is outside the supported range")


def _valid_unit_interval(value: object) -> bool:
    return bool(
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and 0.0 <= float(value) <= 1.0
    )


def _passes_geometry(
    evidence: MatchEvidence,
    thresholds: GeometryThresholds,
) -> bool:
    return (
        evidence.inliers >= thresholds.minimum_inliers
        and evidence.inlier_ratio >= thresholds.minimum_inlier_ratio
        and evidence.coverage >= thresholds.minimum_coverage
    )


def _bounded(value: float) -> float:
    return min(1.0, max(0.0, value))


def _score(evidence: MatchEvidence, config: ScoringConfig) -> float:
    phash_component = (
        0.0
        if evidence.phash_distance is None
        else 1.0 - (evidence.phash_distance / 64.0)
    )
    geometry_component = (
        min(
            1.0,
            evidence.inliers / config.probable_geometry.minimum_inliers,
        )
        + evidence.inlier_ratio
        + evidence.coverage
    ) / 3.0
    value = (
        config.weights.best_visual * _bounded(evidence.best_visual)
        + config.weights.global_visual * _bounded(evidence.global_visual)
        + config.weights.phash * phash_component
        + config.weights.geometry * geometry_component
    )
    return round(_bounded(value), 8)


def classify(
    evidence: MatchEvidence,
    config: ScoringConfig | None = None,
) -> ClassificationResult | None:
    _validate_evidence(evidence)
    selected_config = config or _default_config()
    if evidence.best_visual < selected_config.minimum_visual_similarity:
        return None

    probable_hash = (
        evidence.phash_distance is not None
        and evidence.phash_distance <= selected_config.probable_phash_distance
    )
    possible_hash = (
        evidence.phash_distance is not None
        and evidence.phash_distance <= selected_config.possible_phash_distance
    )
    probable_geometry = _passes_geometry(
        evidence,
        selected_config.probable_geometry,
    )
    possible_geometry = _passes_geometry(
        evidence,
        selected_config.possible_geometry,
    )
    if probable_hash or probable_geometry:
        kind: MatchKind = "probable_source"
    elif possible_hash or possible_geometry:
        kind = "possible_source"
    else:
        kind = "visually_similar"

    return ClassificationResult(
        kind=kind,
        score=_score(evidence, selected_config),
        category_rank=selected_config.category_order[kind],
    )
