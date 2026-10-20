from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import numpy.typing as npt
import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

LEASE_DURATION = timedelta(minutes=5)
HEARTBEAT_INTERVAL_SECONDS = 15
MAX_RETRY_DELAY_SECONDS = 3600
DATABASE_POOL_TIMEOUT_SECONDS = 5.0
DATABASE_STATEMENT_TIMEOUT_SECONDS = 30.0

_ERROR_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")


class LeaseLostError(RuntimeError):
    """The caller no longer owns the job lease it tried to mutate."""

    code = "INDEX_JOB_LEASE_LOST"

    def __init__(self) -> None:
        super().__init__(self.code)


class PreviewUnavailableError(RuntimeError):
    code = "INDEX_PREVIEW_UNAVAILABLE"

    def __init__(self) -> None:
        super().__init__(self.code)


@dataclass(frozen=True)
class IndexJob:
    id: UUID
    owner_id: UUID
    pattern_id: UUID
    preview_asset_id: UUID
    preview_hash: str | None
    index_version: str
    status: str
    attempt_count: int
    max_attempts: int
    available_at: datetime
    leased_by: str | None
    lease_until: datetime | None
    last_error_code: str | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class PreviewAsset:
    id: UUID
    owner_id: UUID
    pattern_id: UUID
    object_key: str
    content_hash: str | None
    size_bytes: int


@dataclass(frozen=True)
class EmbeddingRecord:
    region_index: int
    region_kind: str
    x: float
    y: float
    width: float
    height: float
    embedding: npt.NDArray[np.float32]


@dataclass(frozen=True)
class PublicationResult:
    replayed: bool
    superseded_hashes: tuple[str, ...] = ()


@dataclass(frozen=True)
class CleanupScope:
    owner_id: UUID
    pattern_id: UUID


@dataclass(frozen=True)
class DocumentObjectReference:
    owner_id: UUID
    pattern_id: UUID
    preview_hash: str
    index_version: str
    object_key: str


@dataclass(frozen=True)
class LiveJobObjectReference:
    owner_id: UUID
    pattern_id: UUID
    preview_hash: str | None
    index_version: str


@dataclass(frozen=True)
class CleanupInventory:
    scopes: tuple[CleanupScope, ...]
    documents: tuple[DocumentObjectReference, ...]
    live_jobs: tuple[LiveJobObjectReference, ...]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _configure_connection(connection: psycopg.Connection[Any]) -> None:
    register_vector(connection)


def _validate_worker_id(worker_id: str) -> str:
    if (
        not isinstance(worker_id, str)
        or not worker_id
        or len(worker_id) > 128
        or worker_id != worker_id.strip()
        or not worker_id.isascii()
    ):
        raise ValueError("worker_id must be 1-128 unpadded ASCII characters")
    return worker_id


def _validate_error_code(error_code: str) -> str:
    if not isinstance(error_code, str) or not _ERROR_CODE_PATTERN.fullmatch(error_code):
        raise ValueError("error_code must be a stable uppercase identifier")
    return error_code


