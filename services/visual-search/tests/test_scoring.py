from __future__ import annotations

import copy
import json
import math
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from melon_visual_search.scoring import (
    IMAGE_SEARCH_SCORING_CONFIG_INVALID,
    MatchEvidence,
    ScoringConfigError,
    classify,
    load_scoring_config,
)

SERVICE_ROOT = Path(__file__).parents[1]
SCORING_CONFIG_PATH = SERVICE_ROOT / "config" / "scoring-v1.json"


def config_data() -> dict[str, Any]:
    return json.loads(SCORING_CONFIG_PATH.read_text(encoding="utf-8"))


def write_config(
    tmp_path: Path,
    mutate: Callable[[dict[str, Any]], None],
) -> Path:
    data = copy.deepcopy(config_data())
    mutate(data)
    path = tmp_path / "scoring.json"
    path.write_text(json.dumps(data, allow_nan=True), encoding="utf-8")
    return path


def test_embedding_alone_never_claims_source() -> None:
    result = classify(MatchEvidence(best_visual=0.99, global_visual=0.98))

    assert result is not None
    assert result.kind == "visually_similar"
    assert result.category_rank == 1
    assert 0.0 <= result.score <= 1.0


def test_no_result_is_returned_below_minimum_visual_similarity() -> None:
    config = load_scoring_config(SCORING_CONFIG_PATH)
    evidence = MatchEvidence(
        best_visual=math.nextafter(config.minimum_visual_similarity, 0.0),
        global_visual=1.0,
        phash_distance=0,
        inliers=256,
        inlier_ratio=1.0,
        coverage=1.0,
    )

    assert classify(evidence, config) is None


def test_probable_source_accepts_strong_phash_at_inclusive_boundary() -> None:
    config = load_scoring_config(SCORING_CONFIG_PATH)

    result = classify(
        MatchEvidence(
            best_visual=config.minimum_visual_similarity,
            phash_distance=config.probable_phash_distance,
        ),
        config,
    )

    assert result is not None
    assert result.kind == "probable_source"
    assert result.category_rank == 3


def test_probable_source_geometry_requires_every_gate() -> None:
    config = load_scoring_config(SCORING_CONFIG_PATH)
    passing = MatchEvidence(
        best_visual=0.9,
        inliers=config.probable_geometry.minimum_inliers,
        inlier_ratio=config.probable_geometry.minimum_inlier_ratio,
        coverage=config.probable_geometry.minimum_coverage,
    )

    result = classify(passing, config)

    assert result is not None
    assert result.kind == "probable_source"

    failures = [
        MatchEvidence(
            best_visual=0.9,
            inliers=config.probable_geometry.minimum_inliers - 1,
            inlier_ratio=passing.inlier_ratio,
            coverage=passing.coverage,
        ),
        MatchEvidence(
            best_visual=0.9,
            inliers=passing.inliers,
            inlier_ratio=math.nextafter(passing.inlier_ratio, 0.0),
            coverage=passing.coverage,
        ),
        MatchEvidence(
            best_visual=0.9,
            inliers=passing.inliers,
            inlier_ratio=passing.inlier_ratio,
            coverage=math.nextafter(passing.coverage, 0.0),
        ),
    ]
    for evidence in failures:
        failed_result = classify(evidence, config)
        assert failed_result is not None
        assert failed_result.kind != "probable_source"


@pytest.mark.parametrize(
    "evidence",
    [
        MatchEvidence(best_visual=0.8, phash_distance=12),
        MatchEvidence(
            best_visual=0.8,
            inliers=8,
            inlier_ratio=0.25,
            coverage=0.04,
        ),
    ],
)
def test_possible_source_requires_weaker_but_valid_evidence(
    evidence: MatchEvidence,
) -> None:
    result = classify(evidence)

    assert result is not None
    assert result.kind == "possible_source"
    assert result.category_rank == 2


def test_weak_unverified_evidence_remains_visually_similar() -> None:
    result = classify(
        MatchEvidence(
            best_visual=0.8,
            phash_distance=13,
            inliers=7,
            inlier_ratio=1.0,
            coverage=1.0,
        )
    )

    assert result is not None
    assert result.kind == "visually_similar"


def test_score_is_deterministic_bounded_and_order_ready() -> None:
    evidence = MatchEvidence(
        best_visual=0.93,
        global_visual=0.82,
        phash_distance=5,
        inliers=31,
        inlier_ratio=0.71,
        coverage=0.34,
    )

    first = classify(evidence)
    second = classify(evidence)

    assert first == second
    assert first is not None
    assert 0.0 <= first.score <= 1.0
    assert first.ordering_key == (-3, -first.score)


def test_committed_scoring_config_is_explicit_and_versioned() -> None:
    raw = config_data()
    config = load_scoring_config(SCORING_CONFIG_PATH)

    assert raw["schemaVersion"] == 1
    assert raw["version"] == "scoring-v1"
    assert set(raw) == {
        "schemaVersion",
        "version",
        "thresholds",
        "weights",
        "categoryOrder",
    }
    assert config.version == "scoring-v1"
    assert config.probable_phash_distance < config.possible_phash_distance
    assert config.probable_geometry.minimum_inliers > (
        config.possible_geometry.minimum_inliers
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda data: data.update({"unknown": True}),
        lambda data: data["weights"].pop("globalVisual"),
        lambda data: data["thresholds"].update(
            {"minimumVisualSimilarity": float("nan")}
        ),
        lambda data: data["thresholds"].update(
            {"minimumVisualSimilarity": 1.1}
        ),
        lambda data: data["weights"].update({"bestVisual": 0.99}),
        lambda data: data["thresholds"].update(
            {
                "probablePhashDistance": data["thresholds"][
                    "possiblePhashDistance"
                ]
                + 1
            }
        ),
        lambda data: data["thresholds"]["probableGeometry"].update(
            {
                "minimumCoverage": data["thresholds"]["possibleGeometry"][
                    "minimumCoverage"
                ]
                - 0.01
            }
        ),
        lambda data: data["categoryOrder"].update({"probable_source": 1}),
    ],
    ids=[
        "unknown-field",
        "missing-field",
        "nonfinite",
        "range",
        "weights-not-normalized",
        "phash-ordering",
        "geometry-ordering",
        "category-ordering",
    ],
)
def test_scoring_config_schema_is_strict(
    tmp_path: Path,
    mutation: Callable[[dict[str, Any]], None],
) -> None:
    path = write_config(tmp_path, mutation)

    with pytest.raises(ScoringConfigError) as captured:
        load_scoring_config(path)

    assert captured.value.code == IMAGE_SEARCH_SCORING_CONFIG_INVALID


@pytest.mark.parametrize(
    "evidence",
    [
        MatchEvidence(best_visual=float("nan")),
        MatchEvidence(best_visual=1.1),
        MatchEvidence(best_visual=0.8, phash_distance=65),
        MatchEvidence(best_visual=0.8, inliers=-1),
        MatchEvidence(best_visual=0.8, inlier_ratio=1.1),
        MatchEvidence(best_visual=0.8, coverage=-0.1),
    ],
)
def test_classify_rejects_invalid_evidence(evidence: MatchEvidence) -> None:
    with pytest.raises(ValueError, match="evidence"):
        classify(evidence)
