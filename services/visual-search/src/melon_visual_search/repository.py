from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import partial
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import numpy.typing as npt
import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .palette_search import (
    PaletteCandidate,
    PaletteDataError,
    StoredPaletteColor,
    validate_palette_candidate,
)

LEASE_DURATION = timedelta(minutes=5)
HEARTBEAT_INTERVAL_SECONDS = 15
MAX_RETRY_DELAY_SECONDS = 3600
DATABASE_POOL_TIMEOUT_SECONDS = 5.0
DATABASE_STATEMENT_TIMEOUT_SECONDS = 10.0
MAX_ALLOWED_PATTERN_IDS = 10_000
MAX_RECALL_ROWS_PER_VECTOR = 100
MAX_RECALL_CANDIDATES = 50
EXACT_RECALL_PATTERN_LIMIT = 500
MAX_BENCHMARK_PATTERN_COUNT = 1_000

_ERROR_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
_INDEX_VERSION_PATTERN = re.compile(r"^[a-z0-9-]{1,64}$")
_PGVECTOR_VERSION_PATTERN = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
MINIMUM_PGVECTOR_VERSION = (0, 8, 0)


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
class PaletteColorRecord:
    color_index: int
    display_hex: str
    oklab: tuple[float, float, float]
    coverage: float


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


@dataclass(frozen=True)
class RecallCandidate:
    document_id: UUID
    owner_id: UUID
    pattern_id: UUID
    index_version: str
    preview_hash: str
    phash: str
    best_visual: float
    global_visual: float


@dataclass(frozen=True)
class ReadyPreview:
    pattern_id: UUID
    object_key: str


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def validate_pgvector_version(value: object) -> tuple[int, int, int]:
    if not isinstance(value, str):
        raise RuntimeError("PGVECTOR_VERSION_UNSUPPORTED")
    match = _PGVECTOR_VERSION_PATTERN.fullmatch(value)
    if match is None:
        raise RuntimeError("PGVECTOR_VERSION_UNSUPPORTED")
    major, minor, patch = (int(part) for part in match.groups())
    parsed = (major, minor, patch)
    if parsed < MINIMUM_PGVECTOR_VERSION:
        raise RuntimeError("PGVECTOR_VERSION_UNSUPPORTED")
    return parsed


