from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import cmp_to_key
from pathlib import Path
from typing import cast
from uuid import UUID

import numpy as np
import numpy.typing as npt

from .palette import srgb_to_oklab

PALETTE_SEARCH_SCORING_CONFIG_INVALID = "PALETTE_SEARCH_SCORING_CONFIG_INVALID"
PALETTE_DATA_INVALID = "PALETTE_DATA_INVALID"
PALETTE_SCORING_SCHEMA_VERSION = 1
MAX_PALETTE_SCORING_CONFIG_BYTES = 64 * 1024
PALETTE_RESULT_LIMIT = 30
MAX_QUERY_COLORS = 5
MIN_STORED_COLORS = 3
MAX_STORED_COLORS = 5

_HEX_PATTERN = re.compile(r"^#[0-9A-F]{6}$")
_CONFIG_FIELDS = {
    "schemaVersion",
    "version",
    "weights",
    "thresholds",
    "resultLimit",
}


@dataclass(frozen=True)
class StoredPaletteColor:
    display_hex: str
    oklab: tuple[float, float, float]
    coverage: float


@dataclass(frozen=True)
class PaletteCandidate:
    pattern_id: UUID
    colors: tuple[StoredPaletteColor, ...]


@dataclass(frozen=True)
class PaletteSearchItem:
    pattern_id: UUID
    distance: float


@dataclass(frozen=True)
class PaletteScoringConfig:
    version: str
    query_coverage_weight: float
    candidate_fit_weight: float
    maximum_distance: float
    tie_tolerance: float
    result_limit: int


class PaletteScoringConfigError(ValueError):
    def __init__(self, detail: str) -> None:
        self.code = PALETTE_SEARCH_SCORING_CONFIG_INVALID
        super().__init__(f"{self.code}: {detail}")


class PaletteDataError(RuntimeError):
    code = PALETTE_DATA_INVALID

    def __init__(self) -> None:
        super().__init__(self.code)


def _config_error(detail: str) -> PaletteScoringConfigError:
    return PaletteScoringConfigError(detail)


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _config_error("palette scoring config contains duplicate fields")
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
    minimum_inclusive: bool = True,
) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise _config_error(f"{label} must be numeric")
    result = float(value)
    minimum_valid = result >= minimum if minimum_inclusive else result > minimum
    if not math.isfinite(result) or not minimum_valid or result > maximum:
        raise _config_error(f"{label} is outside the supported range")
    return result


