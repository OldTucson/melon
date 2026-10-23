from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable, Sequence
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

from .benchmark import (
    SCORING_CONFIG_PATH,
    BenchmarkError,
    run_benchmark,
)
from .embedding import EmbeddingRuntime
from .image_io import ImageSearchError
from .palette_benchmark import PaletteBenchmarkError, run_palette_benchmark
from .repository import Repository
from .search import SearchService
from .settings import Settings, get_settings
from .storage import AlibabaOssStorage, FeatureStorage, LocalFeatureStorage
from .worker import (
    CleanupRefusedError,
    IndexWorker,
    assert_cleanup_database_allowed,
    cleanup_orphans,
)

MODEL_LOCK_PATH = Path(__file__).resolve().parents[2] / "model-lock.json"


class CliConfigurationError(RuntimeError):
    code = "INDEX_CONFIGURATION_INVALID"

    def __init__(self) -> None:
        super().__init__(self.code)


def _positive_hours(value: str) -> float:
    try:
        hours = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("hours must be a number") from error
    if hours <= 0:
        raise argparse.ArgumentTypeError("hours must be positive")
    return hours


def _positive_integer(value: str) -> int:
    try:
        result = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("value must be an integer") from error
    if result <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return result


def _nonnegative_integer(value: str) -> int:
    try:
        result = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("value must be an integer") from error
    if result < 0:
        raise argparse.ArgumentTypeError("value must not be negative")
    return result


def _canonical_uuid(value: str) -> UUID:
    try:
        result = UUID(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("value must be a UUID") from error
    if str(result) != value:
        raise argparse.ArgumentTypeError("value must be a canonical UUID")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="melon-visual-search")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("worker")
    cleanup = commands.add_parser("cleanup-orphans")
    cleanup.add_argument(
        "--older-than-hours",
        type=_positive_hours,
        default=24.0,
    )
    benchmark = commands.add_parser("benchmark")
    benchmark.add_argument("--owner-id", type=_canonical_uuid, required=True)
    benchmark.add_argument("--count", type=_positive_integer, default=100)
    benchmark.add_argument("--seed", type=int, default=20261020)
    benchmark.add_argument("--output", type=Path, required=True)
    palette_benchmark = commands.add_parser("palette-benchmark")
    palette_benchmark.add_argument("--count", type=_positive_integer, default=10_000)
    palette_benchmark.add_argument(
        "--colors-per-candidate",
        type=_positive_integer,
        default=5,
    )
    palette_benchmark.add_argument("--warmups", type=_nonnegative_integer, default=5)
    palette_benchmark.add_argument("--iterations", type=_positive_integer, default=30)
    palette_benchmark.add_argument("--seed", type=int, default=20261022)
    palette_benchmark.add_argument("--output", type=Path, required=True)
    return parser


def _database_url(settings: Settings) -> str:
    if settings.database_url is None:
        raise CliConfigurationError()
    return settings.database_url.get_secret_value()


def _required_text(value: str | None) -> str:
    if value is None:
        raise CliConfigurationError()
    return value


def build_storage(settings: Settings) -> FeatureStorage:
    remote = AlibabaOssStorage(
        region=_required_text(settings.oss_region),
        bucket=_required_text(settings.oss_bucket),
        endpoint=_required_text(settings.oss_endpoint),
        environment=settings.environment,
    )
    if settings.feature_storage_dir is None:
        return remote
    return LocalFeatureStorage(remote, root=settings.feature_storage_dir)


def load_embedding_runtime(
    settings: Settings,
    *,
    lock_path: Path = MODEL_LOCK_PATH,
    runtime_factory: Callable[..., EmbeddingRuntime] = EmbeddingRuntime.from_lock,
) -> EmbeddingRuntime:
    if settings.model_path is None or settings.model_sha256 is None:
        raise CliConfigurationError()
    return runtime_factory(
        lock_path,
        artifact_path=settings.model_path,
        expected_sha256=settings.model_sha256,
    )


