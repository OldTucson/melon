from __future__ import annotations

import io
import json
from collections.abc import Sequence
from pathlib import Path
from typing import cast
from uuid import UUID

import numpy as np
import numpy.typing as npt
from PIL import Image

from melon_visual_search.benchmark import (
    BenchmarkRecord,
    compute_benchmark_metrics,
    evaluate_quality_gates,
    generate_benchmark_variants,
    run_benchmark,
)
from melon_visual_search.repository import ReadyPreview
from melon_visual_search.scoring import MatchEvidence, MatchKind, load_scoring_config
from melon_visual_search.search import SearchEvidenceItem, SearchEvidenceResult


def _gradient_image(height: int = 240, width: int = 320) -> np.ndarray:
    y, x = np.indices((height, width))
    return np.ascontiguousarray(
        np.stack(
            (
                x % 256,
                y % 256,
                (x * 3 + y * 5) % 256,
            ),
            axis=2,
        ).astype(np.uint8)
    )


def test_benchmark_variants_are_deterministic_and_retain_crop_area() -> None:
    image = _gradient_image()

    first = generate_benchmark_variants(image, seed=20261020)
    replay = generate_benchmark_variants(image, seed=20261020)
    changed = generate_benchmark_variants(image, seed=20261021)

    assert [variant.name for variant in first] == [
        "exact",
        "resize-50",
        "jpeg-q45",
        "blur-medium",
        "rotate-5",
        "crop-25-1",
        "crop-25-2",
        "crop-25-3",
    ]
    assert [variant.family for variant in first] == [
        "exact",
        "resize",
        "jpeg",
        "blur",
        "rotation",
        "crop",
        "crop",
        "crop",
    ]
    assert all(
        np.array_equal(left.image, right.image)
        for left, right in zip(first, replay, strict=True)
    )
    assert any(
        not np.array_equal(left.image, right.image)
        for left, right in zip(first[-3:], changed[-3:], strict=True)
    )
    for crop in first[-3:]:
        assert crop.retained_area >= 0.25
        assert crop.image.shape == image.shape
        assert crop.image.flags.c_contiguous


def _record(
    family: str,
    *,
    rank: int | None,
    latency_ms: float,
    negative: bool = False,
    category: str | None = None,
) -> BenchmarkRecord:
    return BenchmarkRecord(
        source_pattern_id="00000000-0000-4000-8000-000000000001",
        transform=family,
        family=family,
        negative=negative,
        rank=rank,
        matched_pattern_id=(
            "00000000-0000-4000-8000-000000000002"
            if category is not None
            else None
        ),
        category=cast(MatchKind | None, category),
        score=0.9 if category is not None else None,
        latency_ms=latency_ms,
    )


def test_metrics_compute_known_recall_false_positive_and_latency_values() -> None:
    records = (
        _record("exact", rank=1, latency_ms=10),
        _record("resize", rank=1, latency_ms=20),
        _record("jpeg", rank=2, latency_ms=30),
        _record("blur", rank=5, latency_ms=40),
        _record("crop", rank=2, latency_ms=50),
        _record("crop", rank=6, latency_ms=60),
        _record("rotation", rank=None, latency_ms=70),
        _record(
            "negative",
            rank=None,
            latency_ms=80,
            negative=True,
            category="probable_source",
        ),
        _record(
            "negative",
            rank=None,
            latency_ms=90,
            negative=True,
            category="possible_source",
        ),
    )

    metrics = compute_benchmark_metrics(
        records,
        corpus_count=2,
        reproducible=True,
    )

    assert metrics.top1_by_family == {
        "exact": 1.0,
        "resize": 1.0,
        "jpeg": 0.0,
        "blur": 0.0,
        "rotation": 0.0,
        "crop": 0.0,
    }
    assert metrics.top5_by_family["jpeg"] == 1.0
    assert metrics.top5_by_family["blur"] == 1.0
    assert metrics.top5_by_family["crop"] == 0.5
    assert metrics.false_probable_source_rate == 0.5
    assert metrics.latency_ms == {"p50": 50.0, "p95": 90.0, "p99": 90.0}
    assert metrics.reproducible is True


def test_quality_gates_report_each_approved_threshold() -> None:
    records = tuple(
        [
            _record("exact", rank=1, latency_ms=10),
            _record("resize", rank=1, latency_ms=10),
            _record("jpeg", rank=1, latency_ms=10),
            _record("blur", rank=5, latency_ms=10),
            _record("crop", rank=5, latency_ms=10),
        ]
        * 100
    ) + tuple(
        _record(
            "negative",
            rank=None,
            latency_ms=10,
            negative=True,
            category="possible_source",
        )
        for _ in range(100)
    )
    passing = compute_benchmark_metrics(
        records,
        corpus_count=100,
        reproducible=True,
    )
    assert evaluate_quality_gates(passing).passed is True

    failing = compute_benchmark_metrics(
        records,
        corpus_count=99,
        reproducible=False,
    )
    result = evaluate_quality_gates(failing)
    assert result.passed is False
    assert "corpus_count" in result.failures
    assert "reproducible" in result.failures
    assert "negative_false_probable_source" not in result.failures


