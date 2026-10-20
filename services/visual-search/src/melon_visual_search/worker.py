from __future__ import annotations

import hashlib
import re
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import partial
from typing import Literal, Protocol

import numpy as np
import numpy.typing as npt
import psycopg
from alibabacloud_credentials.exceptions import CredentialException  # type: ignore[import-untyped]
from alibabacloud_oss_v2.exceptions import BaseError as OssError  # type: ignore[import-untyped]

from .image_io import ImageSearchError, Region, decode_image, make_regions
from .local_features import extract_local_features, serialize_local_features
from .repository import (
    HEARTBEAT_INTERVAL_SECONDS,
    EmbeddingRecord,
    IndexJob,
    LeaseLostError,
    PreviewUnavailableError,
    Repository,
)
from .storage import (
    FeatureStorage,
    PreviewNotFoundError,
    StorageKeyError,
    build_derived_key,
    parse_derived_key,
)

WorkerOutcome = Literal["idle", "completed", "retried", "failed", "stale"]

INDEX_EMBEDDING_INVALID = "INDEX_EMBEDDING_INVALID"
INDEX_DATABASE_PERMANENT_FAILURE = "INDEX_DATABASE_PERMANENT_FAILURE"
INDEX_PREVIEW_HASH_MISMATCH = "INDEX_PREVIEW_HASH_MISMATCH"
INDEX_TEMPORARY_FAILURE = "INDEX_TEMPORARY_FAILURE"

_INDEX_VERSION_PATTERN = re.compile(r"^[a-z0-9-]{1,64}$")
_RETRYABLE_DATABASE_SQLSTATE_CLASSES = frozenset({"08", "40", "53"})
_RETRYABLE_DATABASE_SQLSTATES = frozenset(
    {
        "55P03",  # lock_not_available
        "57014",  # query_canceled, including statement timeout
        "57P01",  # admin_shutdown
        "57P02",  # crash_shutdown
        "57P03",  # cannot_connect_now
        "57P05",  # idle_session_timeout
    }
)


class CleanupRefusedError(RuntimeError):
    code = "INDEX_CLEANUP_DATABASE_REFUSED"

    def __init__(self) -> None:
        super().__init__(self.code)


@dataclass(frozen=True)
class CleanupReport:
    scanned: int
    kept: int
    deleted: int


def assert_cleanup_database_allowed(
    database_name: str,
    *,
    production_database_name: str | None,
) -> None:
    if database_name.endswith("_test"):
        return
    if production_database_name is not None and database_name == production_database_name:
        return
    raise CleanupRefusedError()


def cleanup_orphans(
    repository: Repository,
    storage: FeatureStorage,
    *,
    index_version: str,
    older_than: timedelta,
    production_database_name: str | None = None,
    now: datetime | None = None,
) -> CleanupReport:
    if not _INDEX_VERSION_PATTERN.fullmatch(index_version):
        raise ValueError("index_version must match [a-z0-9-]{1,64}")
    if older_than <= timedelta(0):
        raise ValueError("older_than must be positive")
    cleanup_time = now or _utc_now()
    if cleanup_time.tzinfo is None or cleanup_time.utcoffset() is None:
        raise ValueError("cleanup time must be timezone-aware")

    assert_cleanup_database_allowed(
        repository.database_name(),
        production_database_name=production_database_name,
    )
    inventory = repository.cleanup_inventory(index_version=index_version)
    keep_keys: set[str] = set()
    protected_scopes: set[tuple[object, object, str]] = set()

    for document in inventory.documents:
        expected_key = build_derived_key(
            document.owner_id,
            document.pattern_id,
            document.index_version,
            document.preview_hash,
        )
        if document.object_key != expected_key:
            raise StorageKeyError()
        keep_keys.add(expected_key)

    for job in inventory.live_jobs:
        live_scope = (job.owner_id, job.pattern_id, job.index_version)
        if job.preview_hash is None:
            protected_scopes.add(live_scope)
        else:
            keep_keys.add(
                build_derived_key(
                    job.owner_id,
                    job.pattern_id,
                    job.index_version,
                    job.preview_hash,
                )
            )

    cutoff = cleanup_time - older_than
    scanned = 0
    kept = 0
    deleted = 0
    for cleanup_scope in inventory.scopes:
        scope_key = (
            cleanup_scope.owner_id,
            cleanup_scope.pattern_id,
            index_version,
        )
        for stored in storage.list_features(
            cleanup_scope.owner_id,
            cleanup_scope.pattern_id,
            index_version,
        ):
            owner_id, pattern_id, parsed_version, preview_hash = parse_derived_key(
                stored.key
            )
            if (owner_id, pattern_id, parsed_version) != scope_key:
                raise StorageKeyError()
            scanned += 1
            if (
                stored.key in keep_keys
                or scope_key in protected_scopes
                or stored.last_modified >= cutoff
            ):
                kept += 1
                continue
            removed = repository.delete_feature_if_unreferenced(
                owner_id,
                pattern_id,
                parsed_version,
                preview_hash,
                partial(
                    storage.delete_features,
                    owner_id,
                    pattern_id,
                    parsed_version,
                    preview_hash,
                ),
            )
            if removed:
                deleted += 1
            else:
                kept += 1
    return CleanupReport(scanned=scanned, kept=kept, deleted=deleted)


