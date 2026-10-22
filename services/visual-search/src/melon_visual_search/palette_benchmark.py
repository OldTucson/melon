from __future__ import annotations

import json
import math
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import numpy as np
import numpy.typing as npt

from .palette import srgb_to_oklab
from .palette_search import (
    MAX_STORED_COLORS,
    MIN_STORED_COLORS,
    PaletteCandidate,
    StoredPaletteColor,
    load_palette_scoring_config,
    rank_palettes,
    validate_palette_candidate,
)

MAX_PALETTE_BENCHMARK_CANDIDATES = 10_000
PALETTE_SCORING_CONFIG_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "palette-scoring-v1.json"
)


class PaletteBenchmarkError(RuntimeError):
    def __init__(self, code: str = "PALETTE_BENCHMARK_FAILED") -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class PaletteBenchmarkReport:
    count: int
    colors_per_candidate: int
    warmups: int
    iterations: int
    seed: int
    query_color_counts: tuple[int, ...]
    milliseconds: tuple[float, ...]
    p50_milliseconds: float
    p95_milliseconds: float

    def to_dict(self) -> dict[str, object]:
        return {
            "colorsPerCandidate": self.colors_per_candidate,
            "count": self.count,
            "individualMilliseconds": list(self.milliseconds),
            "iterations": self.iterations,
            "p50Milliseconds": self.p50_milliseconds,
            "p95Milliseconds": self.p95_milliseconds,
            "queryColorCounts": list(self.query_color_counts),
            "seed": self.seed,
            "warmups": self.warmups,
        }


def _invalid() -> PaletteBenchmarkError:
    return PaletteBenchmarkError("PALETTE_BENCHMARK_INVALID")


def _validate_workload(
    *,
    count: int,
    colors_per_candidate: int,
    warmups: int | None = None,
    iterations: int | None = None,
    seed: int,
) -> None:
    integer_values = (count, colors_per_candidate, seed)
    if any(
        not isinstance(value, int) or isinstance(value, bool)
        for value in integer_values
    ):
        raise _invalid()
    if not 1 <= count <= MAX_PALETTE_BENCHMARK_CANDIDATES:
        raise _invalid()
    if not MIN_STORED_COLORS <= colors_per_candidate <= MAX_STORED_COLORS:
        raise _invalid()
    if warmups is not None and (
        not isinstance(warmups, int) or isinstance(warmups, bool) or warmups < 0
    ):
        raise _invalid()
    if iterations is not None and (
        not isinstance(iterations, int)
        or isinstance(iterations, bool)
        or iterations < 1
    ):
        raise _invalid()


def _unique_rgb(
    generator: np.random.Generator,
    *,
    count: int,
    colors_per_candidate: int,
) -> npt.NDArray[np.uint8]:
    rgb = generator.integers(
        0,
        256,
        size=(count, colors_per_candidate, 3),
        dtype=np.uint8,
    )
    for candidate_index in range(count):
        seen: set[tuple[int, int, int]] = set()
        for color_index in range(colors_per_candidate):
            red, green, blue = rgb[candidate_index, color_index]
            value = (int(red), int(green), int(blue))
            while value in seen:
                replacement = generator.integers(0, 256, size=3, dtype=np.uint8)
                rgb[candidate_index, color_index] = replacement
                red, green, blue = replacement
                value = (int(red), int(green), int(blue))
            seen.add(value)
    return rgb


