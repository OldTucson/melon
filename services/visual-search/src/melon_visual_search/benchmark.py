from __future__ import annotations

import io
import json
import math
import os
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol
from uuid import UUID

import numpy as np
import numpy.typing as npt
from PIL import Image, ImageFilter

from .image_io import decode_image
from .repository import ReadyPreview
from .scoring import MatchKind, load_scoring_config
from .search import SearchEvidenceResult

if TYPE_CHECKING:
    from .calibration import CalibrationCandidate, CalibrationQuery, CalibrationResult

BENCHMARK_PATTERN_COUNT = 100
SCORING_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "scoring-v1.json"

TransformFamily = Literal[
    "exact",
    "resize",
    "jpeg",
    "blur",
    "rotation",
    "crop",
]

BENCHMARK_FAMILIES: tuple[TransformFamily, ...] = (
    "exact",
    "resize",
    "jpeg",
    "blur",
    "rotation",
    "crop",
)


@dataclass(frozen=True)
class BenchmarkVariant:
    name: str
    family: TransformFamily
    image: npt.NDArray[np.uint8]
    retained_area: float = 1.0


@dataclass(frozen=True)
class BenchmarkRecord:
    source_pattern_id: str
    transform: str
    family: str
    negative: bool
    rank: int | None
    matched_pattern_id: str | None
    category: MatchKind | None
    score: float | None
    latency_ms: float


@dataclass(frozen=True)
class BenchmarkMetrics:
    corpus_count: int
    record_count: int
    negative_count: int
    samples_by_family: dict[str, int]
    top1_by_family: dict[str, float]
    top5_by_family: dict[str, float]
    false_probable_source_rate: float
    latency_ms: dict[str, float]
    reproducible: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "corpusCount": self.corpus_count,
            "recordCount": self.record_count,
            "negativeCount": self.negative_count,
            "samplesByFamily": self.samples_by_family,
            "top1ByFamily": self.top1_by_family,
            "top5ByFamily": self.top5_by_family,
            "falseProbableSourceRate": self.false_probable_source_rate,
            "latencyMs": self.latency_ms,
            "reproducible": self.reproducible,
        }


@dataclass(frozen=True)
class QualityGateResult:
    passed: bool
    failures: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {"passed": self.passed, "failures": list(self.failures)}


@dataclass(frozen=True)
class BenchmarkReport:
    owner_id: UUID
    index_version: str
    model_sha256: str
    count: int
    seed: int
    records: tuple[BenchmarkRecord, ...]
    metrics: BenchmarkMetrics
    quality_gates: QualityGateResult
    calibration: CalibrationResult

    def to_dict(self) -> dict[str, object]:
        from .calibration import scoring_config_payload

        return {
            "schemaVersion": 1,
            "ownerId": str(self.owner_id),
            "indexVersion": self.index_version,
            "modelSha256": self.model_sha256,
            "count": self.count,
            "seed": self.seed,
            "records": [_record_payload(record) for record in self.records],
            "metrics": self.metrics.to_dict(),
            "qualityGates": self.quality_gates.to_dict(),
            "calibration": {
                "selected": scoring_config_payload(self.calibration.selected),
                "trainMetrics": self.calibration.train_metrics.to_dict(),
                "validationMetrics": self.calibration.validation_metrics.to_dict(),
                "validationGates": self.calibration.validation_gates.to_dict(),
            },
        }


class BenchmarkError(RuntimeError):
    code = "IMAGE_SEARCH_BENCHMARK_FAILED"

    def __init__(self) -> None:
        super().__init__(self.code)


class BenchmarkCorpusError(BenchmarkError):
    code = "IMAGE_SEARCH_BENCHMARK_CORPUS_INVALID"


class BenchmarkGateError(BenchmarkError):
    code = "IMAGE_SEARCH_BENCHMARK_GATE_FAILED"

    def __init__(self, report: BenchmarkReport) -> None:
        self.report = report
        super().__init__()


class BenchmarkRepository(Protocol):
    def sample_ready_previews(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        count: int,
        seed: int,
    ) -> tuple[ReadyPreview, ...]: ...


class BenchmarkStorage(Protocol):
    def read_preview(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        key: str,
    ) -> bytes: ...


class BenchmarkSearch(Protocol):
    def collect_evidence(
        self,
        owner_id: UUID,
        allowed_pattern_ids: Sequence[UUID],
        image: npt.NDArray[np.uint8],
        *,
        minimum_visual_similarity: float,
    ) -> SearchEvidenceResult: ...