def _job_from_row(row: dict[str, Any]) -> IndexJob:
    return IndexJob(
        id=row["id"],
        owner_id=row["owner_id"],
        pattern_id=row["pattern_id"],
        preview_asset_id=row["preview_asset_id"],
        preview_hash=row["preview_hash"],
        index_version=row["index_version"],
        status=row["status"],
        attempt_count=row["attempt_count"],
        max_attempts=row["max_attempts"],
        available_at=row["available_at"],
        leased_by=row["leased_by"],
        lease_until=row["lease_until"],
        last_error_code=row["last_error_code"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class Repository:
    def __init__(
        self,
        database_url: str,
        *,
        min_size: int = 1,
        max_size: int = 4,
        statement_timeout_seconds: float = DATABASE_STATEMENT_TIMEOUT_SECONDS,
        pool_timeout_seconds: float = DATABASE_POOL_TIMEOUT_SECONDS,
    ) -> None:
        statement_timeout_ms = round(statement_timeout_seconds * 1000)
        lease_seconds = LEASE_DURATION.total_seconds()
        if (
            not math.isfinite(statement_timeout_seconds)
            or statement_timeout_ms < 1
            or statement_timeout_seconds >= lease_seconds
        ):
            raise ValueError("statement timeout must be positive and shorter than lease")
        if (
            not math.isfinite(pool_timeout_seconds)
            or pool_timeout_seconds <= 0
            or pool_timeout_seconds >= lease_seconds
        ):
            raise ValueError("pool timeout must be positive and shorter than lease")
        self._pool: ConnectionPool[psycopg.Connection[dict[str, Any]]] = ConnectionPool(
            database_url,
            min_size=min_size,
            max_size=max_size,
            open=True,
            timeout=pool_timeout_seconds,
            kwargs={
                "autocommit": True,
                "row_factory": dict_row,
                "options": f"-c statement_timeout={statement_timeout_ms}",
            },
            configure=_configure_connection,
        )
        self._pool.wait(timeout=pool_timeout_seconds)

    def close(self) -> None:
        self._pool.close()

    def get_job(self, job_id: UUID) -> IndexJob | None:
        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT * FROM visual_search_jobs WHERE id = %s",
                (job_id,),
            ).fetchone()
        return _job_from_row(row) if row is not None else None

    def database_name(self) -> str:
        with self._pool.connection() as connection:
            row = connection.execute("SELECT current_database() AS name").fetchone()
        if row is None or not isinstance(row["name"], str):
            raise RuntimeError("INDEX_DATABASE_NAME_UNAVAILABLE")
        return row["name"]

    def cleanup_inventory(self, *, index_version: str) -> CleanupInventory:
        with self._pool.connection() as connection, connection.transaction():
            scope_rows = connection.execute(
                """
                SELECT owner_id, id AS pattern_id
                FROM patterns
                ORDER BY owner_id, id
                """
            ).fetchall()
            job_rows = connection.execute(
                """
                SELECT owner_id, pattern_id, preview_hash, index_version
                FROM visual_search_jobs
                WHERE index_version = %s
                  AND status IN ('pending', 'leased')
                ORDER BY owner_id, pattern_id, id
                """,
                (index_version,),
            ).fetchall()
            # Publication atomically transitions a live job into a ready document.
            # Reading jobs first means either side of that transition protects the
            # object under PostgreSQL's default READ COMMITTED isolation.
            document_rows = connection.execute(
                """
                SELECT owner_id, pattern_id, preview_hash, index_version,
                       local_feature_object_key AS object_key
                FROM visual_search_documents
                WHERE index_version = %s
                  AND local_feature_object_key IS NOT NULL
                ORDER BY owner_id, pattern_id, preview_hash
                """,
                (index_version,),
            ).fetchall()
        return CleanupInventory(
            scopes=tuple(
                CleanupScope(
                    owner_id=row["owner_id"],
                    pattern_id=row["pattern_id"],
                )
                for row in scope_rows
            ),
            documents=tuple(
                DocumentObjectReference(
                    owner_id=row["owner_id"],
                    pattern_id=row["pattern_id"],
                    preview_hash=row["preview_hash"],
                    index_version=row["index_version"],
                    object_key=row["object_key"],
                )
                for row in document_rows
            ),
            live_jobs=tuple(
                LiveJobObjectReference(
                    owner_id=row["owner_id"],
                    pattern_id=row["pattern_id"],
                    preview_hash=row["preview_hash"],
                    index_version=row["index_version"],
                )
                for row in job_rows
            ),
        )

    def claim_next(
        self,
        worker_id: str,
        *,
        index_version: str,
        now: datetime | None = None,
    ) -> IndexJob | None:
        worker_id = _validate_worker_id(worker_id)
        claim_time = now or _utc_now()
        lease_until = claim_time + LEASE_DURATION

        with self._pool.connection() as connection, connection.transaction():
            connection.execute(
                """
                WITH terminal AS (
                  SELECT id
                  FROM visual_search_jobs
                  WHERE index_version = %(index_version)s
                    AND status = 'leased'
                    AND lease_until < %(now)s
                    AND attempt_count >= max_attempts
                  FOR UPDATE SKIP LOCKED
                )
                UPDATE visual_search_jobs AS job
                SET status = 'failed',
                    leased_by = NULL,
                    lease_until = NULL,
                    last_error_code = 'INDEX_LEASE_EXPIRED',
                    updated_at = %(now)s
                FROM terminal
                WHERE job.id = terminal.id
                """,
                {"index_version": index_version, "now": claim_time},
            )
            candidate = connection.execute(
                """
                SELECT *
                FROM visual_search_jobs
                WHERE index_version = %(index_version)s
                  AND attempt_count < max_attempts
                  AND (
                    (status = 'pending' AND available_at <= %(now)s)
                    OR
                    (status = 'leased' AND lease_until < %(now)s)
                  )
                ORDER BY available_at, created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
                """,
                {"index_version": index_version, "now": claim_time},
            ).fetchone()
            if candidate is None:
                return None

            row = connection.execute(
                """
                UPDATE visual_search_jobs
                SET status = 'leased',
                    attempt_count = attempt_count + 1,
                    leased_by = %(worker_id)s,
                    lease_until = %(lease_until)s,
                    updated_at = %(now)s
                WHERE id = %(id)s
                  AND owner_id = %(owner_id)s
                  AND pattern_id = %(pattern_id)s
                  AND preview_asset_id = %(preview_asset_id)s
                  AND index_version = %(index_version)s
                RETURNING *
                """,
                {
                    "worker_id": worker_id,
                    "lease_until": lease_until,
                    "now": claim_time,
                    "id": candidate["id"],
                    "owner_id": candidate["owner_id"],
                    "pattern_id": candidate["pattern_id"],
                    "preview_asset_id": candidate["preview_asset_id"],
                    "index_version": candidate["index_version"],
                },
            ).fetchone()
            if row is None:
                raise LeaseLostError()
            return _job_from_row(row)

    def renew_lease(
        self,
        job: IndexJob,
        worker_id: str,
        *,
        now: datetime | None = None,
    ) -> IndexJob:
        worker_id = _validate_worker_id(worker_id)
        renewal_time = now or _utc_now()
        with self._pool.connection() as connection:
            row = connection.execute(
                """
                UPDATE visual_search_jobs
                SET lease_until = %(lease_until)s,
                    updated_at = %(now)s
                WHERE id = %(id)s
                  AND owner_id = %(owner_id)s
                  AND pattern_id = %(pattern_id)s
                  AND preview_asset_id = %(preview_asset_id)s
                  AND index_version = %(index_version)s
                  AND attempt_count = %(attempt_count)s
                  AND status = 'leased'
                  AND leased_by = %(worker_id)s
                  AND lease_until >= %(now)s
                RETURNING *
                """,
                self._lease_parameters(
                    job,
                    worker_id,
                    renewal_time,
                    lease_until=renewal_time + LEASE_DURATION,
                ),
            ).fetchone()
        if row is None:
            raise LeaseLostError()
        return _job_from_row(row)

    def complete(
        self,
        job: IndexJob,
        worker_id: str,
        *,
        now: datetime | None = None,
    ) -> IndexJob:
        worker_id = _validate_worker_id(worker_id)
        completion_time = now or _utc_now()
        with self._pool.connection() as connection:
            row = connection.execute(
                """
                UPDATE visual_search_jobs
                SET status = 'complete',
                    leased_by = NULL,
                    lease_until = NULL,
                    last_error_code = NULL,
                    updated_at = %(now)s
                WHERE id = %(id)s
                  AND owner_id = %(owner_id)s
                  AND pattern_id = %(pattern_id)s
                  AND preview_asset_id = %(preview_asset_id)s
                  AND index_version = %(index_version)s
                  AND attempt_count = %(attempt_count)s
                  AND status = 'leased'
                  AND leased_by = %(worker_id)s
                  AND lease_until >= %(now)s
                RETURNING *
                """,
                self._lease_parameters(job, worker_id, completion_time),
            ).fetchone()
        if row is None:
            raise LeaseLostError()
        return _job_from_row(row)

    def fail(
        self,
        job: IndexJob,
        error_code: str,
        *,
        retryable: bool,
        worker_id: str,
        now: datetime | None = None,
    ) -> IndexJob:
        worker_id = _validate_worker_id(worker_id)
        error_code = _validate_error_code(error_code)
        failure_time = now or _utc_now()
        parameters = self._lease_parameters(job, worker_id, failure_time)
        parameters.update({"error_code": error_code, "retryable": retryable})

        with self._pool.connection() as connection:
            row = connection.execute(
                """
                UPDATE visual_search_jobs
                SET status = CASE
                      WHEN NOT %(retryable)s OR attempt_count >= max_attempts
                        THEN 'failed'::visual_search_job_status
                      ELSE 'pending'::visual_search_job_status
                    END,
                    available_at = CASE
                      WHEN NOT %(retryable)s OR attempt_count >= max_attempts
                        THEN available_at
                      ELSE %(now)s + make_interval(
                        secs => LEAST(
                          %(max_delay)s,
                          (30 * power(2, attempt_count - 1))::integer
                        )
                      )
                    END,
                    leased_by = NULL,
                    lease_until = NULL,
                    last_error_code = %(error_code)s,
                    updated_at = %(now)s
                WHERE id = %(id)s
                  AND owner_id = %(owner_id)s
                  AND pattern_id = %(pattern_id)s
                  AND preview_asset_id = %(preview_asset_id)s
                  AND index_version = %(index_version)s
                  AND attempt_count = %(attempt_count)s
                  AND status = 'leased'
                  AND leased_by = %(worker_id)s
                  AND lease_until >= %(now)s
                RETURNING *
                """,
                {**parameters, "max_delay": MAX_RETRY_DELAY_SECONDS},
            ).fetchone()
        if row is None:
            raise LeaseLostError()
        return _job_from_row(row)

    def heartbeat_worker(
        self,
        worker_id: str,
        index_version: str,
        *,
        now: datetime | None = None,
    ) -> None:
        worker_id = _validate_worker_id(worker_id)
        heartbeat_time = now or _utc_now()
        with self._pool.connection() as connection:
            connection.execute(
                """
                INSERT INTO visual_search_workers (
                    worker_id, index_version, last_seen_at, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (worker_id) DO UPDATE
                SET index_version = EXCLUDED.index_version,
                    last_seen_at = EXCLUDED.last_seen_at,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    worker_id,
                    index_version,
                    heartbeat_time,
                    heartbeat_time,
                    heartbeat_time,
                ),
            )

    def delete_feature_if_unreferenced(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
        delete: Callable[[], None],
        *,
        owned_job: IndexJob | None = None,
        worker_id: str | None = None,
        now: datetime | None = None,
    ) -> bool:
        if (owned_job is None) != (worker_id is None):
            raise ValueError("owned_job and worker_id must be provided together")
        deletion_time = now or _utc_now()
        if worker_id is not None:
            worker_id = _validate_worker_id(worker_id)

        with self._pool.connection() as connection, connection.transaction():
            pattern = connection.execute(
                """
                SELECT id
                FROM patterns
                WHERE owner_id = %s AND id = %s
                FOR UPDATE
                """,
                (owner_id, pattern_id),
            ).fetchone()
            if pattern is None:
                return False

            live_jobs = connection.execute(
                """
                SELECT id, owner_id, pattern_id, preview_asset_id,
                       index_version, attempt_count, status, leased_by,
                       lease_until
                FROM visual_search_jobs
                WHERE owner_id = %s
                  AND pattern_id = %s
                  AND index_version = %s
                  AND status IN ('pending', 'leased')
                  AND (preview_hash IS NULL OR preview_hash = %s)
                FOR UPDATE
                """,
                (owner_id, pattern_id, index_version, preview_hash),
            ).fetchall()
            referenced = connection.execute(
                """
                SELECT id
                FROM visual_search_documents
                WHERE owner_id = %s
                  AND pattern_id = %s
                  AND index_version = %s
                  AND preview_hash = %s
                  AND local_feature_object_key IS NOT NULL
                FOR UPDATE
                """,
                (owner_id, pattern_id, index_version, preview_hash),
            ).fetchone()
            if referenced is not None:
                return False

            if live_jobs:
                if owned_job is None or len(live_jobs) != 1:
                    return False
                live = live_jobs[0]
                if (
                    live["id"] != owned_job.id
                    or live["owner_id"] != owned_job.owner_id
                    or live["pattern_id"] != owned_job.pattern_id
                    or live["preview_asset_id"] != owned_job.preview_asset_id
                    or live["index_version"] != owned_job.index_version
                    or live["attempt_count"] != owned_job.attempt_count
                    or live["status"] != "leased"
                    or live["leased_by"] != worker_id
                    or live["lease_until"] is None
                    or live["lease_until"] < deletion_time
                ):
                    return False

            delete()
            return True

    def get_current_preview(
        self,
        job: IndexJob,
        worker_id: str,
        *,
        now: datetime | None = None,
    ) -> PreviewAsset:
        worker_id = _validate_worker_id(worker_id)
        check_time = now or _utc_now()
        with self._pool.connection() as connection:
            job_row = connection.execute(
                """
                SELECT id
                FROM visual_search_jobs
                WHERE id = %(id)s
                  AND owner_id = %(owner_id)s
                  AND pattern_id = %(pattern_id)s
                  AND preview_asset_id = %(preview_asset_id)s
                  AND index_version = %(index_version)s
                  AND attempt_count = %(attempt_count)s
                  AND status = 'leased'
                  AND leased_by = %(worker_id)s
                  AND lease_until >= %(now)s
                """,
                self._lease_parameters(job, worker_id, check_time),
            ).fetchone()
            if job_row is None:
                raise LeaseLostError()
            row = connection.execute(
                """
                SELECT a.id, a.owner_id, a.pattern_id, a.object_key,
                       a.content_hash, a.size_bytes
                FROM patterns p
                JOIN assets a
                  ON a.owner_id = p.owner_id
                 AND a.pattern_id = p.id
                 AND a.id = %(preview_asset_id)s
                WHERE p.owner_id = %(owner_id)s
                  AND p.id = %(pattern_id)s
                  AND p.status NOT IN ('deleting', 'deleted')
                  AND p.preview_status IN ('ready', 'manual')
                  AND a.role = 'preview'
                """,
                {
                    "owner_id": job.owner_id,
                    "pattern_id": job.pattern_id,
                    "preview_asset_id": job.preview_asset_id,
                },
            ).fetchone()
        if row is None:
            raise PreviewUnavailableError()
        return PreviewAsset(
            id=row["id"],
            owner_id=row["owner_id"],
            pattern_id=row["pattern_id"],
            object_key=row["object_key"],
            content_hash=row["content_hash"],
            size_bytes=int(row["size_bytes"]),
        )

    def complete_if_ready(
        self,
        job: IndexJob,
        worker_id: str,
        *,
        preview_hash: str,
        preview_object_key: str,
        now: datetime | None = None,
    ) -> bool:
        worker_id = _validate_worker_id(worker_id)
        check_time = now or _utc_now()
        with self._pool.connection() as connection, connection.transaction():
            self._lock_current_preview(connection, job, preview_object_key)
            self._lock_lease(connection, job, worker_id, check_time)
            ready = connection.execute(
                """
                SELECT id
                FROM visual_search_documents
                WHERE owner_id = %s
                  AND pattern_id = %s
                  AND preview_asset_id = %s
                  AND index_version = %s
                  AND preview_hash = %s
                  AND status = 'ready'
                FOR UPDATE
                """,
                (
                    job.owner_id,
                    job.pattern_id,
                    job.preview_asset_id,
                    job.index_version,
                    preview_hash,
                ),
            ).fetchone()
            if ready is not None:
                self._complete_locked(
                    connection,
                    job,
                    worker_id,
                    preview_hash,
                    check_time,
                )
                return True
            updated = connection.execute(
                """
                UPDATE visual_search_jobs
                SET preview_hash = %s, updated_at = %s
                WHERE id = %s AND attempt_count = %s AND leased_by = %s
                RETURNING id
                """,
                (
                    preview_hash,
                    check_time,
                    job.id,
                    job.attempt_count,
                    worker_id,
                ),
            ).fetchone()
            if updated is None:
                raise LeaseLostError()
            return False

    def publish(
        self,
        job: IndexJob,
        worker_id: str,
        *,
        preview_hash: str,
        preview_object_key: str,
        width: int,
        height: int,
        phash: str,
        local_feature_object_key: str,
        embeddings: Sequence[EmbeddingRecord],
        now: datetime | None = None,
    ) -> PublicationResult:
        self._validate_publication(width, height, phash, embeddings)
        worker_id = _validate_worker_id(worker_id)
        publication_time = now or _utc_now()
        document_id = uuid4()
        phash_bits = f"{int(phash, 16):064b}"

        with self._pool.connection() as connection, connection.transaction():
            self._lock_current_preview(connection, job, preview_object_key)
            self._lock_lease(connection, job, worker_id, publication_time)
            ready = connection.execute(
                """
                SELECT id
                FROM visual_search_documents
                WHERE owner_id = %s
                  AND pattern_id = %s
                  AND preview_asset_id = %s
                  AND index_version = %s
                  AND preview_hash = %s
                  AND status = 'ready'
                FOR UPDATE
                """,
                (
                    job.owner_id,
                    job.pattern_id,
                    job.preview_asset_id,
                    job.index_version,
                    preview_hash,
                ),
            ).fetchone()
            if ready is not None:
                self._complete_locked(
                    connection,
                    job,
                    worker_id,
                    preview_hash,
                    publication_time,
                )
                return PublicationResult(replayed=True)

            document = connection.execute(
                """
                INSERT INTO visual_search_documents (
                    id, owner_id, pattern_id, preview_asset_id, preview_hash,
                    index_version, status, phash, width, height,
                    local_feature_object_key, attempt_count, last_error_code,
                    indexed_at, created_at, updated_at
                )
                VALUES (
                    %(id)s, %(owner_id)s, %(pattern_id)s,
                    %(preview_asset_id)s, %(preview_hash)s,
                    %(index_version)s, 'indexing', %(phash)s::bit(64),
                    %(width)s, %(height)s, %(object_key)s,
                    %(attempt_count)s, NULL, NULL, %(now)s, %(now)s
                )
                ON CONFLICT (owner_id, pattern_id, index_version, preview_hash)
                DO UPDATE SET
                    preview_asset_id = EXCLUDED.preview_asset_id,
                    status = 'indexing',
                    phash = EXCLUDED.phash,
                    width = EXCLUDED.width,
                    height = EXCLUDED.height,
                    local_feature_object_key = EXCLUDED.local_feature_object_key,
                    attempt_count = EXCLUDED.attempt_count,
                    last_error_code = NULL,
                    indexed_at = NULL,
                    updated_at = EXCLUDED.updated_at
                RETURNING id
                """,
                {
                    "id": document_id,
                    "owner_id": job.owner_id,
                    "pattern_id": job.pattern_id,
                    "preview_asset_id": job.preview_asset_id,
                    "preview_hash": preview_hash,
                    "index_version": job.index_version,
                    "phash": phash_bits,
                    "width": width,
                    "height": height,
                    "object_key": local_feature_object_key,
                    "attempt_count": job.attempt_count,
                    "now": publication_time,
                },
            ).fetchone()
            if document is None:
                raise RuntimeError("INDEX_DOCUMENT_UPSERT_FAILED")
            active_document_id = document["id"]
            superseded = connection.execute(
                """
                UPDATE visual_search_documents
                SET status = 'superseded',
                    local_feature_object_key = NULL,
                    updated_at = %s
                WHERE owner_id = %s
                  AND pattern_id = %s
                  AND index_version = %s
                  AND status = 'ready'
                  AND id <> %s
                RETURNING preview_hash
                """,
                (
                    publication_time,
                    job.owner_id,
                    job.pattern_id,
                    job.index_version,
                    active_document_id,
                ),
            ).fetchall()
            connection.execute(
                "DELETE FROM visual_search_embeddings WHERE document_id = %s",
                (active_document_id,),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    """
                    INSERT INTO visual_search_embeddings (
                        document_id, owner_id, pattern_id, region_index,
                        region_kind, x, y, width, height, embedding
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        (
                            active_document_id,
                            job.owner_id,
                            job.pattern_id,
                            item.region_index,
                            item.region_kind,
                            item.x,
                            item.y,
                            item.width,
                            item.height,
                            item.embedding,
                        )
                        for item in embeddings
                    ],
                )
            published = connection.execute(
                """
                UPDATE visual_search_documents
                SET status = 'ready', indexed_at = %s, updated_at = %s
                WHERE id = %s
                  AND owner_id = %s
                  AND pattern_id = %s
                  AND status = 'indexing'
                RETURNING id
                """,
                (
                    publication_time,
                    publication_time,
                    active_document_id,
                    job.owner_id,
                    job.pattern_id,
                ),
            ).fetchone()
            if published is None:
                raise RuntimeError("INDEX_DOCUMENT_PUBLICATION_FAILED")
            self._complete_locked(
                connection,
                job,
                worker_id,
                preview_hash,
                publication_time,
            )
            return PublicationResult(
                replayed=False,
                superseded_hashes=tuple(row["preview_hash"] for row in superseded),
            )

    @staticmethod
    def _validate_publication(
        width: int,
        height: int,
        phash: str,
        embeddings: Sequence[EmbeddingRecord],
    ) -> None:
        if width <= 0 or height <= 0 or not re.fullmatch(r"[0-9a-f]{16}", phash):
            raise ValueError("invalid publication metadata")
        if len(embeddings) != 10:
            raise ValueError("publication requires exactly ten embeddings")
        for index, item in enumerate(embeddings):
            if (
                item.region_index != index
                or item.region_kind != ("global" if index == 0 else "tile")
                or item.embedding.dtype != np.float32
                or item.embedding.shape != (384,)
                or not np.isfinite(item.embedding).all()
                or not all(
                    np.isfinite(value)
                    for value in (item.x, item.y, item.width, item.height)
                )
            ):
                raise ValueError("invalid publication embedding")

    def _lock_lease(
        self,
        connection: psycopg.Connection[dict[str, Any]],
        job: IndexJob,
        worker_id: str,
        now: datetime,
    ) -> None:
        row = connection.execute(
            """
            SELECT id
            FROM visual_search_jobs
            WHERE id = %(id)s
              AND owner_id = %(owner_id)s
              AND pattern_id = %(pattern_id)s
              AND preview_asset_id = %(preview_asset_id)s
              AND index_version = %(index_version)s
              AND attempt_count = %(attempt_count)s
              AND status = 'leased'
              AND leased_by = %(worker_id)s
              AND lease_until >= %(now)s
            FOR UPDATE
            """,
            self._lease_parameters(job, worker_id, now),
        ).fetchone()
        if row is None:
            raise LeaseLostError()

    @staticmethod
    def _lock_current_preview(
        connection: psycopg.Connection[dict[str, Any]],
        job: IndexJob,
        preview_object_key: str,
    ) -> None:
        pattern = connection.execute(
            """
            SELECT id
            FROM patterns
            WHERE owner_id = %s
              AND id = %s
              AND status NOT IN ('deleting', 'deleted')
              AND preview_status IN ('ready', 'manual')
            FOR UPDATE
            """,
            (
                job.owner_id,
                job.pattern_id,
            ),
        ).fetchone()
        if pattern is None:
            raise PreviewUnavailableError()
        preview = connection.execute(
            """
            SELECT id
            FROM assets
            WHERE owner_id = %s
              AND pattern_id = %s
              AND id = %s
              AND role = 'preview'
              AND object_key = %s
            FOR UPDATE
            """,
            (
                job.owner_id,
                job.pattern_id,
                job.preview_asset_id,
                preview_object_key,
            ),
        ).fetchone()
        if preview is None:
            raise PreviewUnavailableError()

    def _complete_locked(
        self,
        connection: psycopg.Connection[dict[str, Any]],
        job: IndexJob,
        worker_id: str,
        preview_hash: str,
        now: datetime,
    ) -> None:
        completed = connection.execute(
            """
            UPDATE visual_search_jobs
            SET status = 'complete',
                preview_hash = %s,
                leased_by = NULL,
                lease_until = NULL,
                last_error_code = NULL,
                updated_at = %s
            WHERE id = %s
              AND owner_id = %s
              AND pattern_id = %s
              AND preview_asset_id = %s
              AND index_version = %s
              AND attempt_count = %s
              AND status = 'leased'
              AND leased_by = %s
            RETURNING id
            """,
            (
                preview_hash,
                now,
                job.id,
                job.owner_id,
                job.pattern_id,
                job.preview_asset_id,
                job.index_version,
                job.attempt_count,
                worker_id,
            ),
        ).fetchone()
        if completed is None:
            raise LeaseLostError()

    @staticmethod
    def _lease_parameters(
        job: IndexJob,
        worker_id: str,
        now: datetime,
        *,
        lease_until: datetime | None = None,
    ) -> dict[str, object]:
        values: dict[str, object] = {
            "id": job.id,
            "owner_id": job.owner_id,
            "pattern_id": job.pattern_id,
            "preview_asset_id": job.preview_asset_id,
            "index_version": job.index_version,
            "attempt_count": job.attempt_count,
            "worker_id": worker_id,
            "now": now,
        }
        if lease_until is not None:
            values["lease_until"] = lease_until
        return values