def test_benchmark_module_never_uses_fixture_paths_as_report_data(
    tmp_path: Path,
) -> None:
    # This guards the report record surface: private filesystem/OSS locations
    # are deliberately not fields on the persisted record type.
    fields = set(BenchmarkRecord.__dataclass_fields__)
    assert "path" not in fields
    assert "object_key" not in fields
    assert "image" not in fields
    assert str(tmp_path) not in repr(_record("exact", rank=1, latency_ms=1))


def _uuid(value: int) -> UUID:
    return UUID(f"00000000-0000-4000-8000-{value:012x}")


def _encoded_gradient() -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(_gradient_image(192, 192)).save(buffer, format="PNG")
    return buffer.getvalue()


class _BenchmarkRepository:
    def __init__(self, previews: tuple[ReadyPreview, ...]) -> None:
        self.previews = previews
        self.calls: list[tuple[UUID, str, int, int]] = []

    def sample_ready_previews(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        count: int,
        seed: int,
    ) -> tuple[ReadyPreview, ...]:
        self.calls.append((owner_id, index_version, count, seed))
        return self.previews[:count]


class _BenchmarkStorage:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.reads: list[tuple[UUID, UUID, str]] = []

    def read_preview(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        key: str,
    ) -> bytes:
        self.reads.append((owner_id, pattern_id, key))
        return self.payload


class _BenchmarkSearch:
    def __init__(self, pattern_ids: tuple[UUID, ...], variants_per_pattern: int) -> None:
        self.pattern_ids = pattern_ids
        self.variants_per_pattern = variants_per_pattern
        self.scopes: list[tuple[UUID, ...]] = []

    def collect_evidence(
        self,
        owner_id: UUID,
        allowed_pattern_ids: Sequence[UUID],
        image: npt.NDArray[np.uint8],
        *,
        minimum_visual_similarity: float,
    ) -> SearchEvidenceResult:
        del owner_id, minimum_visual_similarity
        assert image.dtype == np.uint8
        scope = tuple(allowed_pattern_ids)
        self.scopes.append(scope)
        source_index = (len(self.scopes) - 1) // (self.variants_per_pattern * 2)
        source = self.pattern_ids[source_index]
        items: tuple[SearchEvidenceItem, ...] = ()
        if source in scope:
            items = (
                SearchEvidenceItem(
                    pattern_id=source,
                    evidence=MatchEvidence(
                        best_visual=0.95,
                        global_visual=0.94,
                        phash_distance=0,
                        inliers=30,
                        inlier_ratio=0.8,
                        coverage=0.4,
                    ),
                ),
            )
        return SearchEvidenceResult(width=image.shape[1], height=image.shape[0], items=items)


def test_real_library_runner_cleans_queries_and_writes_only_safe_metadata(
    tmp_path: Path,
) -> None:
    owner_id = _uuid(999)
    pattern_ids = tuple(_uuid(index) for index in range(1, 101))
    previews = tuple(
        ReadyPreview(
            pattern_id=pattern_id,
            object_key=(
                f"users/{owner_id}/patterns/{pattern_id}/derived/{_uuid(1000 + index)}.png"
            ),
        )
        for index, pattern_id in enumerate(pattern_ids, start=1)
    )
    repository = _BenchmarkRepository(previews)
    storage = _BenchmarkStorage(_encoded_gradient())
    search = _BenchmarkSearch(pattern_ids, variants_per_pattern=8)
    output = tmp_path / "report.json"
    scoring_output = tmp_path / "scoring-v1.json"
    temporary_parent = tmp_path / "queries"
    temporary_parent.mkdir()

    report = run_benchmark(
        repository,
        storage,
        search,
        owner_id=owner_id,
        index_version="visual-search-v1",
        model_sha256="a" * 64,
        count=100,
        seed=20261020,
        output_path=output,
        scoring_output_path=scoring_output,
        temporary_parent=temporary_parent,
    )

    assert report.quality_gates.passed is True
    assert repository.calls == [
        (owner_id, "visual-search-v1", 100, 20261020)
    ]
    assert len(storage.reads) == 100
    assert len(search.scopes) == 100 * 8 * 2
    for index, source in enumerate(pattern_ids):
        offset = index * 16
        for positive, negative in zip(
            search.scopes[offset : offset + 16 : 2],
            search.scopes[offset + 1 : offset + 16 : 2],
            strict=True,
        ):
            assert source in positive
            assert source not in negative
    assert list(temporary_parent.iterdir()) == []
    assert load_scoring_config(scoring_output) == report.calibration.selected

    payload = json.loads(output.read_text(encoding="utf-8"))
    encoded_report = output.read_text(encoding="utf-8")
    assert payload["modelSha256"] == "a" * 64
    assert payload["indexVersion"] == "visual-search-v1"
    assert payload["metrics"]["corpusCount"] == 100
    assert len(payload["records"]) == 100 * 8 * 2
    assert set(payload["records"][0]) == {
        "category",
        "family",
        "latencyMs",
        "matchedPatternId",
        "negative",
        "rank",
        "score",
        "sourcePatternId",
        "transform",
    }
    assert "users/" not in encoded_report
    assert str(temporary_parent) not in encoded_report