def _run_worker(settings: Settings) -> int:
    repository = Repository(_database_url(settings))
    try:
        storage = build_storage(settings)
        runtime = load_embedding_runtime(settings)
        worker = IndexWorker(
            repository,
            storage,
            runtime,
            worker_id=f"worker-{uuid4()}",
            index_version=settings.active_version,
        )
        while True:
            if worker.run_once() == "idle":
                time.sleep(1.0)
    finally:
        repository.close()


def _run_cleanup(settings: Settings, *, older_than_hours: float) -> int:
    repository = Repository(_database_url(settings))
    try:
        assert_cleanup_database_allowed(
            repository.database_name(),
            production_database_name=settings.production_database_name,
        )
        report = cleanup_orphans(
            repository,
            build_storage(settings),
            index_version=settings.active_version,
            older_than=timedelta(hours=older_than_hours),
            production_database_name=settings.production_database_name,
        )
    finally:
        repository.close()
    print(
        json.dumps(
            {
                "deleted": report.deleted,
                "kept": report.kept,
                "scanned": report.scanned,
            },
            sort_keys=True,
        )
    )
    return 0


def _run_benchmark(
    settings: Settings,
    *,
    owner_id: UUID,
    count: int,
    seed: int,
    output_path: Path,
) -> int:
    repository = Repository(_database_url(settings))
    try:
        storage = build_storage(settings)
        service = SearchService(
            repository,
            storage,
            load_embedding_runtime(settings),
            index_version=settings.active_version,
        )
        report = run_benchmark(
            repository,
            storage,
            service,
            owner_id=owner_id,
            index_version=settings.active_version,
            model_sha256=_required_text(settings.model_sha256),
            count=count,
            seed=seed,
            output_path=output_path,
            scoring_output_path=SCORING_CONFIG_PATH,
        )
    finally:
        repository.close()
    print(
        json.dumps(
            {
                "corpusCount": report.metrics.corpus_count,
                "passed": report.quality_gates.passed,
            },
            sort_keys=True,
        )
    )
    return 0


def _run_palette_benchmark(
    *,
    count: int,
    colors_per_candidate: int,
    warmups: int,
    iterations: int,
    seed: int,
    output_path: Path,
) -> int:
    report = run_palette_benchmark(
        count=count,
        colors_per_candidate=colors_per_candidate,
        warmups=warmups,
        iterations=iterations,
        seed=seed,
        output_path=output_path,
    )
    print(
        json.dumps(
            {
                "count": report.count,
                "iterations": report.iterations,
                "p50Milliseconds": report.p50_milliseconds,
                "p95Milliseconds": report.p95_milliseconds,
            },
            sort_keys=True,
        )
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "palette-benchmark":
            return _run_palette_benchmark(
                count=args.count,
                colors_per_candidate=args.colors_per_candidate,
                warmups=args.warmups,
                iterations=args.iterations,
                seed=args.seed,
                output_path=args.output,
            )
        settings = get_settings()
        if args.command == "worker":
            return _run_worker(settings)
        if args.command == "cleanup-orphans":
            return _run_cleanup(
                settings,
                older_than_hours=args.older_than_hours,
            )
        if args.command == "benchmark":
            return _run_benchmark(
                settings,
                owner_id=args.owner_id,
                count=args.count,
                seed=args.seed,
                output_path=args.output,
            )
        raise CliConfigurationError()
    except KeyboardInterrupt:
        return 130
    except (
        BenchmarkError,
        CleanupRefusedError,
        CliConfigurationError,
        ImageSearchError,
        PaletteBenchmarkError,
    ) as error:
        print(getattr(error, "code", "INDEX_COMMAND_FAILED"), file=sys.stderr)
        return 2
    except Exception:
        print("INDEX_COMMAND_FAILED", file=sys.stderr)
        return 1
