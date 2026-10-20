from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable, Sequence
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from .embedding import EmbeddingRuntime
from .image_io import ImageSearchError
from .repository import Repository
from .settings import Settings, get_settings
from .storage import AlibabaOssStorage
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
    return parser


def _database_url(settings: Settings) -> str:
    if settings.database_url is None:
        raise CliConfigurationError()
    return settings.database_url.get_secret_value()


def _required_text(value: str | None) -> str:
    if value is None:
        raise CliConfigurationError()
    return value


def _build_storage(settings: Settings) -> AlibabaOssStorage:
    return AlibabaOssStorage(
        region=_required_text(settings.oss_region),
        bucket=_required_text(settings.oss_bucket),
        endpoint=_required_text(settings.oss_endpoint),
        environment=settings.environment,
    )


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
        storage = _build_storage(settings)
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
            _build_storage(settings),
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


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        settings = get_settings()
        if args.command == "worker":
            return _run_worker(settings)
        if args.command == "cleanup-orphans":
            return _run_cleanup(
                settings,
                older_than_hours=args.older_than_hours,
            )
        raise CliConfigurationError()
    except KeyboardInterrupt:
        return 130
    except (CleanupRefusedError, CliConfigurationError, ImageSearchError) as error:
        print(getattr(error, "code", "INDEX_COMMAND_FAILED"), file=sys.stderr)
        return 2
    except Exception:
        print("INDEX_COMMAND_FAILED", file=sys.stderr)
        return 1