class Embedder(Protocol):
    def embed(
        self,
        regions: Sequence[Region],
    ) -> npt.NDArray[np.float32]: ...


class _TerminalFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _is_retryable_database_error(error: psycopg.Error) -> bool:
    sqlstate = error.sqlstate
    if sqlstate is None:
        return isinstance(error, psycopg.OperationalError)
    return (
        sqlstate[:2] in _RETRYABLE_DATABASE_SQLSTATE_CLASSES
        or sqlstate in _RETRYABLE_DATABASE_SQLSTATES
    )


class _LeaseHeartbeat:
    def __init__(
        self,
        repository: Repository,
        job: IndexJob,
        worker_id: str,
        index_version: str,
        interval_seconds: float,
        clock: Callable[[], datetime],
    ) -> None:
        self._repository = repository
        self._job = job
        self._worker_id = worker_id
        self._index_version = index_version
        self._interval_seconds = interval_seconds
        self._clock = clock
        self._stop = threading.Event()
        self._lease_lost = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="visual-search-lease-heartbeat",
            daemon=True,
        )

    def __enter__(self) -> _LeaseHeartbeat:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join()

    def assert_owned(self) -> None:
        if self._lease_lost.is_set():
            raise LeaseLostError()

    def _run(self) -> None:
        while not self._stop.wait(self._interval_seconds):
            now = self._clock()
            try:
                self._repository.heartbeat_worker(
                    self._worker_id,
                    self._index_version,
                    now=now,
                )
                self._repository.renew_lease(
                    self._job,
                    self._worker_id,
                    now=now,
                )
            except LeaseLostError:
                self._lease_lost.set()
                return
            except psycopg.Error:
                # Publication still verifies the lease. A later heartbeat may recover
                # from a transient database outage before the lease expires.
                continue


