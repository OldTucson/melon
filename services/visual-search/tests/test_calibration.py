from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from uuid import UUID

from melon_visual_search.calibration import (
    CalibrationCandidate,
    CalibrationQuery,
    build_calibration_grid,
    calibrate_scoring,
    deterministic_pattern_split,
)
from melon_visual_search.scoring import MatchEvidence, load_scoring_config

SERVICE_ROOT = Path(__file__).resolve().parents[1]
BASE_CONFIG_PATH = SERVICE_ROOT / "config" / "scoring-v1.json"


def _uuid(value: int) -> UUID:
    return UUID(f"00000000-0000-4000-8000-{value:012x}")


def test_deterministic_split_keeps_seventy_train_and_thirty_validation() -> None:
    patterns = [_uuid(index) for index in range(1, 101)]

    first = deterministic_pattern_split(patterns, seed=20261020)
    replay = deterministic_pattern_split(reversed(patterns), seed=20261020)
    changed = deterministic_pattern_split(patterns, seed=20261021)

    assert first == replay
    assert len(first.train) == 70
    assert len(first.validation) == 30
    assert set(first.train).isdisjoint(first.validation)
    assert set(first.train) | set(first.validation) == set(patterns)
    assert first != changed


def test_calibration_grid_is_bounded_and_keeps_probable_thresholds_stronger() -> None:
    base = load_scoring_config(BASE_CONFIG_PATH)

    grid = build_calibration_grid(base)

    assert len(grid) == 27
    assert len(
        {
            (
                config.minimum_visual_similarity,
                config.probable_phash_distance,
                config.possible_phash_distance,
                config.probable_geometry,
                config.possible_geometry,
            )
            for config in grid
        }
    ) == 27
    for config in grid:
        assert config.probable_phash_distance < config.possible_phash_distance
        assert (
            config.probable_geometry.minimum_inliers
            > config.possible_geometry.minimum_inliers
        )
        assert (
            config.probable_geometry.minimum_inlier_ratio
            > config.possible_geometry.minimum_inlier_ratio
        )
        assert (
            config.probable_geometry.minimum_coverage
            > config.possible_geometry.minimum_coverage
        )


def _calibration_queries() -> tuple[CalibrationQuery, ...]:
    queries: list[CalibrationQuery] = []
    for index in range(1, 101):
        source = _uuid(index)
        source_evidence = MatchEvidence(
            best_visual=0.92,
            global_visual=0.9,
            phash_distance=0,
            inliers=24,
            inlier_ratio=0.7,
            coverage=0.3,
        )
        for family in ("exact", "resize", "jpeg", "blur", "crop"):
            queries.append(
                CalibrationQuery(
                    source_pattern_id=source,
                    family=family,
                    candidates=(
                        CalibrationCandidate(source, source_evidence),
                    ),
                )
            )
        queries.append(
            CalibrationQuery(
                source_pattern_id=source,
                family="negative",
                negative=True,
                candidates=(
                    CalibrationCandidate(
                        _uuid(10_000 + index),
                        MatchEvidence(
                            best_visual=0.9,
                            global_visual=0.85,
                            phash_distance=7,
                        ),
                    ),
                ),
            )
        )
    return tuple(queries)


def test_calibration_rejects_false_probable_configuration_and_writes_atomically(
    tmp_path: Path,
) -> None:
    base = load_scoring_config(BASE_CONFIG_PATH)
    unsafe = replace(base, probable_phash_distance=8)
    safe = replace(base, probable_phash_distance=6)
    output = tmp_path / "scoring-v1.json"

    result = calibrate_scoring(
        _calibration_queries(),
        candidates=(unsafe, safe),
        output_path=output,
        seed=20261020,
    )

    assert result.selected == safe
    assert result.train_metrics.false_probable_source_rate == 0.0
    assert result.validation_metrics.false_probable_source_rate == 0.0
    assert result.validation_gates.passed is True
    assert load_scoring_config(output) == safe
    assert list(tmp_path.glob(".scoring-v1.json.*.tmp")) == []


def test_failed_validation_does_not_replace_the_locked_config(
    tmp_path: Path,
) -> None:
    base = load_scoring_config(BASE_CONFIG_PATH)
    output = tmp_path / "scoring-v1.json"
    output.write_text("locked", encoding="utf-8")
    failing = tuple(
        CalibrationQuery(
            source_pattern_id=_uuid(index),
            family="crop",
            candidates=(),
        )
        for index in range(1, 101)
    )

    try:
        calibrate_scoring(
            failing,
            candidates=(base,),
            output_path=output,
            seed=20261020,
        )
    except RuntimeError as error:
        assert str(error) == "IMAGE_SEARCH_CALIBRATION_GATE_FAILED"
    else:
        raise AssertionError("calibration should reject a failed validation split")

    assert output.read_text(encoding="utf-8") == "locked"
    assert list(tmp_path.glob(".scoring-v1.json.*.tmp")) == []