@dataclass(frozen=True)
class _CapturedQuery:
    transform: str
    latency_ms: float
    query: CalibrationQuery


def _validated_image(image: object) -> npt.NDArray[np.uint8]:
    if (
        not isinstance(image, np.ndarray)
        or image.dtype != np.uint8
        or image.ndim != 3
        or image.shape[2] != 3
        or image.shape[0] <= 0
        or image.shape[1] <= 0
    ):
        raise ValueError("benchmark image must be a non-empty HxWx3 uint8 RGB array")
    return np.ascontiguousarray(image)


def _array(image: Image.Image) -> npt.NDArray[np.uint8]:
    return np.ascontiguousarray(np.asarray(image.convert("RGB"), dtype=np.uint8))


def generate_benchmark_variants(
    image: npt.NDArray[np.uint8],
    *,
    seed: int,
) -> tuple[BenchmarkVariant, ...]:
    source = _validated_image(image)
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("benchmark seed must be an integer")

    height, width = source.shape[:2]
    pil = Image.fromarray(source, mode="RGB")
    resized = pil.resize(
        (max(1, round(width * 0.5)), max(1, round(height * 0.5))),
        Image.Resampling.LANCZOS,
    )

    jpeg_buffer = io.BytesIO()
    pil.save(jpeg_buffer, format="JPEG", quality=45, optimize=False, progressive=False)
    jpeg_buffer.seek(0)
    with Image.open(jpeg_buffer) as compressed:
        jpeg = _array(compressed)

    blurred = pil.filter(ImageFilter.GaussianBlur(radius=2.0))
    fill = tuple(int(value) for value in source.reshape(-1, 3).mean(axis=0))
    rotated = pil.rotate(
        5.0,
        resample=Image.Resampling.BICUBIC,
        expand=False,
        fillcolor=fill,
    )

    variants: list[BenchmarkVariant] = [
        BenchmarkVariant("exact", "exact", source.copy()),
        BenchmarkVariant("resize-50", "resize", _array(resized)),
        BenchmarkVariant("jpeg-q45", "jpeg", jpeg),
        BenchmarkVariant("blur-medium", "blur", _array(blurred)),
        BenchmarkVariant("rotate-5", "rotation", _array(rotated)),
    ]

    crop_height = max(1, math.ceil(height * 0.5))
    crop_width = max(1, math.ceil(width * 0.5))
    retained_area = (crop_height * crop_width) / (height * width)
    generator = np.random.default_rng(seed)
    for index in range(1, 4):
        top = int(generator.integers(0, height - crop_height + 1))
        left = int(generator.integers(0, width - crop_width + 1))
        crop = pil.crop((left, top, left + crop_width, top + crop_height))
        expanded = crop.resize((width, height), Image.Resampling.LANCZOS)
        variants.append(
            BenchmarkVariant(
                name=f"crop-25-{index}",
                family="crop",
                image=_array(expanded),
                retained_area=retained_area,
            )
        )

    return tuple(variants)


def _rate(records: tuple[BenchmarkRecord, ...], maximum_rank: int) -> float:
    if not records:
        return 0.0
    hits = sum(
        record.rank is not None and record.rank <= maximum_rank for record in records
    )
    return hits / len(records)


def _nearest_rank_percentile(values: list[float], percentile: int) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil((percentile / 100) * len(ordered)) - 1)
    return round(ordered[index], 3)


def compute_benchmark_metrics(
    records: tuple[BenchmarkRecord, ...],
    *,
    corpus_count: int,
    reproducible: bool,
) -> BenchmarkMetrics:
    if corpus_count < 0:
        raise ValueError("benchmark corpus count must not be negative")
    if any(
        not math.isfinite(record.latency_ms) or record.latency_ms < 0
        for record in records
    ):
        raise ValueError("benchmark latency must be finite and non-negative")

    positive_by_family = {
        family: tuple(
            record
            for record in records
            if not record.negative and record.family == family
        )
        for family in BENCHMARK_FAMILIES
    }
    negatives = tuple(record for record in records if record.negative)
    false_probable = sum(
        record.category == "probable_source" for record in negatives
    )
    latencies = [record.latency_ms for record in records]

    return BenchmarkMetrics(
        corpus_count=corpus_count,
        record_count=len(records),
        negative_count=len(negatives),
        samples_by_family={
            family: len(family_records)
            for family, family_records in positive_by_family.items()
        },
        top1_by_family={
            family: _rate(family_records, 1)
            for family, family_records in positive_by_family.items()
        },
        top5_by_family={
            family: _rate(family_records, 5)
            for family, family_records in positive_by_family.items()
        },
        false_probable_source_rate=(
            false_probable / len(negatives) if negatives else 0.0
        ),
        latency_ms={
            "p50": _nearest_rank_percentile(latencies, 50),
            "p95": _nearest_rank_percentile(latencies, 95),
            "p99": _nearest_rank_percentile(latencies, 99),
        },
        reproducible=reproducible,
    )