def generate_palette_candidates(
    *,
    count: int,
    colors_per_candidate: int,
    seed: int,
) -> tuple[PaletteCandidate, ...]:
    _validate_workload(
        count=count,
        colors_per_candidate=colors_per_candidate,
        seed=seed,
    )
    generator = np.random.default_rng(seed)
    rgb = _unique_rgb(
        generator,
        count=count,
        colors_per_candidate=colors_per_candidate,
    )
    oklab = srgb_to_oklab(rgb)
    raw_coverage = generator.random((count, colors_per_candidate)) + 0.01
    coverage = raw_coverage / raw_coverage.sum(axis=1, keepdims=True)

    candidates: list[PaletteCandidate] = []
    for candidate_index in range(count):
        colors = tuple(
            StoredPaletteColor(
                display_hex="#"
                + "".join(
                    f"{int(channel):02X}"
                    for channel in rgb[candidate_index, color_index]
                ),
                oklab=(
                    float(oklab[candidate_index, color_index, 0]),
                    float(oklab[candidate_index, color_index, 1]),
                    float(oklab[candidate_index, color_index, 2]),
                ),
                coverage=float(coverage[candidate_index, color_index]),
            )
            for color_index in range(colors_per_candidate)
        )
        candidate = PaletteCandidate(
            pattern_id=UUID(int=candidate_index + 1),
            colors=colors,
        )
        candidates.append(validate_palette_candidate(candidate))
    return tuple(candidates)


def _nearest_rank_percentile(values: tuple[float, ...], percentile: int) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil((percentile / 100) * len(ordered)) - 1)
    return ordered[index]


def _write_report(path: Path, report: PaletteBenchmarkReport) -> None:
    staged: Path | None = None
    try:
        handle = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        )
        staged = Path(handle.name)
        os.chmod(staged, 0o600)
        with handle:
            json.dump(report.to_dict(), handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staged, path)
    except OSError as error:
        raise PaletteBenchmarkError("PALETTE_BENCHMARK_OUTPUT_FAILED") from error
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)


def run_palette_benchmark(
    *,
    count: int,
    colors_per_candidate: int,
    warmups: int,
    iterations: int,
    seed: int,
    output_path: Path,
    scoring_config_path: Path = PALETTE_SCORING_CONFIG_PATH,
) -> PaletteBenchmarkReport:
    _validate_workload(
        count=count,
        colors_per_candidate=colors_per_candidate,
        warmups=warmups,
        iterations=iterations,
        seed=seed,
    )
    candidates = generate_palette_candidates(
        count=count,
        colors_per_candidate=colors_per_candidate,
        seed=seed,
    )
    query_palette = tuple(color.display_hex for color in candidates[0].colors)
    query_sizes = tuple(size for size in (1, 3, 5) if size <= colors_per_candidate)
    config = load_palette_scoring_config(scoring_config_path)

    for warmup_index in range(warmups):
        size = query_sizes[warmup_index % len(query_sizes)]
        rank_palettes(query_palette[:size], candidates, config)

    timings: list[float] = []
    measured_sizes: list[int] = []
    for iteration in range(iterations):
        size = query_sizes[iteration % len(query_sizes)]
        started = time.perf_counter()
        results = rank_palettes(query_palette[:size], candidates, config)
        elapsed = (time.perf_counter() - started) * 1000.0
        if (
            not math.isfinite(elapsed)
            or elapsed < 0
            or any(not math.isfinite(item.distance) for item in results)
        ):
            raise PaletteBenchmarkError("PALETTE_BENCHMARK_INVALID")
        timings.append(round(elapsed, 6))
        measured_sizes.append(size)

    milliseconds = tuple(timings)
    report = PaletteBenchmarkReport(
        count=count,
        colors_per_candidate=colors_per_candidate,
        warmups=warmups,
        iterations=iterations,
        seed=seed,
        query_color_counts=tuple(measured_sizes),
        milliseconds=milliseconds,
        p50_milliseconds=_nearest_rank_percentile(milliseconds, 50),
        p95_milliseconds=_nearest_rank_percentile(milliseconds, 95),
    )
    if any(
        not math.isfinite(value)
        for value in (
            *report.milliseconds,
            report.p50_milliseconds,
            report.p95_milliseconds,
        )
    ):
        raise PaletteBenchmarkError("PALETTE_BENCHMARK_INVALID")
    _write_report(output_path, report)
    return report