def _configure_connection(
    connection: psycopg.Connection[Any],
    *,
    statement_timeout_ms: int,
) -> None:
    register_vector(connection)
    connection.execute(f"SET statement_timeout = '{statement_timeout_ms}ms'")


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
            },
            configure=partial(
                _configure_connection,
                statement_timeout_ms=statement_timeout_ms,
            ),
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

    def require_pgvector_compatible(self) -> tuple[int, int, int]:
        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
            ).fetchone()
        if row is None:
            raise RuntimeError("PGVECTOR_VERSION_UNSUPPORTED")
        return validate_pgvector_version(row["extversion"])

    def has_ready_documents(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        allowed_pattern_ids: Sequence[UUID],
    ) -> bool:
        allowed_ids = self._validate_recall_scope(
            owner_id,
            index_version,
            allowed_pattern_ids,
        )
        if not allowed_ids:
            return False
        with self._pool.connection() as connection:
            row = connection.execute(
                """
                SELECT 1
                FROM visual_search_documents
                WHERE owner_id = %s
                  AND index_version = %s
                  AND status = 'ready'
                  AND pattern_id = ANY(%s::uuid[])
                LIMIT 1
                """,
                (owner_id, index_version, list(allowed_ids)),
            ).fetchone()
        return row is not None

    def list_ready_palettes(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        allowed_pattern_ids: Sequence[UUID],
    ) -> tuple[PaletteCandidate, ...]:
        allowed_ids = self._validate_recall_scope(
            owner_id,
            index_version,
            allowed_pattern_ids,
        )
        if not allowed_ids:
            return ()
        with self._pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT d.id AS document_id, d.pattern_id,
                       p.color_index, p.display_hex,
                       p.oklab_l, p.oklab_a, p.oklab_b, p.coverage
                FROM visual_search_documents d
                LEFT JOIN visual_search_palette_colors p
                  ON p.document_id = d.id
                 AND p.owner_id = d.owner_id
                 AND p.pattern_id = d.pattern_id
                WHERE d.owner_id = %(owner_id)s
                  AND d.index_version = %(index_version)s
                  AND d.status = 'ready'
                  AND d.pattern_id = ANY(%(allowed_ids)s::uuid[])
                ORDER BY d.pattern_id, p.color_index
                """,
                {
                    "owner_id": owner_id,
                    "index_version": index_version,
                    "allowed_ids": list(allowed_ids),
                },
            ).fetchall()

        grouped: dict[UUID, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(row["pattern_id"], []).append(row)

        candidates: list[PaletteCandidate] = []
        for pattern_id, palette_rows in grouped.items():
            if [row["color_index"] for row in palette_rows] != list(
                range(len(palette_rows))
            ):
                raise PaletteDataError()
            try:
                colors = tuple(
                    StoredPaletteColor(
                        display_hex=row["display_hex"],
                        oklab=(
                            float(row["oklab_l"]),
                            float(row["oklab_a"]),
                            float(row["oklab_b"]),
                        ),
                        coverage=float(row["coverage"]),
                    )
                    for row in palette_rows
                )
            except (TypeError, ValueError) as error:
                raise PaletteDataError() from error
            candidates.append(
                validate_palette_candidate(
                    PaletteCandidate(pattern_id=pattern_id, colors=colors)
                )
            )
        candidates.sort(key=lambda candidate: str(candidate.pattern_id))
        return tuple(candidates)

    def sample_ready_previews(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        count: int,
        seed: int,
    ) -> tuple[ReadyPreview, ...]:
        self._validate_recall_scope(owner_id, index_version, ())
        if (
            not isinstance(count, int)
            or isinstance(count, bool)
            or not 1 <= count <= MAX_BENCHMARK_PATTERN_COUNT
        ):
            raise ValueError("count is outside the supported benchmark range")
        if not isinstance(seed, int) or isinstance(seed, bool):
            raise ValueError("seed must be an integer")

        with self._pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT d.pattern_id, a.object_key
                FROM visual_search_documents d
                JOIN patterns p
                  ON p.owner_id = d.owner_id
                 AND p.id = d.pattern_id
                JOIN assets a
                  ON a.owner_id = d.owner_id
                 AND a.pattern_id = d.pattern_id
                 AND a.id = d.preview_asset_id
                WHERE d.owner_id = %(owner_id)s
                  AND d.index_version = %(index_version)s
                  AND d.status = 'ready'
                  AND p.status NOT IN ('trashed', 'deleting', 'deleted')
                  AND p.preview_status IN ('ready', 'manual')
                  AND a.role = 'preview'
                ORDER BY md5(d.pattern_id::text || ':' || %(seed)s::text),
                         d.pattern_id
                LIMIT %(count)s
                """,
                {
                    "owner_id": owner_id,
                    "index_version": index_version,
                    "seed": seed,
                    "count": count,
                },
            ).fetchall()
        return tuple(
            ReadyPreview(
                pattern_id=row["pattern_id"],
                object_key=row["object_key"],
            )
            for row in rows
        )

    def recall_candidates(
        self,
        *,
        owner_id: UUID,
        index_version: str,
        allowed_pattern_ids: Sequence[UUID],
        query_vectors: npt.NDArray[np.float32],
    ) -> tuple[RecallCandidate, ...]:
        allowed_ids = self._validate_recall_scope(
            owner_id,
            index_version,
            allowed_pattern_ids,
        )
        vectors = self._validate_query_vectors(query_vectors)
        if not allowed_ids:
            return ()

        exact = len(allowed_ids) <= EXACT_RECALL_PATTERN_LIMIT
        merged: dict[UUID, dict[str, Any]] = {}
        with self._pool.connection() as connection, connection.transaction():
            if not exact:
                connection.execute("SET LOCAL hnsw.ef_search = 100")
                connection.execute(
                    "SET LOCAL hnsw.iterative_scan = 'relaxed_order'"
                )
            for vector in vectors:
                rows = connection.execute(
                    self._exact_recall_sql() if exact else self._hnsw_recall_sql(),
                    {
                        "owner_id": owner_id,
                        "index_version": index_version,
                        "allowed_ids": list(allowed_ids),
                        "query_vector": vector,
                        "limit": MAX_RECALL_ROWS_PER_VECTOR,
                    },
                ).fetchall()
                for row in rows:
                    pattern_id = row["pattern_id"]
                    similarity = min(1.0, max(-1.0, float(row["similarity"])))
                    current = merged.get(pattern_id)
                    if current is None:
                        bits = row["phash"]
                        if (
                            not isinstance(bits, str)
                            or len(bits) != 64
                            or set(bits) - {"0", "1"}
                        ):
                            raise RuntimeError("IMAGE_SEARCH_DOCUMENT_INVALID")
                        current = {
                            "document_id": row["document_id"],
                            "owner_id": row["owner_id"],
                            "pattern_id": pattern_id,
                            "index_version": row["index_version"],
                            "preview_hash": row["preview_hash"],
                            "phash": f"{int(bits, 2):016x}",
                            "best_visual": similarity,
                            "global_visual": 0.0,
                        }
                        merged[pattern_id] = current
                    else:
                        current["best_visual"] = max(
                            float(current["best_visual"]),
                            similarity,
                        )
            candidate_values = sorted(
                merged.values(),
                key=lambda values: (
                    -float(values["best_visual"]),
                    str(values["pattern_id"]),
                ),
            )[:MAX_RECALL_CANDIDATES]
            if candidate_values:
                global_rows = connection.execute(
                    self._global_similarity_sql(),
                    {
                        "owner_id": owner_id,
                        "index_version": index_version,
                        "candidate_ids": [
                            values["pattern_id"] for values in candidate_values
                        ],
                        "query_vector": vectors[0],
                    },
                ).fetchall()
                global_similarities = {
                    row["pattern_id"]: min(
                        1.0,
                        max(-1.0, float(row["similarity"])),
                    )
                    for row in global_rows
                }
                if len(global_similarities) != len(candidate_values):
                    raise RuntimeError("IMAGE_SEARCH_DOCUMENT_INVALID")
                for values in candidate_values:
                    values["global_visual"] = global_similarities[
                        values["pattern_id"]
                    ]

        candidates = [RecallCandidate(**values) for values in candidate_values]
        candidates.sort(
            key=lambda candidate: (
                -candidate.best_visual,
                -candidate.global_visual,
                str(candidate.pattern_id),
            )
        )
        return tuple(candidates)

    @staticmethod
    def _validate_recall_scope(
        owner_id: UUID,
        index_version: str,
        allowed_pattern_ids: Sequence[UUID],
    ) -> tuple[UUID, ...]:
        if not isinstance(owner_id, UUID):
            raise ValueError("owner_id must be a UUID")
        if not isinstance(index_version, str) or not _INDEX_VERSION_PATTERN.fullmatch(
            index_version
        ):
            raise ValueError("index_version must be canonical")
        if len(allowed_pattern_ids) > MAX_ALLOWED_PATTERN_IDS:
            raise ValueError("allowed_pattern_ids exceeds the supported limit")
        if any(not isinstance(pattern_id, UUID) for pattern_id in allowed_pattern_ids):
            raise ValueError("allowed_pattern_ids must contain UUID values")
        return tuple(dict.fromkeys(allowed_pattern_ids))

    @staticmethod
    def _validate_query_vectors(
        query_vectors: object,
    ) -> npt.NDArray[np.float32]:
        if (
            not isinstance(query_vectors, np.ndarray)
            or query_vectors.dtype != np.float32
            or query_vectors.shape != (10, 384)
            or not np.isfinite(query_vectors).all()
        ):
            raise ValueError("query_vectors must be a finite float32 (10, 384) array")
        norms = np.linalg.norm(query_vectors, axis=1)
        if not np.allclose(norms, np.ones(10), rtol=1e-5, atol=1e-6):
            raise ValueError("query_vectors must be L2 normalized")
        return np.ascontiguousarray(query_vectors, dtype=np.float32)

    @staticmethod
    def _exact_recall_sql() -> str:
        return """
            WITH filtered AS MATERIALIZED (
              SELECT d.id AS document_id, d.owner_id, d.pattern_id,
                     d.index_version, d.preview_hash, d.phash,
                     e.region_index, e.embedding
              FROM visual_search_documents d
              JOIN visual_search_embeddings e
                ON e.document_id = d.id
               AND e.owner_id = d.owner_id
               AND e.pattern_id = d.pattern_id
              WHERE d.owner_id = %(owner_id)s
                AND d.index_version = %(index_version)s
                AND d.status = 'ready'
                AND d.pattern_id = ANY(%(allowed_ids)s::uuid[])
            )
            SELECT document_id, owner_id, pattern_id, index_version,
                   preview_hash, phash::text AS phash, region_index,
                   1.0 - (embedding <=> %(query_vector)s) AS similarity
            FROM filtered
            ORDER BY embedding <=> %(query_vector)s, pattern_id, region_index
            LIMIT %(limit)s
        """

    @staticmethod
    def _hnsw_recall_sql() -> str:
        return """
            SELECT d.id AS document_id, d.owner_id, d.pattern_id,
                   d.index_version, d.preview_hash, d.phash::text AS phash,
                   e.region_index,
                   1.0 - (e.embedding <=> %(query_vector)s) AS similarity
            FROM visual_search_embeddings e
            JOIN visual_search_documents d
              ON d.id = e.document_id
             AND d.owner_id = e.owner_id
             AND d.pattern_id = e.pattern_id
            WHERE d.owner_id = %(owner_id)s
              AND d.index_version = %(index_version)s
              AND d.status = 'ready'
              AND d.pattern_id = ANY(%(allowed_ids)s::uuid[])
            ORDER BY e.embedding <=> %(query_vector)s
            LIMIT %(limit)s
        """

    @staticmethod
    def _global_similarity_sql() -> str:
        return """
            SELECT d.pattern_id,
                   1.0 - (e.embedding <=> %(query_vector)s) AS similarity
            FROM visual_search_documents d
            JOIN visual_search_embeddings e
              ON e.document_id = d.id
             AND e.owner_id = d.owner_id
             AND e.pattern_id = d.pattern_id
             AND e.region_index = 0
            WHERE d.owner_id = %(owner_id)s
              AND d.index_version = %(index_version)s
              AND d.status = 'ready'
              AND d.pattern_id = ANY(%(candidate_ids)s::uuid[])
            ORDER BY d.pattern_id
        """

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
        palette: Sequence[PaletteColorRecord],
        now: datetime | None = None,
    ) -> PublicationResult:
        self._validate_publication(width, height, phash, embeddings, palette)
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
            connection.execute(
                "DELETE FROM visual_search_palette_colors WHERE document_id = %s",
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
                cursor.executemany(
                    """
                    INSERT INTO visual_search_palette_colors (
                        document_id, owner_id, pattern_id, color_index,
                        display_hex, oklab_l, oklab_a, oklab_b, coverage
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        (
                            active_document_id,
                            job.owner_id,
                            job.pattern_id,
                            item.color_index,
                            item.display_hex,
                            item.oklab[0],
                            item.oklab[1],
                            item.oklab[2],
                            item.coverage,
                        )
                        for item in palette
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
        palette: Sequence[PaletteColorRecord],
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
        if not 3 <= len(palette) <= 5:
            raise ValueError("publication palette requires three to five colors")
        if [color.color_index for color in palette] != list(range(len(palette))):
            raise ValueError("publication palette indexes must be consecutive")
        if len({color.display_hex for color in palette}) != len(palette):
            raise ValueError("publication palette colors must be unique")
        for color in palette:
            if (
                re.fullmatch(r"#[0-9A-F]{6}", color.display_hex) is None
                or len(color.oklab) != 3
                or not all(math.isfinite(value) for value in color.oklab)
                or not 0.0 <= color.oklab[0] <= 1.0
                or not -0.5 <= color.oklab[1] <= 0.5
                or not -0.5 <= color.oklab[2] <= 0.5
                or not math.isfinite(color.coverage)
                or not 0.0 < color.coverage <= 1.0
            ):
                raise ValueError("invalid publication palette color")
        if not math.isclose(
            math.fsum(color.coverage for color in palette),
            1.0,
            rel_tol=0.0,
            abs_tol=1e-5,
        ):
            raise ValueError("publication palette coverage must sum to one")

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
