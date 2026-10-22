from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import numpy as np
import pytest

from melon_visual_search.palette import srgb_to_oklab
from melon_visual_search.palette_search import (
    PaletteCandidate,
    PaletteScoringConfig,
    PaletteScoringConfigError,
    StoredPaletteColor,
    load_palette_scoring_config,
    rank_palettes,
)

EXACT_ID = UUID("00000000-0000-0000-0000-000000000001")
NEAR_ID = UUID("00000000-0000-0000-0000-000000000002")
MISSING_ID = UUID("00000000-0000-0000-0000-000000000003")
UNRELATED_ID = UUID("00000000-0000-0000-0000-000000000004")


def _oklab(display_hex: str) -> tuple[float, float, float]:
    rgb = np.array(
        [[int(display_hex[index : index + 2], 16) for index in (1, 3, 5)]],
        dtype=np.uint8,
    )
    converted = srgb_to_oklab(rgb)[0]
    return (float(converted[0]), float(converted[1]), float(converted[2]))


def _color(
    display_hex: str,
    coverage: float,
    *,
    shift: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> StoredPaletteColor:
    value = _oklab(display_hex)
    return StoredPaletteColor(
        display_hex=display_hex,
        oklab=tuple(
            component + offset
            for component, offset in zip(value, shift, strict=True)
        ),
        coverage=coverage,
    )


def _candidate(
    pattern_id: UUID,
    colors: tuple[StoredPaletteColor, ...],
) -> PaletteCandidate:
    return PaletteCandidate(pattern_id=pattern_id, colors=colors)


@pytest.fixture
def config() -> PaletteScoringConfig:
    return PaletteScoringConfig(
        version="palette-scoring-v1",
        query_coverage_weight=0.8,
        candidate_fit_weight=0.2,
        maximum_distance=0.24,
        tie_tolerance=1e-9,
        result_limit=30,
    )


def test_palette_ranking_orders_exact_near_and_missing_colors(
    config: PaletteScoringConfig,
) -> None:
    query = ("#FF0000", "#00FF00", "#0000FF")
    exact = _candidate(
        EXACT_ID,
        tuple(_color(color, 1 / 3) for color in query),
    )
    near = _candidate(
        NEAR_ID,
        tuple(_color(color, 1 / 3, shift=(0.01, 0.0, 0.0)) for color in query),
    )
    missing = _candidate(
        MISSING_ID,
        (
            _color("#FF0000", 1 / 3),
            _color("#00FF00", 1 / 3),
            _color("#000000", 1 / 3),
        ),
    )
    unrelated = _candidate(
        UNRELATED_ID,
        (
            _color("#000000", 1 / 3),
            _color("#808080", 1 / 3),
            _color("#FFFFFF", 1 / 3),
        ),
    )

    ranked = rank_palettes(query, (unrelated, missing, near, exact), config)

    assert [item.pattern_id for item in ranked] == [EXACT_ID, NEAR_ID, MISSING_ID]
    assert ranked[0].distance == pytest.approx(0.0, abs=1e-12)
    assert rank_palettes(query, (unrelated,), config) == ()


def test_candidate_coverage_affects_only_candidate_fit_term(
    config: PaletteScoringConfig,
) -> None:
    query = ("#FF0000",)
    heavy_match = _candidate(
        EXACT_ID,
        (
            _color("#FF0000", 0.8),
            _color("#808080", 0.1),
            _color("#0000FF", 0.1),
        ),
    )
    light_match = _candidate(
        NEAR_ID,
        (
            _color("#FF0000", 0.2),
            _color("#808080", 0.4),
            _color("#0000FF", 0.4),
        ),
    )

    ranked = rank_palettes(
        query,
        (light_match, heavy_match),
        replace(config, maximum_distance=1.0),
    )

    query_oklab = np.asarray([_oklab(query[0])], dtype=np.float64)
    candidate_oklab = np.asarray(
        [color.oklab for color in heavy_match.colors],
        dtype=np.float64,
    )
    nearest = np.linalg.norm(candidate_oklab - query_oklab, axis=1)
    expected = config.candidate_fit_weight * np.average(
        nearest,
        weights=[color.coverage for color in heavy_match.colors],
    )
    assert [item.pattern_id for item in ranked] == [EXACT_ID, NEAR_ID]
    assert ranked[0].distance == pytest.approx(expected)


def test_palette_ranking_uses_uuid_for_ties_and_applies_threshold(
    config: PaletteScoringConfig,
) -> None:
    query = ("#FF0000", "#00FF00", "#0000FF")
    colors = tuple(
        _color(color, 1 / 3, shift=(0.02, 0.0, 0.0)) for color in query
    )
    later = _candidate(NEAR_ID, colors)
    earlier = _candidate(EXACT_ID, colors)

    tied = rank_palettes(
        query,
        (later, earlier),
        replace(config, maximum_distance=1.0),
    )
    filtered = rank_palettes(
        query,
        (earlier,),
        replace(config, maximum_distance=0.01),
    )

    assert [item.pattern_id for item in tied] == [EXACT_ID, NEAR_ID]
    assert filtered == ()


def test_checked_in_palette_scoring_config_loads() -> None:
    path = Path(__file__).parents[1] / "config" / "palette-scoring-v1.json"

    loaded = load_palette_scoring_config(path)

    assert loaded == PaletteScoringConfig(
        version="palette-scoring-v1",
        query_coverage_weight=0.8,
        candidate_fit_weight=0.2,
        maximum_distance=0.24,
        tie_tolerance=1e-9,
        result_limit=30,
    )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda data: data.update({"unknown": True}),
        lambda data: data["weights"].update({"queryCoverage": float("nan")}),
        lambda data: data.update(
            {"weights": {"queryCoverage": 0.7, "candidateFit": 0.2}}
        ),
        lambda data: data["thresholds"].update({"maximumDistance": 0.0}),
        lambda data: data["thresholds"].update({"tieTolerance": -1.0}),
        lambda data: data.update({"resultLimit": 29}),
    ],
    ids=[
        "unknown-field",
        "nonfinite-weight",
        "weights-not-one",
        "nonpositive-distance",
        "negative-tolerance",
        "unsupported-limit",
    ],
)
def test_palette_scoring_config_rejects_invalid_contract(
    tmp_path: Path,
    mutation: object,
) -> None:
    data = {
        "schemaVersion": 1,
        "version": "palette-scoring-v1",
        "weights": {"queryCoverage": 0.8, "candidateFit": 0.2},
        "thresholds": {"maximumDistance": 0.24, "tieTolerance": 1e-9},
        "resultLimit": 30,
    }
    assert callable(mutation)
    mutation(data)
    path = tmp_path / "palette.json"
    path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(PaletteScoringConfigError) as caught:
        load_palette_scoring_config(path)

    assert caught.value.code == "PALETTE_SEARCH_SCORING_CONFIG_INVALID"