class IndexWorker:
    def __init__(
        self,
        repository: Repository,
        storage: FeatureStorage,
        embedder: Embedder,
        *,
        worker_id: str,
        index_version: str,
        heartbeat_interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        if heartbeat_interval_seconds <= 0:
            raise ValueError("heartbeat interval must be positive")
        self._repository = repository
        self._storage = storage
        self._embedder = embedder
        self.worker_id = worker_id
        self.index_version = index_version
        self._heartbeat_interval_seconds = heartbeat_interval_seconds
        self._clock = clock

    @staticmethod
    def retry_delay(attempt_count: int) -> timedelta:
        if attempt_count <= 0:
            raise ValueError("attempt_count must be positive")
        return timedelta(seconds=min(3600, 30 * 2 ** (attempt_count - 1)))

    def run_once(self, *, now: datetime | None = None) -> WorkerOutcome:
        operation_time = now or self._clock()
        self._repository.heartbeat_worker(
            self.worker_id,
            self.index_version,
            now=operation_time,
        )
        job = self._repository.claim_next(
            self.worker_id,
            index_version=self.index_version,
            now=operation_time,
        )
        if job is None:
            return "idle"

        try:
            with _LeaseHeartbeat(
                self._repository,
                job,
                self.worker_id,
                self.index_version,
                self._heartbeat_interval_seconds,
                self._clock,
            ) as heartbeat:
                return self._process(job, heartbeat)
        except LeaseLostError:
            return "stale"
        except PreviewUnavailableError as error:
            return self._record_failure(job, error.code, retryable=False)
        except StorageKeyError as error:
            return self._record_failure(job, error.code, retryable=False)
        except ImageSearchError as error:
            return self._record_failure(job, error.code, retryable=False)
        except _TerminalFailure as error:
            return self._record_failure(job, error.code, retryable=False)
        except PreviewNotFoundError as error:
            return self._record_failure(job, error.code, retryable=False)
        except psycopg.Error as error:
            retryable = _is_retryable_database_error(error)
            return self._record_failure(
                job,
                (
                    INDEX_TEMPORARY_FAILURE
                    if retryable
                    else INDEX_DATABASE_PERMANENT_FAILURE
                ),
                retryable=retryable,
            )
        except (OSError, OssError, CredentialException):
            return self._record_failure(
                job,
                INDEX_TEMPORARY_FAILURE,
                retryable=True,
            )

    def _process(
        self,
        job: IndexJob,
        heartbeat: _LeaseHeartbeat,
    ) -> WorkerOutcome:
        preview = self._repository.get_current_preview(
            job,
            self.worker_id,
            now=self._clock(),
        )
        encoded = self._storage.read_preview(
            job.owner_id,
            job.pattern_id,
            preview.object_key,
        )
        preview_hash = hashlib.sha256(encoded).hexdigest()
        if (
            job.preview_hash is not None
            and job.preview_hash != preview_hash
            or preview.content_hash is not None
            and preview.content_hash != preview_hash
        ):
            raise _TerminalFailure(INDEX_PREVIEW_HASH_MISMATCH)

        if self._repository.complete_if_ready(
            job,
            self.worker_id,
            preview_hash=preview_hash,
            preview_object_key=preview.object_key,
            now=self._clock(),
        ):
            return "completed"

        image = decode_image(encoded)
        regions = make_regions(image)
        vectors = self._validated_vectors(self._embedder.embed(regions))
        local_features = extract_local_features(image)
        feature_archive = serialize_local_features(local_features)
        heartbeat.assert_owned()

        write = self._storage.write_features(
            job.owner_id,
            job.pattern_id,
            job.index_version,
            preview_hash,
            feature_archive,
            now=self._clock(),
        )
        try:
            heartbeat.assert_owned()
            publication = self._repository.publish(
                job,
                self.worker_id,
                preview_hash=preview_hash,
                preview_object_key=preview.object_key,
                width=int(image.shape[1]),
                height=int(image.shape[0]),
                phash=local_features.phash,
                local_feature_object_key=write.key,
                embeddings=self._embedding_records(regions, vectors),
                now=self._clock(),
            )
        except Exception:
            if write.created:
                self._best_effort_delete(
                    job,
                    preview_hash,
                    allow_owned_lease=True,
                )
            raise

        for superseded_hash in publication.superseded_hashes:
            self._best_effort_delete(job, superseded_hash)
        return "completed"

    def _record_failure(
        self,
        job: IndexJob,
        error_code: str,
        *,
        retryable: bool,
    ) -> WorkerOutcome:
        try:
            failed = self._repository.fail(
                job,
                error_code,
                retryable=retryable,
                worker_id=self.worker_id,
                now=self._clock(),
            )
        except LeaseLostError:
            return "stale"
        return "retried" if failed.status == "pending" else "failed"

    def _best_effort_delete(
        self,
        job: IndexJob,
        preview_hash: str,
        *,
        allow_owned_lease: bool = False,
    ) -> None:
        try:
            self._repository.delete_feature_if_unreferenced(
                job.owner_id,
                job.pattern_id,
                job.index_version,
                preview_hash,
                lambda: self._storage.delete_features(
                    job.owner_id,
                    job.pattern_id,
                    job.index_version,
                    preview_hash,
                ),
                owned_job=job if allow_owned_lease else None,
                worker_id=self.worker_id if allow_owned_lease else None,
                now=self._clock(),
            )
        except Exception:
            pass

    @staticmethod
    def _validated_vectors(value: object) -> npt.NDArray[np.float32]:
        if not isinstance(value, np.ndarray):
            raise _TerminalFailure(INDEX_EMBEDDING_INVALID)
        if (
            value.dtype != np.float32
            or value.shape != (10, 384)
            or not np.isfinite(value).all()
        ):
            raise _TerminalFailure(INDEX_EMBEDDING_INVALID)
        norms = np.linalg.norm(value, axis=1)
        if not np.allclose(norms, np.ones(10), rtol=1e-5, atol=1e-6):
            raise _TerminalFailure(INDEX_EMBEDDING_INVALID)
        return np.ascontiguousarray(value, dtype=np.float32)

    @staticmethod
    def _embedding_records(
        regions: Sequence[Region],
        vectors: npt.NDArray[np.float32],
    ) -> tuple[EmbeddingRecord, ...]:
        return tuple(
            EmbeddingRecord(
                region_index=region.index,
                region_kind=region.kind,
                x=region.bounds[0],
                y=region.bounds[1],
                width=region.bounds[2],
                height=region.bounds[3],
                embedding=np.ascontiguousarray(vectors[index], dtype=np.float32),
            )
            for index, region in enumerate(regions)
        )
