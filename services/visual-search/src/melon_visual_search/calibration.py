from __future__ import annotations

import json
import os
import random
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass, replace
from pathlib import Path
from uuid import UUID

from .benchmark import (
    BenchmarkMetrics,
    BenchmarkRecord,
    QualityGateResult,
    compute_benchmark_metrics,
    evaluate_quality_gates,
)
from .scoring import (
    GeometryThresholds,
    MatchEvidence,
    MatchKind,
    ScoringConfig,
    classify,
    load_scoring_config,
)

CALIBRATION_PATTERN_COUNT = 100
CALIBRATION_TRAIN_COUNT = 70


@dataclass(frozen=True)
class PatternSplit:
    train: tuple[UUID, ...]
    validation: tuple[UUID, ...]


@dataclass(frozen=True)
class CalibrationCandidate:
    pattern_id: UUID
    evidence: MatchEvidence


@dataclass(frozen=True)
class CalibrationQuery:
    source_pattern_id: UUID
    family: str
    candidates: tuple[CalibrationCandidate, ...]
    negative: bool = False


@dataclass(frozen=True)
class CalibrationResult:
    selected: ScoringConfig
    train_metrics: BenchmarkMetrics
    validation_metrics: BenchmarkMetrics
    validation_gates: QualityGateResult


def deterministic_pattern_split(
    pattern_ids: Iterable[UUID],
    *,
    seed: int,
) -> PatternSplit:
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("calibration seed must be an integer")
    unique = sorted(set(pattern_ids), key=str)
    if len(unique) != CALIBRATION_PATTERN_COUNT:
        raise ValueError("calibration requires exactly 100 distinct patterns")
    random.Random(seed).shuffle(unique)
    return PatternSplit(
        train=tuple(unique[:CALIBRATION_TRAIN_COUNT]),
        validation=tuple(unique[CALIBRATION_TRAIN_COUNT:]),
    )


def build_calibration_grid(base: ScoringConfig) -> tuple[ScoringConfig, ...]:
    visual_thresholds = (0.52, 0.55, 0.58)
    phash_thresholds = ((4, 10), (6, 12), (8, 14))
    geometry_thresholds = (
        (
            GeometryThresholds(16, 0.4, 0.08),
            GeometryThresholds(7, 0.22, 0.03),
        ),
        (
            GeometryThresholds(18, 0.45, 0.12),
            GeometryThresholds(8, 0.25, 0.04),
        ),
        (
            GeometryThresholds(22, 0.5, 0.16),
            GeometryThresholds(10, 0.3, 0.06),
        ),
    )
    return tuple(
        replace(
            base,
            minimum_visual_similarity=visual,
            probable_phash_distance=probable_phash,
            possible_phash_distance=possible_phash,
            probable_geometry=probable_geometry,
            possible_geometry=possible_geometry,
        )
        for visual in visual_thresholds
        for probable_phash, possible_phash in phash_thresholds
        for probable_geometry, possible_geometry in geometry_thresholds
    )


def _config_key(config: ScoringConfig) -> tuple[float | int, ...]:
    return (
        config.minimum_visual_similarity,
        config.probable_phash_distance,
        config.possible_phash_distance,
        config.probable_geometry.minimum_inliers,
        config.probable_geometry.minimum_inlier_ratio,
        config.probable_geometry.minimum_coverage,
        config.possible_geometry.minimum_inliers,
        config.possible_geometry.minimum_inlier_ratio,
        config.possible_geometry.minimum_coverage,
    )


def calibration_record(
    query: CalibrationQuery,
    config: ScoringConfig,
    *,
    transform: str | None = None,
    latency_ms: float = 0.0,
) -> BenchmarkRecord:
    ranked: list[tuple[UUID, MatchKind, float, int]] = []
    for candidate in query.candidates:
        result = classify(candidate.evidence, config)
        if result is not None:
            ranked.append(
                (
                    candidate.pattern_id,
                    result.kind,
                    result.score,
                    result.category_rank,
                )
            )
    ranked.sort(key=lambda item: (-item[3], -item[2], str(item[0])))

    rank: int | None = None
    matched_pattern_id: str | None = None
    category: MatchKind | None = None
    score: float | None = None
    if query.negative:
        if ranked:
            matched_pattern_id = str(ranked[0][0])
            category = ranked[0][1]
            score = ranked[0][2]
    else:
        for index, item in enumerate(ranked, start=1):
            if item[0] == query.source_pattern_id:
                rank = index
                matched_pattern_id = str(item[0])
                category = item[1]
                score = item[2]
                break
    return BenchmarkRecord(
        source_pattern_id=str(query.source_pattern_id),
        transform=transform or query.family,
        family=query.family,
        negative=query.negative,
        rank=rank,
        matched_pattern_id=matched_pattern_id,
        category=category,
        score=score,
        latency_ms=latency_ms,
    )


