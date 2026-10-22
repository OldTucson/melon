from __future__ import annotations

import json
import math
from pathlib import Path
from uuid import UUID

import pytest

from melon_visual_search import palette_benchmark
from melon_visual_search.cli import build_parser, main
from melon_visual_search.palette_benchmark import (
    PaletteBenchmarkError,
    generate_palette_candidates,
    run_palette_benchmark,
)
from melon_visual_search.palette_search import (
    PaletteSearchItem,
    validate_palette_candidate,
)


def test_palette_candidates_are_deterministic_valid_and_seeded() -> None:
    first = generate_palette_candidates(
        count=12,
        colors_per_candidate=5,
        seed=20261022,
    )
    replay = generate_palette_candidates(
        count=12,
        colors_per_candidate=5,
        seed=20261022,
    )
    changed = generate_palette_candidates(
        count=12,
        colors_per_candidate=5,
        seed=20261023,
    )

    assert first == replay
    assert first != changed
    assert len(first) == 12
    assert all(len(candidate.colors) == 5 for candidate in first)
    assert all(
        validate_palette_candidate(candidate) == candidate for candidate in first
    )


def test_palette_benchmark_writes_complete_finite_timing_report(
    tmp_path: Path,
) -> None:
    output = tmp_path / "palette-benchmark.json"

    report = run_palette_benchmark(
        count=24,
        colors_per_candidate=5,
        warmups=2,
        iterations=6,
        seed=20261022,
        output_path=output,
    )

    assert report.count == 24
    assert report.colors_per_candidate == 5
    assert report.warmups == 2
    assert report.iterations == 6
    assert report.query_color_counts == (1, 3, 5, 1, 3, 5)
    assert len(report.milliseconds) == 6
    assert all(math.isfinite(value) and value >= 0 for value in report.milliseconds)
    assert math.isfinite(report.p50_milliseconds)
    assert math.isfinite(report.p95_milliseconds)

    payload = json.loads(output.read_text(encoding="utf-8"))
    assert set(payload) == {
        "colorsPerCandidate",
        "count",
        "individualMilliseconds",
        "iterations",
        "p50Milliseconds",
        "p95Milliseconds",
        "queryColorCounts",
        "seed",
        "warmups",
    }
    assert payload["queryColorCounts"] == [1, 3, 5, 1, 3, 5]
    assert len(payload["individualMilliseconds"]) == 6
    assert "#" not in output.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("count", "colors_per_candidate", "warmups", "iterations"),
    [
        (0, 5, 5, 30),
        (10_001, 5, 5, 30),
        (100, 2, 5, 30),
        (100, 6, 5, 30),
        (100, 5, -1, 30),
        (100, 5, 5, 0),
    ],
)
def test_palette_benchmark_rejects_unsupported_workloads(
    tmp_path: Path,
    count: int,
    colors_per_candidate: int,
    warmups: int,
    iterations: int,
) -> None:
    with pytest.raises(PaletteBenchmarkError) as caught:
        run_palette_benchmark(
            count=count,
            colors_per_candidate=colors_per_candidate,
            warmups=warmups,
            iterations=iterations,
            seed=20261022,
            output_path=tmp_path / "report.json",
        )

    assert caught.value.code == "PALETTE_BENCHMARK_INVALID"


def test_palette_benchmark_wraps_output_failures(tmp_path: Path) -> None:
    with pytest.raises(PaletteBenchmarkError) as caught:
        run_palette_benchmark(
            count=4,
            colors_per_candidate=3,
            warmups=0,
            iterations=1,
            seed=20261022,
            output_path=tmp_path / "missing" / "report.json",
        )

    assert caught.value.code == "PALETTE_BENCHMARK_OUTPUT_FAILED"


def test_palette_benchmark_rejects_nonfinite_results(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        palette_benchmark,
        "rank_palettes",
        lambda *_args: (
            PaletteSearchItem(pattern_id=UUID(int=1), distance=float("nan")),
        ),
    )

    with pytest.raises(PaletteBenchmarkError) as caught:
        run_palette_benchmark(
            count=4,
            colors_per_candidate=3,
            warmups=0,
            iterations=1,
            seed=20261022,
            output_path=tmp_path / "report.json",
        )

    assert caught.value.code == "PALETTE_BENCHMARK_INVALID"
    assert not (tmp_path / "report.json").exists()


def test_cli_exposes_the_palette_benchmark_workload() -> None:
    args = build_parser().parse_args(
        [
            "palette-benchmark",
            "--count",
            "10000",
            "--iterations",
            "30",
            "--seed",
            "20261022",
            "--output",
            "/tmp/palette-benchmark.json",
        ]
    )

    assert args.command == "palette-benchmark"
    assert args.count == 10_000
    assert args.colors_per_candidate == 5
    assert args.warmups == 5
    assert args.iterations == 30
    assert args.seed == 20261022
    assert args.output == Path("/tmp/palette-benchmark.json")


def test_cli_returns_nonzero_for_oversized_palette_workload(
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    result = main(
        [
            "palette-benchmark",
            "--count",
            "10001",
            "--output",
            str(tmp_path / "report.json"),
        ]
    )

    assert result == 2
    assert capsys.readouterr().err.strip() == "PALETTE_BENCHMARK_INVALID"