def load_palette_scoring_config(path: Path) -> PaletteScoringConfig:
    try:
        encoded = path.read_bytes()
        if not encoded or len(encoded) > MAX_PALETTE_SCORING_CONFIG_BYTES:
            raise _config_error("palette scoring config exceeds the byte limit")
        raw: object = json.loads(
            encoded.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except PaletteScoringConfigError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _config_error("palette scoring config could not be read") from error

    data = _exact_mapping(raw, _CONFIG_FIELDS, "palette scoring config")
    if data["schemaVersion"] != PALETTE_SCORING_SCHEMA_VERSION:
        raise _config_error("palette scoring schema version is unsupported")
    if data["version"] != "palette-scoring-v1":
        raise _config_error("palette scoring version is unsupported")

    weights = _exact_mapping(
        data["weights"],
        {"queryCoverage", "candidateFit"},
        "palette scoring weights",
    )
    query_coverage_weight = _number(
        weights["queryCoverage"],
        "query coverage weight",
        minimum=0.0,
        maximum=1.0,
    )
    candidate_fit_weight = _number(
        weights["candidateFit"],
        "candidate fit weight",
        minimum=0.0,
        maximum=1.0,
    )
    if not math.isclose(
        query_coverage_weight + candidate_fit_weight,
        1.0,
        rel_tol=0.0,
        abs_tol=1e-12,
    ):
        raise _config_error("palette scoring weights must sum to one")

    thresholds = _exact_mapping(
        data["thresholds"],
        {"maximumDistance", "tieTolerance"},
        "palette scoring thresholds",
    )
    maximum_distance = _number(
        thresholds["maximumDistance"],
        "maximum palette distance",
        minimum=0.0,
        maximum=2.0,
        minimum_inclusive=False,
    )
    tie_tolerance = _number(
        thresholds["tieTolerance"],
        "palette tie tolerance",
        minimum=0.0,
        maximum=maximum_distance,
        minimum_inclusive=False,
    )
    result_limit = data["resultLimit"]
    if (
        not isinstance(result_limit, int)
        or isinstance(result_limit, bool)
        or result_limit != PALETTE_RESULT_LIMIT
    ):
        raise _config_error("palette result limit is unsupported")

    return PaletteScoringConfig(
        version="palette-scoring-v1",
        query_coverage_weight=query_coverage_weight,
        candidate_fit_weight=candidate_fit_weight,
        maximum_distance=maximum_distance,
        tie_tolerance=tie_tolerance,
        result_limit=result_limit,
    )


def validate_query_colors(colors: Sequence[str]) -> tuple[str, ...]:
    values = tuple(colors)
    if (
        not 1 <= len(values) <= MAX_QUERY_COLORS
        or any(not isinstance(color, str) or _HEX_PATTERN.fullmatch(color) is None for color in values)
        or len(set(values)) != len(values)
    ):
        raise ValueError("colors must contain one to five unique uppercase HEX values")
    return values


def validate_palette_candidate(candidate: PaletteCandidate) -> PaletteCandidate:
    if not isinstance(candidate.pattern_id, UUID):
        raise PaletteDataError()
    colors = candidate.colors
    if not MIN_STORED_COLORS <= len(colors) <= MAX_STORED_COLORS:
        raise PaletteDataError()
    if len({color.display_hex for color in colors}) != len(colors):
        raise PaletteDataError()
    for color in colors:
        if (
            not isinstance(color.display_hex, str)
            or _HEX_PATTERN.fullmatch(color.display_hex) is None
            or len(color.oklab) != 3
            or not all(math.isfinite(value) for value in color.oklab)
            or not 0.0 <= color.oklab[0] <= 1.0
            or not -0.5 <= color.oklab[1] <= 0.5
            or not -0.5 <= color.oklab[2] <= 0.5
            or not math.isfinite(color.coverage)
            or not 0.0 < color.coverage <= 1.0
        ):
            raise PaletteDataError()
    if not math.isclose(
        math.fsum(color.coverage for color in colors),
        1.0,
        rel_tol=0.0,
        abs_tol=1e-5,
    ):
        raise PaletteDataError()
    return candidate


def _query_oklab(colors: Sequence[str]) -> npt.NDArray[np.float64]:
    rgb = np.asarray(
        [
            [int(color[index : index + 2], 16) for index in (1, 3, 5)]
            for color in colors
        ],
        dtype=np.uint8,
    )
    return np.ascontiguousarray(srgb_to_oklab(rgb), dtype=np.float64)


def rank_palettes(
    query_colors: Sequence[str],
    candidates: Sequence[PaletteCandidate],
    config: PaletteScoringConfig,
) -> tuple[PaletteSearchItem, ...]:
    colors = validate_query_colors(query_colors)
    query = _query_oklab(colors)
    ranked: list[PaletteSearchItem] = []
    for candidate in candidates:
        validated = validate_palette_candidate(candidate)
        candidate_oklab = np.asarray(
            [color.oklab for color in validated.colors],
            dtype=np.float64,
        )
        pairwise = np.linalg.norm(
            query[:, np.newaxis, :] - candidate_oklab[np.newaxis, :, :],
            axis=2,
        )
        query_coverage = float(np.min(pairwise, axis=1).mean())
        candidate_fit = float(
            np.average(
                np.min(pairwise, axis=0),
                weights=[color.coverage for color in validated.colors],
            )
        )
        distance = (
            config.query_coverage_weight * query_coverage
            + config.candidate_fit_weight * candidate_fit
        )
        if not math.isfinite(distance):
            raise PaletteDataError()
        if distance <= config.maximum_distance:
            ranked.append(
                PaletteSearchItem(
                    pattern_id=validated.pattern_id,
                    distance=distance,
                )
            )

    def compare(left: PaletteSearchItem, right: PaletteSearchItem) -> int:
        if abs(left.distance - right.distance) <= config.tie_tolerance:
            return (str(left.pattern_id) > str(right.pattern_id)) - (
                str(left.pattern_id) < str(right.pattern_id)
            )
        return -1 if left.distance < right.distance else 1

    ranked.sort(key=cmp_to_key(compare))
    return tuple(ranked[: config.result_limit])