def evaluate_calibration_queries(
    queries: tuple[CalibrationQuery, ...],
    config: ScoringConfig,
) -> BenchmarkMetrics:
    records = tuple(calibration_record(query, config) for query in queries)
    replay = tuple(calibration_record(query, config) for query in queries)
    corpus_count = len({query.source_pattern_id for query in queries})
    return compute_benchmark_metrics(
        records,
        corpus_count=corpus_count,
        reproducible=records == replay,
    )


def scoring_config_payload(config: ScoringConfig) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "version": config.version,
        "thresholds": {
            "minimumVisualSimilarity": config.minimum_visual_similarity,
            "probablePhashDistance": config.probable_phash_distance,
            "possiblePhashDistance": config.possible_phash_distance,
            "probableGeometry": {
                "minimumInliers": config.probable_geometry.minimum_inliers,
                "minimumInlierRatio": (
                    config.probable_geometry.minimum_inlier_ratio
                ),
                "minimumCoverage": config.probable_geometry.minimum_coverage,
            },
            "possibleGeometry": {
                "minimumInliers": config.possible_geometry.minimum_inliers,
                "minimumInlierRatio": (
                    config.possible_geometry.minimum_inlier_ratio
                ),
                "minimumCoverage": config.possible_geometry.minimum_coverage,
            },
        },
        "weights": {
            "bestVisual": config.weights.best_visual,
            "globalVisual": config.weights.global_visual,
            "phash": config.weights.phash,
            "geometry": config.weights.geometry,
        },
        "categoryOrder": dict(config.category_order),
    }


def _stage_config(config: ScoringConfig, output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=output_path.parent,
        prefix=f".{output_path.name}.",
        suffix=".tmp",
        delete=False,
    )
    staged = Path(handle.name)
    try:
        with handle:
            json.dump(scoring_config_payload(config), handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        load_scoring_config(staged)
        return staged
    except Exception:
        staged.unlink(missing_ok=True)
        raise


def _publish_staged_config(staged: Path, output_path: Path) -> None:
    os.replace(staged, output_path)
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_fd = os.open(output_path.parent, directory_flags)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def write_scoring_config_atomic(config: ScoringConfig, output_path: Path) -> None:
    staged = _stage_config(config, output_path)
    try:
        _publish_staged_config(staged, output_path)
    finally:
        staged.unlink(missing_ok=True)


def calibrate_scoring(
    queries: tuple[CalibrationQuery, ...],
    *,
    candidates: tuple[ScoringConfig, ...],
    output_path: Path,
    seed: int,
    publish: bool = True,
) -> CalibrationResult:
    if not candidates:
        raise ValueError("calibration candidates must not be empty")
    split = deterministic_pattern_split(
        (query.source_pattern_id for query in queries),
        seed=seed,
    )
    train_ids = set(split.train)
    validation_ids = set(split.validation)
    train_queries = tuple(
        query for query in queries if query.source_pattern_id in train_ids
    )
    validation_queries = tuple(
        query for query in queries if query.source_pattern_id in validation_ids
    )

    evaluated = [
        (config, evaluate_calibration_queries(train_queries, config))
        for config in candidates
    ]
    safe = [
        item
        for item in evaluated
        if item[1].false_probable_source_rate < 0.05
    ]
    if not safe:
        raise RuntimeError("IMAGE_SEARCH_CALIBRATION_NO_SAFE_CONFIG")
    selected, train_metrics = min(
        safe,
        key=lambda item: (
            -item[1].top5_by_family.get("crop", 0.0),
            -sum(
                item[1].top1_by_family.get(family, 0.0)
                for family in ("exact", "resize", "jpeg")
            ),
            -item[1].top5_by_family.get("blur", 0.0),
            item[1].false_probable_source_rate,
            _config_key(item[0]),
        ),
    )

    staged = _stage_config(selected, output_path)
    try:
        locked = load_scoring_config(staged)
        validation_metrics = evaluate_calibration_queries(validation_queries, locked)
        validation_gates = evaluate_quality_gates(
            validation_metrics,
            minimum_corpus_count=len(split.validation),
        )
        if not validation_gates.passed:
            raise RuntimeError("IMAGE_SEARCH_CALIBRATION_GATE_FAILED")
        if publish:
            _publish_staged_config(staged, output_path)
    except Exception:
        staged.unlink(missing_ok=True)
        raise
    finally:
        staged.unlink(missing_ok=True)

    return CalibrationResult(
        selected=selected,
        train_metrics=train_metrics,
        validation_metrics=validation_metrics,
        validation_gates=validation_gates,
    )