def evaluate_quality_gates(
    metrics: BenchmarkMetrics,
    *,
    minimum_corpus_count: int = 100,
) -> QualityGateResult:
    failures: list[str] = []
    if metrics.corpus_count < minimum_corpus_count:
        failures.append("corpus_count")
    for family in ("exact", "resize", "jpeg"):
        if metrics.top1_by_family.get(family, 0.0) < 0.98:
            failures.append(f"{family}_top1")
    if metrics.top5_by_family.get("crop", 0.0) < 0.9:
        failures.append("crop_top5")
    if metrics.top5_by_family.get("blur", 0.0) < 0.85:
        failures.append("blur_top5")
    if metrics.negative_count == 0:
        failures.append("negative_samples")
    elif metrics.false_probable_source_rate >= 0.05:
        failures.append("negative_false_probable_source")
    if not metrics.reproducible:
        failures.append("reproducible")
    return QualityGateResult(passed=not failures, failures=tuple(failures))


def _record_payload(record: BenchmarkRecord) -> dict[str, object]:
    return {
        "sourcePatternId": record.source_pattern_id,
        "transform": record.transform,
        "family": record.family,
        "negative": record.negative,
        "rank": record.rank,
        "matchedPatternId": record.matched_pattern_id,
        "category": record.category,
        "score": record.score,
        "latencyMs": record.latency_ms,
    }


def _evidence_candidates(
    result: SearchEvidenceResult,
) -> tuple[CalibrationCandidate, ...]:
    from .calibration import CalibrationCandidate

    return tuple(
        CalibrationCandidate(item.pattern_id, item.evidence) for item in result.items
    )


def _secure_query_file(
    directory: Path,
    *,
    index: int,
    variant: BenchmarkVariant,
) -> Path:
    buffer = io.BytesIO()
    Image.fromarray(variant.image).save(buffer, format="PNG", optimize=False)
    path = directory / f"{index:02d}-{variant.name}.png"
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(buffer.getvalue())
        handle.flush()
        os.fsync(handle.fileno())
    return path


def _atomic_json_write(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    )
    staged = Path(handle.name)
    try:
        os.chmod(staged, 0o600)
        with handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staged, path)
    finally:
        staged.unlink(missing_ok=True)


def _validate_run_inputs(
    *,
    owner_id: UUID,
    index_version: str,
    model_sha256: str,
    count: int,
    seed: int,
) -> None:
    if not isinstance(owner_id, UUID):
        raise ValueError("owner_id must be a UUID")
    if not index_version:
        raise ValueError("index_version must not be empty")
    if (
        len(model_sha256) != 64
        or model_sha256.lower() != model_sha256
        or set(model_sha256) - set("0123456789abcdef")
    ):
        raise ValueError("model_sha256 must be canonical lowercase hex")
    if count != BENCHMARK_PATTERN_COUNT:
        raise BenchmarkCorpusError()
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("seed must be an integer")


def run_benchmark(
    repository: BenchmarkRepository,
    storage: BenchmarkStorage,
    search: BenchmarkSearch,
    *,
    owner_id: UUID,
    index_version: str,
    model_sha256: str,
    count: int,
    seed: int,
    output_path: Path,
    scoring_output_path: Path,
    base_scoring_path: Path = SCORING_CONFIG_PATH,
    temporary_parent: Path | None = None,
) -> BenchmarkReport:
    from .calibration import (
        CalibrationQuery,
        build_calibration_grid,
        calibrate_scoring,
        calibration_record,
        write_scoring_config_atomic,
    )

    _validate_run_inputs(
        owner_id=owner_id,
        index_version=index_version,
        model_sha256=model_sha256,
        count=count,
        seed=seed,
    )
    if output_path.resolve() == scoring_output_path.resolve():
        raise ValueError("benchmark output and scoring config paths must differ")
    previews = repository.sample_ready_previews(
        owner_id=owner_id,
        index_version=index_version,
        count=count,
        seed=seed,
    )
    pattern_ids = tuple(preview.pattern_id for preview in previews)
    if len(previews) != count or len(set(pattern_ids)) != count:
        raise BenchmarkCorpusError()

    base_path = scoring_output_path if scoring_output_path.exists() else base_scoring_path
    base_config = load_scoring_config(base_path)
    candidates = build_calibration_grid(base_config)
    minimum_similarity = min(
        candidate.minimum_visual_similarity for candidate in candidates
    )
    captured: list[_CapturedQuery] = []
    if temporary_parent is not None:
        temporary_parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        prefix="melon-visual-search-benchmark-",
        dir=temporary_parent,
    ) as temporary_name:
        temporary_directory = Path(temporary_name)
        os.chmod(temporary_directory, 0o700)
        for source_index, preview in enumerate(previews):
            encoded = storage.read_preview(
                owner_id,
                preview.pattern_id,
                preview.object_key,
            )
            source = decode_image(encoded)
            variants = generate_benchmark_variants(
                source,
                seed=seed ^ (preview.pattern_id.int & 0xFFFFFFFF),
            )
            query_paths: list[Path] = []
            try:
                for variant_index, variant in enumerate(variants):
                    query_path = _secure_query_file(
                        temporary_directory,
                        index=(source_index * len(variants)) + variant_index,
                        variant=variant,
                    )
                    query_paths.append(query_path)
                    query_image = decode_image(query_path.read_bytes())

                    started = time.perf_counter()
                    positive = search.collect_evidence(
                        owner_id,
                        pattern_ids,
                        query_image,
                        minimum_visual_similarity=minimum_similarity,
                    )
                    positive_latency = round(
                        (time.perf_counter() - started) * 1000,
                        3,
                    )
                    captured.append(
                        _CapturedQuery(
                            transform=variant.name,
                            latency_ms=positive_latency,
                            query=CalibrationQuery(
                                source_pattern_id=preview.pattern_id,
                                family=variant.family,
                                candidates=_evidence_candidates(positive),
                            ),
                        )
                    )

                    negative_scope = tuple(
                        pattern_id
                        for pattern_id in pattern_ids
                        if pattern_id != preview.pattern_id
                    )
                    started = time.perf_counter()
                    negative = search.collect_evidence(
                        owner_id,
                        negative_scope,
                        query_image,
                        minimum_visual_similarity=minimum_similarity,
                    )
                    negative_latency = round(
                        (time.perf_counter() - started) * 1000,
                        3,
                    )
                    captured.append(
                        _CapturedQuery(
                            transform=variant.name,
                            latency_ms=negative_latency,
                            query=CalibrationQuery(
                                source_pattern_id=preview.pattern_id,
                                family=variant.family,
                                candidates=_evidence_candidates(negative),
                                negative=True,
                            ),
                        )
                    )
            finally:
                for query_path in query_paths:
                    query_path.unlink(missing_ok=True)

    calibration_queries = tuple(item.query for item in captured)
    calibration = calibrate_scoring(
        calibration_queries,
        candidates=candidates,
        output_path=scoring_output_path,
        seed=seed,
        publish=False,
    )
    records = tuple(
        calibration_record(
            item.query,
            calibration.selected,
            transform=item.transform,
            latency_ms=item.latency_ms,
        )
        for item in captured
    )
    replay = tuple(
        calibration_record(
            item.query,
            calibration.selected,
            transform=item.transform,
            latency_ms=item.latency_ms,
        )
        for item in captured
    )
    metrics = compute_benchmark_metrics(
        records,
        corpus_count=count,
        reproducible=records == replay,
    )
    quality_gates = evaluate_quality_gates(metrics)
    report = BenchmarkReport(
        owner_id=owner_id,
        index_version=index_version,
        model_sha256=model_sha256,
        count=count,
        seed=seed,
        records=records,
        metrics=metrics,
        quality_gates=quality_gates,
        calibration=calibration,
    )
    _atomic_json_write(output_path, report.to_dict())
    if not quality_gates.passed:
        raise BenchmarkGateError(report)
    write_scoring_config_atomic(calibration.selected, scoring_output_path)
    return report
