from __future__ import annotations

import hashlib
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from threading import Event, Lock
from time import monotonic, sleep
from uuid import UUID, uuid4

import numpy as np
import psycopg
import pytest
from conftest import INDEX_VERSION, NOW, SeededJob, SeedFactory
from PIL import Image
from psycopg import sql

from melon_visual_search import cli
from melon_visual_search.embedding import IMAGE_SEARCH_MODEL_INVALID
from melon_visual_search.image_io import IMAGE_SEARCH_INVALID_FILE, ImageSearchError
from melon_visual_search.local_features import deserialize_local_features
from melon_visual_search.repository import (
    EmbeddingRecord,
    LeaseLostError,
    PreviewUnavailableError,
    Repository,
)
from melon_visual_search.settings import Settings
from melon_visual_search.storage import InMemoryStorage, build_derived_key
from melon_visual_search.worker import (
    CleanupRefusedError,
    IndexWorker,
    _is_retryable_database_error,
    assert_cleanup_database_allowed,
    cleanup_orphans,
)

FIXTURES = Path(__file__).parent / "fixtures"
PREVIEW_BYTES = (FIXTURES / "checker.png").read_bytes()


class DeterministicEmbedder:
    def __init__(self, callback: Callable[[], None] | None = None) -> None:
        self.calls = 0
        self._callback = callback

    def embed(self, regions):
        self.calls += 1
        assert len(regions) == 10
        if self._callback is not None:
            self._callback()
        vectors = np.zeros((10, 384), dtype=np.float32)
        for index in range(10):
            vectors[index, index] = 1.0
        return vectors


class ForbiddenEmbedder:
    def embed(self, regions):
        raise AssertionError("a ready fingerprint replay must not run inference")


class ManualClock:
    def __init__(self, current: datetime) -> None:
        self._current = current
        self._lock = Lock()

    def __call__(self) -> datetime:
        with self._lock:
            return self._current

    def set(self, current: datetime) -> None:
        with self._lock:
            self._current = current


class TemporaryFailureEmbedder:
    def __init__(self, clock: ManualClock, failure_time: datetime) -> None:
        self._clock = clock
        self._failure_time = failure_time

    def embed(self, regions):
        self._clock.set(self._failure_time)
        raise OSError("temporary inference transport failure")


class InvalidDimensionsEmbedder:
    def embed(self, regions):
        return np.zeros((10, 383), dtype=np.float32)


class ModelChecksumFailureEmbedder:
    def embed(self, regions):
        raise ImageSearchError(
            IMAGE_SEARCH_MODEL_INVALID,
            "model artifact checksum does not match the lock",
        )


class TemporaryWriteFailureStorage(InMemoryStorage):
    def write_features(self, *args, **kwargs):
        raise OSError("temporary OSS failure")


class PausingFirstWriteStorage(InMemoryStorage):
    def __init__(self, uploaded: Event, release: Event) -> None:
        super().__init__()
        self._uploaded = uploaded
        self._release = release

    def write_features(self, *args, **kwargs):
        result = super().write_features(*args, **kwargs)
        if result.created and not self._uploaded.is_set():
            self._uploaded.set()
            if not self._release.wait(5):
                raise TimeoutError("first upload barrier timed out")
        return result


def small_png_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (95, 96), color=(255, 255, 255)).save(output, format="PNG")
    return output.getvalue()


def seed_preview(storage: InMemoryStorage, job: SeededJob, payload: bytes = PREVIEW_BYTES) -> None:
    storage.seed_preview(job.preview_object_key, payload, last_modified=NOW)


def vector_literal(index: int) -> str:
    values = ["0"] * 384
    values[index % 384] = "1"
    return "[" + ",".join(values) + "]"


def publication_embeddings() -> tuple[EmbeddingRecord, ...]:
    vectors = DeterministicEmbedder().embed([object()] * 10)
    return tuple(
        EmbeddingRecord(
            region_index=index,
            region_kind="global" if index == 0 else "tile",
            x=0.0,
            y=0.0,
            width=1.0,
            height=1.0,
            embedding=vectors[index],
        )
        for index in range(10)
    )


def publish_claimed_job(
    repository: Repository,
    job,
    seeded: SeededJob,
    *,
    worker_id: str,
):
    preview_hash = hashlib.sha256(PREVIEW_BYTES).hexdigest()
    return repository.publish(
        job,
        worker_id,
        preview_hash=preview_hash,
        preview_object_key=seeded.preview_object_key,
        width=512,
        height=512,
        phash="0" * 16,
        local_feature_object_key=build_derived_key(
            seeded.owner_id,
            seeded.pattern_id,
            INDEX_VERSION,
            preview_hash,
        ),
        embeddings=publication_embeddings(),
        now=NOW,
    )


def wait_for_lock_waiter(
    database_url: str,
    *,
    waiter_pid: int | None = None,
    blocker_pid: int | None = None,
) -> None:
    deadline = monotonic() + 5
    with psycopg.connect(database_url, autocommit=True) as monitor:
        while monotonic() < deadline:
            row = monitor.execute(
                """
                SELECT pid
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock'
                  AND (%s::integer IS NULL OR pid = %s)
                  AND (
                    %s::integer IS NULL
                    OR %s = ANY(pg_blocking_pids(pid))
                  )
                LIMIT 1
                """,
                (waiter_pid, waiter_pid, blocker_pid, blocker_pid),
            ).fetchone()
            if row is not None:
                return
            sleep(0.01)
    raise AssertionError("database session did not reach the expected lock wait")


def seed_ready_document(
    database_url: str,
    job: SeededJob,
    *,
    preview_hash: str,
    object_key: str,
) -> UUID:
    document_id = uuid4()
    with psycopg.connect(database_url) as connection:
        connection.execute(
            """
            INSERT INTO visual_search_documents (
                id, owner_id, pattern_id, preview_asset_id, preview_hash,
                index_version, status, phash, width, height,
                local_feature_object_key, attempt_count, indexed_at,
                created_at, updated_at
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, 'ready', %s::bit(64),
                512, 512, %s, 1, %s, %s, %s
            )
            """,
            (
                document_id,
                job.owner_id,
                job.pattern_id,
                job.preview_asset_id,
                preview_hash,
                job.index_version,
                "0" * 64,
                object_key,
                NOW,
                NOW,
                NOW,
            ),
        )
        for index in range(10):
            connection.execute(
                """
                INSERT INTO visual_search_embeddings (
                    document_id, owner_id, pattern_id, region_index,
                    region_kind, x, y, width, height, embedding
                )
                VALUES (
                    %s, %s, %s, %s, %s, 0, 0, 1, 1, %s::vector
                )
                """,
                (
                    document_id,
                    job.owner_id,
                    job.pattern_id,
                    index,
                    "global" if index == 0 else "tile",
                    vector_literal(index),
                ),
            )
    return document_id


@contextmanager
def reject_ready_publications(
    database_url: str,
    *,
    sqlstate: str = "40001",
) -> Iterator[None]:
    suffix = uuid4().hex
    function_name = f"test_reject_ready_{suffix}"
    trigger_name = f"test_reject_ready_trigger_{suffix}"
    with psycopg.connect(database_url, autocommit=True) as connection:
        connection.execute(
            sql.SQL(
                """
                CREATE FUNCTION {}() RETURNS trigger AS $$
                BEGIN
                  IF NEW.status = 'ready' THEN
                    RAISE EXCEPTION 'forced publication failure'
                      USING ERRCODE = {};
                  END IF;
                  RETURN NEW;
                END;
                $$ LANGUAGE plpgsql
                """
            ).format(sql.Identifier(function_name), sql.Literal(sqlstate))
        )
        connection.execute(
            sql.SQL(
                """
                CREATE TRIGGER {}
                BEFORE INSERT OR UPDATE ON visual_search_documents
                FOR EACH ROW EXECUTE FUNCTION {}()
                """
            ).format(sql.Identifier(trigger_name), sql.Identifier(function_name))
        )
    try:
        yield
    finally:
        with psycopg.connect(database_url, autocommit=True) as connection:
            connection.execute(
                sql.SQL("DROP TRIGGER IF EXISTS {} ON visual_search_documents").format(
                    sql.Identifier(trigger_name)
                )
            )
            connection.execute(
                sql.SQL("DROP FUNCTION IF EXISTS {}()").format(
                    sql.Identifier(function_name)
                )
            )


def test_worker_publishes_one_document_and_exactly_ten_vectors(
    repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    embedder = DeterministicEmbedder()
    worker = IndexWorker(
        repository,
        storage,
        embedder,
        worker_id="worker-success",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    assert outcome == "completed"
    preview_hash = hashlib.sha256(PREVIEW_BYTES).hexdigest()
    expected_key = build_derived_key(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        preview_hash,
    )
    with psycopg.connect(database_url) as connection:
        job_row = connection.execute(
            "SELECT status, attempt_count, preview_hash FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()
        document_row = connection.execute(
            """
            SELECT status, preview_hash, width, height, local_feature_object_key
            FROM visual_search_documents
            WHERE owner_id = %s AND pattern_id = %s
            """,
            (seeded_job.owner_id, seeded_job.pattern_id),
        ).fetchone()
        embedding_row = connection.execute(
            """
            SELECT count(*)::int,
                   min(region_index), max(region_index),
                   count(*) FILTER (WHERE region_kind = 'global')::int,
                   count(*) FILTER (WHERE region_kind = 'tile')::int,
                   min(vector_dims(embedding)), max(vector_dims(embedding))
            FROM visual_search_embeddings
            WHERE owner_id = %s AND pattern_id = %s
            """,
            (seeded_job.owner_id, seeded_job.pattern_id),
        ).fetchone()

    assert job_row == ("complete", 1, preview_hash)
    assert document_row == ("ready", preview_hash, 512, 512, expected_key)
    assert embedding_row == (10, 0, 9, 1, 9, 384, 384)
    assert embedder.calls == 1
    assert expected_key in storage.object_keys
    local = deserialize_local_features(
        storage.read_features(
            seeded_job.owner_id,
            seeded_job.pattern_id,
            INDEX_VERSION,
            preview_hash,
        )
    )
    assert len(local.phash) == 16
    assert local.keypoints.shape[0] <= 256


@pytest.mark.parametrize(
    "error",
    [
        psycopg.OperationalError("connection closed"),
        psycopg.errors.ConnectionFailure("connection failed"),
        psycopg.errors.SerializationFailure("serialization failed"),
        psycopg.errors.DeadlockDetected("deadlock detected"),
        psycopg.errors.DiskFull("database resource exhausted"),
        psycopg.errors.LockNotAvailable("lock unavailable"),
        psycopg.errors.QueryCanceled("statement timeout"),
        psycopg.errors.AdminShutdown("database stopping"),
        psycopg.errors.CrashShutdown("database crashed"),
        psycopg.errors.CannotConnectNow("database starting"),
    ],
)
def test_temporary_database_errors_are_retryable(error: psycopg.Error) -> None:
    assert _is_retryable_database_error(error)


@pytest.mark.parametrize(
    "error",
    [
        psycopg.errors.CheckViolation("constraint violated"),
        psycopg.errors.UniqueViolation("duplicate row"),
        psycopg.errors.UndefinedTable("schema mismatch"),
        psycopg.errors.InvalidTextRepresentation("invalid database value"),
        psycopg.InterfaceError("invalid client operation"),
    ],
)
def test_permanent_database_errors_are_not_retryable(error: psycopg.Error) -> None:
    assert not _is_retryable_database_error(error)


def test_temporary_publication_failure_deletes_new_object_and_retries(
    repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-rollback",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    with reject_ready_publications(database_url):
        outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        job_row = connection.execute(
            "SELECT status, attempt_count, available_at FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()
        document_count = connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0]
    assert outcome == "retried"
    assert job_row == ("pending", 1, NOW.replace() + worker.retry_delay(1))
    assert document_count == 0
    assert storage.object_keys == (seeded_job.preview_object_key,)


def test_permanent_publication_failure_deletes_new_object_and_is_terminal(
    repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-permanent-database-failure",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    with reject_ready_publications(database_url, sqlstate="23514"):
        outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        job_row = connection.execute(
            """
            SELECT status, attempt_count, last_error_code
            FROM visual_search_jobs
            WHERE id = %s
            """,
            (seeded_job.id,),
        ).fetchone()
        document_count = connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0]
    assert outcome == "failed"
    assert job_row == ("failed", 1, "INDEX_DATABASE_PERMANENT_FAILURE")
    assert document_count == 0
    assert storage.object_keys == (seeded_job.preview_object_key,)


def test_stale_worker_cannot_delete_features_published_by_the_new_lease_owner(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    uploaded = Event()
    release_stale_worker = Event()
    clock = ManualClock(NOW)
    storage = PausingFirstWriteStorage(uploaded, release_stale_worker)
    seed_preview(storage, seeded_job)
    stale_worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-stale-uploader",
        index_version=INDEX_VERSION,
        heartbeat_interval_seconds=3600,
        clock=clock,
    )
    current_worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-current-publisher",
        index_version=INDEX_VERSION,
        heartbeat_interval_seconds=3600,
        clock=clock,
    )

    with ThreadPoolExecutor(max_workers=1) as executor:
        stale_result = executor.submit(stale_worker.run_once)
        assert uploaded.wait(5)
        clock.set(NOW + timedelta(minutes=6))
        assert current_worker.run_once() == "completed"
        release_stale_worker.set()
        assert stale_result.result(timeout=5) == "stale"

    preview_hash = hashlib.sha256(PREVIEW_BYTES).hexdigest()
    object_key = build_derived_key(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        preview_hash,
    )
    with psycopg.connect(database_url) as connection:
        document = connection.execute(
            """
            SELECT status, local_feature_object_key
            FROM visual_search_documents
            WHERE owner_id = %s AND pattern_id = %s
            """,
            (seeded_job.owner_id, seeded_job.pattern_id),
        ).fetchone()
    assert document == ("ready", object_key)
    assert object_key in storage.object_keys


def test_same_fingerprint_replay_completes_without_rewriting_features(
    repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    preview_hash = hashlib.sha256(PREVIEW_BYTES).hexdigest()
    job = seed_factory.job(preview_hash=preview_hash)
    storage = InMemoryStorage()
    seed_preview(storage, job)
    object_key = build_derived_key(
        job.owner_id,
        job.pattern_id,
        INDEX_VERSION,
        preview_hash,
    )
    document_id = seed_ready_document(
        database_url,
        job,
        preview_hash=preview_hash,
        object_key=object_key,
    )
    storage.write_features(
        job.owner_id,
        job.pattern_id,
        INDEX_VERSION,
        preview_hash,
        b"existing-features",
        now=NOW,
    )
    writes_before = storage.write_count
    worker = IndexWorker(
        repository,
        storage,
        ForbiddenEmbedder(),
        worker_id="worker-replay",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        rows = connection.execute(
            """
            SELECT d.id, d.status, count(e.region_index)::int
            FROM visual_search_documents d
            LEFT JOIN visual_search_embeddings e ON e.document_id = d.id
            WHERE d.owner_id = %s AND d.pattern_id = %s
            GROUP BY d.id, d.status
            """,
            (job.owner_id, job.pattern_id),
        ).fetchall()
    assert outcome == "completed"
    assert rows == [(document_id, "ready", 10)]
    assert storage.write_count == writes_before
    assert storage.read_features(
        job.owner_id,
        job.pattern_id,
        INDEX_VERSION,
        preview_hash,
    ) == b"existing-features"


def test_new_fingerprint_supersedes_ready_document_and_removes_old_object(
    repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    old_hash = "ab" * 32
    new_hash = hashlib.sha256(PREVIEW_BYTES).hexdigest()
    old_key = build_derived_key(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        old_hash,
    )
    old_document_id = seed_ready_document(
        database_url,
        seeded_job,
        preview_hash=old_hash,
        object_key=old_key,
    )
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    storage.write_features(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        old_hash,
        b"old-features",
        now=NOW,
    )
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-supersede",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        rows = connection.execute(
            """
            SELECT id, preview_hash, status, local_feature_object_key
            FROM visual_search_documents
            WHERE owner_id = %s AND pattern_id = %s
            ORDER BY preview_hash
            """,
            (seeded_job.owner_id, seeded_job.pattern_id),
        ).fetchall()
        new_embedding_count = connection.execute(
            """
            SELECT count(*)::int
            FROM visual_search_embeddings e
            JOIN visual_search_documents d ON d.id = e.document_id
            WHERE d.owner_id = %s AND d.pattern_id = %s AND d.preview_hash = %s
            """,
            (seeded_job.owner_id, seeded_job.pattern_id, new_hash),
        ).fetchone()[0]
    documents_by_hash = {row[1]: row for row in rows}
    assert outcome == "completed"
    assert documents_by_hash[old_hash] == (
        old_document_id,
        old_hash,
        "superseded",
        None,
    )
    assert documents_by_hash[new_hash][1:] == (
        new_hash,
        "ready",
        build_derived_key(
            seeded_job.owner_id,
            seeded_job.pattern_id,
            INDEX_VERSION,
            new_hash,
        ),
    )
    assert new_embedding_count == 10
    assert old_key not in storage.object_keys


def test_preview_replacement_during_inference_cannot_publish_stale_features(
    repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    replacement_id = uuid4()
    replacement_key = (
        f"users/{seeded_job.owner_id}/patterns/{seeded_job.pattern_id}/"
        f"derived/{replacement_id}.webp"
    )

    def replace_preview() -> None:
        with psycopg.connect(database_url) as connection:
            connection.execute(
                "DELETE FROM assets WHERE id = %s AND owner_id = %s AND pattern_id = %s",
                (
                    seeded_job.preview_asset_id,
                    seeded_job.owner_id,
                    seeded_job.pattern_id,
                ),
            )
            connection.execute(
                """
                INSERT INTO assets (
                    id, owner_id, pattern_id, role, object_key,
                    original_filename, detected_mime_type, size_bytes,
                    width, height
                )
                VALUES (%s, %s, %s, 'preview', %s, 'replacement.webp',
                        'image/webp', 1024, 512, 512)
                """,
                (
                    replacement_id,
                    seeded_job.owner_id,
                    seeded_job.pattern_id,
                    replacement_key,
                ),
            )

    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(replace_preview),
        worker_id="worker-preview-race",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        document_count = connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0]
        job_count = connection.execute(
            "SELECT count(*) FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()[0]
    assert outcome == "stale"
    assert document_count == 0
    assert job_count == 0
    assert storage.object_keys == (seeded_job.preview_object_key,)


def test_long_inference_renews_lease_and_publishes_with_current_time(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    clock = ManualClock(NOW)
    heartbeat_time = NOW + timedelta(seconds=15)
    worker_id = "worker-heartbeat"
    observed_renewal = Event()

    def wait_for_renewal() -> None:
        clock.set(heartbeat_time)
        deadline = monotonic() + 3
        while monotonic() < deadline:
            with psycopg.connect(database_url) as connection:
                job_row = connection.execute(
                    "SELECT lease_until FROM visual_search_jobs WHERE id = %s",
                    (seeded_job.id,),
                ).fetchone()
                worker_row = connection.execute(
                    """
                    SELECT last_seen_at
                    FROM visual_search_workers
                    WHERE worker_id = %s
                    """,
                    (worker_id,),
                ).fetchone()
            if (
                job_row == (heartbeat_time + timedelta(minutes=5),)
                and worker_row == (heartbeat_time,)
            ):
                observed_renewal.set()
                return
            sleep(0.01)
        raise AssertionError("worker did not renew its lease during inference")

    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(wait_for_renewal),
        worker_id=worker_id,
        index_version=INDEX_VERSION,
        heartbeat_interval_seconds=0.01,
        clock=clock,
    )

    outcome = worker.run_once()

    with psycopg.connect(database_url) as connection:
        document_time = connection.execute(
            """
            SELECT indexed_at
            FROM visual_search_documents
            WHERE owner_id = %s AND pattern_id = %s AND status = 'ready'
            """,
            (seeded_job.owner_id, seeded_job.pattern_id),
        ).fetchone()[0]
        job_time = connection.execute(
            "SELECT updated_at FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()[0]
    assert outcome == "completed"
    assert observed_renewal.is_set()
    assert document_time == heartbeat_time
    assert job_time == heartbeat_time


def test_retry_backoff_uses_failure_time_instead_of_claim_time(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    clock = ManualClock(NOW)
    failure_time = NOW + timedelta(minutes=2)
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        TemporaryFailureEmbedder(clock, failure_time),
        worker_id="worker-failure-clock",
        index_version=INDEX_VERSION,
        heartbeat_interval_seconds=3600,
        clock=clock,
    )

    outcome = worker.run_once()

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            SELECT status, available_at, updated_at, last_error_code
            FROM visual_search_jobs
            WHERE id = %s
            """,
            (seeded_job.id,),
        ).fetchone()
    assert outcome == "retried"
    assert row == (
        "pending",
        failure_time + timedelta(seconds=30),
        failure_time,
        "INDEX_TEMPORARY_FAILURE",
    )


def test_expired_lease_cannot_publish_using_the_claim_timestamp(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    clock = ManualClock(NOW)
    after_expiry = NOW + timedelta(minutes=6)
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(lambda: clock.set(after_expiry)),
        worker_id="worker-expired-during-inference",
        index_version=INDEX_VERSION,
        heartbeat_interval_seconds=3600,
        clock=clock,
    )

    outcome = worker.run_once()

    with psycopg.connect(database_url) as connection:
        job_row = connection.execute(
            """
            SELECT status, attempt_count, lease_until
            FROM visual_search_jobs
            WHERE id = %s
            """,
            (seeded_job.id,),
        ).fetchone()
        document_count = connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0]
    assert outcome == "stale"
    assert job_row == ("leased", 1, NOW + timedelta(minutes=5))
    assert document_count == 0
    assert storage.object_keys == (
        seeded_job.preview_object_key,
        build_derived_key(
            seeded_job.owner_id,
            seeded_job.pattern_id,
            INDEX_VERSION,
            hashlib.sha256(PREVIEW_BYTES).hexdigest(),
        ),
    )


@pytest.mark.parametrize("payload", [b"not-an-image", small_png_bytes()])
def test_invalid_preview_bytes_or_dimensions_are_terminal(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
    payload: bytes,
) -> None:
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job, payload)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-invalid-preview",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            SELECT status, attempt_count, last_error_code, leased_by, lease_until
            FROM visual_search_jobs
            WHERE id = %s
            """,
            (seeded_job.id,),
        ).fetchone()
        document_count = connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0]
    assert outcome == "failed"
    assert row == ("failed", 1, IMAGE_SEARCH_INVALID_FILE, None, None)
    assert document_count == 0
    assert storage.object_keys == (seeded_job.preview_object_key,)


def test_foreign_preview_key_is_terminal_without_reading_the_object(
    repository: Repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    owner_id = uuid4()
    pattern_id = uuid4()
    asset_id = uuid4()
    foreign_owner_id = uuid4()
    foreign_key = (
        f"users/{foreign_owner_id}/patterns/{pattern_id}/derived/{asset_id}.webp"
    )
    job = seed_factory.job(
        owner_id=owner_id,
        pattern_id=pattern_id,
        preview_asset_id=asset_id,
        preview_object_key=foreign_key,
    )
    storage = InMemoryStorage()
    storage.seed_preview(foreign_key, PREVIEW_BYTES, last_modified=NOW)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-foreign-preview-key",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT status, last_error_code FROM visual_search_jobs WHERE id = %s",
            (job.id,),
        ).fetchone()
    assert outcome == "failed"
    assert row == ("failed", "INDEX_STORAGE_KEY_INVALID")
    assert storage.write_count == 0


def test_missing_preview_object_is_terminal(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    worker = IndexWorker(
        repository,
        InMemoryStorage(),
        DeterministicEmbedder(),
        worker_id="worker-missing-preview",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT status, last_error_code FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()
    assert outcome == "failed"
    assert row == ("failed", "INDEX_PREVIEW_NOT_FOUND")


@pytest.mark.parametrize("pattern_status", ["deleting", "deleted"])
def test_worker_rejects_a_preview_for_a_deleting_or_deleted_pattern(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
    pattern_status: str,
) -> None:
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "UPDATE patterns SET status = %s WHERE owner_id = %s AND id = %s",
            (pattern_status, seeded_job.owner_id, seeded_job.pattern_id),
        )
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-deleting-pattern",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT status, last_error_code FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()
        document_count = connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0]
    assert outcome == "failed"
    assert row == ("failed", "INDEX_PREVIEW_UNAVAILABLE")
    assert document_count == 0
    assert storage.write_count == 0


def test_pattern_becoming_deleting_during_inference_cannot_be_published(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    def mark_deleting() -> None:
        with psycopg.connect(database_url) as connection:
            connection.execute(
                """
                UPDATE patterns SET status = 'deleting'
                WHERE owner_id = %s AND id = %s
                """,
                (seeded_job.owner_id, seeded_job.pattern_id),
            )

    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(mark_deleting),
        worker_id="worker-pattern-status-race",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        job_row = connection.execute(
            "SELECT status, last_error_code FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()
        document_count = connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0]
    assert outcome == "failed"
    assert job_row == ("failed", "INDEX_PREVIEW_UNAVAILABLE")
    assert document_count == 0
    assert storage.object_keys == (seeded_job.preview_object_key,)


@pytest.mark.parametrize(
    ("embedder", "error_code"),
    [
        (InvalidDimensionsEmbedder(), "INDEX_EMBEDDING_INVALID"),
        (ModelChecksumFailureEmbedder(), IMAGE_SEARCH_MODEL_INVALID),
    ],
)
def test_invalid_embedding_or_model_checksum_is_terminal(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
    embedder: object,
    error_code: str,
) -> None:
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        embedder,
        worker_id="worker-invalid-model-output",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            "SELECT status, last_error_code FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()
    assert outcome == "failed"
    assert row == ("failed", error_code)
    assert storage.write_count == 0


def test_temporary_storage_failure_is_retryable(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    storage = TemporaryWriteFailureStorage()
    seed_preview(storage, seeded_job)
    worker = IndexWorker(
        repository,
        storage,
        DeterministicEmbedder(),
        worker_id="worker-temporary-storage-failure",
        index_version=INDEX_VERSION,
        clock=lambda: NOW,
    )

    outcome = worker.run_once(now=NOW)

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            SELECT status, available_at, last_error_code
            FROM visual_search_jobs
            WHERE id = %s
            """,
            (seeded_job.id,),
        ).fetchone()
    assert outcome == "retried"
    assert row == (
        "pending",
        NOW + timedelta(seconds=30),
        "INDEX_TEMPORARY_FAILURE",
    )
    assert storage.object_keys == (seeded_job.preview_object_key,)


def test_publication_waiting_for_preview_replacement_does_not_deadlock_or_publish(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    worker_id = "worker-waits-for-replacement"
    claimed = repository.claim_next(worker_id, index_version=INDEX_VERSION, now=NOW)
    assert claimed is not None
    replacement_id = uuid4()
    replacement_key = (
        f"users/{seeded_job.owner_id}/patterns/{seeded_job.pattern_id}/"
        f"derived/{replacement_id}.webp"
    )

    with ThreadPoolExecutor(max_workers=1) as executor:
        with psycopg.connect(database_url) as replacement:
            replacement_pid = replacement.execute("SELECT pg_backend_pid()").fetchone()[0]
            replacement.execute(
                """
                SELECT id FROM patterns
                WHERE owner_id = %s AND id = %s
                FOR UPDATE
                """,
                (seeded_job.owner_id, seeded_job.pattern_id),
            )
            publication = executor.submit(
                publish_claimed_job,
                repository,
                claimed,
                seeded_job,
                worker_id=worker_id,
            )
            wait_for_lock_waiter(database_url, blocker_pid=replacement_pid)
            replacement.execute(
                """
                DELETE FROM assets
                WHERE id = %s AND owner_id = %s AND pattern_id = %s
                """,
                (
                    seeded_job.preview_asset_id,
                    seeded_job.owner_id,
                    seeded_job.pattern_id,
                ),
            )
            replacement.execute(
                """
                INSERT INTO assets (
                    id, owner_id, pattern_id, role, object_key,
                    original_filename, detected_mime_type, size_bytes,
                    width, height
                )
                VALUES (%s, %s, %s, 'preview', %s, 'replacement.webp',
                        'image/webp', 1024, 512, 512)
                """,
                (
                    replacement_id,
                    seeded_job.owner_id,
                    seeded_job.pattern_id,
                    replacement_key,
                ),
            )

        with pytest.raises((LeaseLostError, PreviewUnavailableError)):
            publication.result(timeout=5)

    with psycopg.connect(database_url) as connection:
        assert connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT count(*) FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()[0] == 0


def test_preview_replacement_waiting_for_publication_removes_published_state(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker_id = "worker-holds-publication-locks"
    claimed = repository.claim_next(worker_id, index_version=INDEX_VERSION, now=NOW)
    assert claimed is not None
    publication_paused = Event()
    release_publication = Event()
    original_complete = repository._complete_locked

    def pause_before_complete(*args, **kwargs) -> None:
        publication_paused.set()
        if not release_publication.wait(5):
            raise TimeoutError("publication test barrier timed out")
        original_complete(*args, **kwargs)

    monkeypatch.setattr(repository, "_complete_locked", pause_before_complete)
    replacement_id = uuid4()
    replacement_pid: list[int] = []
    replacement_started = Event()

    def replace_preview() -> None:
        with psycopg.connect(database_url) as replacement:
            replacement_pid.append(
                replacement.execute("SELECT pg_backend_pid()").fetchone()[0]
            )
            replacement_started.set()
            replacement.execute(
                """
                SELECT id FROM patterns
                WHERE owner_id = %s AND id = %s
                FOR UPDATE
                """,
                (seeded_job.owner_id, seeded_job.pattern_id),
            )
            replacement.execute(
                """
                DELETE FROM assets
                WHERE id = %s AND owner_id = %s AND pattern_id = %s
                """,
                (
                    seeded_job.preview_asset_id,
                    seeded_job.owner_id,
                    seeded_job.pattern_id,
                ),
            )
            replacement.execute(
                """
                INSERT INTO assets (
                    id, owner_id, pattern_id, role, object_key,
                    original_filename, detected_mime_type, size_bytes,
                    width, height
                )
                VALUES (%s, %s, %s, 'preview', %s, 'replacement.webp',
                        'image/webp', 1024, 512, 512)
                """,
                (
                    replacement_id,
                    seeded_job.owner_id,
                    seeded_job.pattern_id,
                    (
                        f"users/{seeded_job.owner_id}/patterns/"
                        f"{seeded_job.pattern_id}/derived/{replacement_id}.webp"
                    ),
                ),
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        publication = executor.submit(
            publish_claimed_job,
            repository,
            claimed,
            seeded_job,
            worker_id=worker_id,
        )
        if not publication_paused.wait(5):
            publication.result(timeout=1)
            raise AssertionError("publication did not reach the transaction barrier")
        replacement = executor.submit(replace_preview)
        assert replacement_started.wait(5)
        wait_for_lock_waiter(database_url, waiter_pid=replacement_pid[0])
        release_publication.set()
        assert publication.result(timeout=5).replayed is False
        replacement.result(timeout=5)

    with psycopg.connect(database_url) as connection:
        assert connection.execute(
            "SELECT count(*) FROM visual_search_documents WHERE owner_id = %s",
            (seeded_job.owner_id,),
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT count(*) FROM visual_search_jobs WHERE id = %s",
            (seeded_job.id,),
        ).fetchone()[0] == 0


def test_orphan_cleanup_keeps_document_references_and_age_boundary(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    document_hash = "11" * 32
    old_orphan_hash = "22" * 32
    boundary_hash = "33" * 32
    young_hash = "44" * 32
    document_key = build_derived_key(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        document_hash,
    )
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "UPDATE visual_search_jobs SET status = 'failed' WHERE id = %s",
            (seeded_job.id,),
        )
    seed_ready_document(
        database_url,
        seeded_job,
        preview_hash=document_hash,
        object_key=document_key,
    )
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    for preview_hash, modified in (
        (document_hash, NOW),
        (old_orphan_hash, NOW),
        (boundary_hash, NOW + timedelta(hours=24)),
        (young_hash, NOW + timedelta(hours=30)),
    ):
        storage.write_features(
            seeded_job.owner_id,
            seeded_job.pattern_id,
            INDEX_VERSION,
            preview_hash,
            preview_hash.encode("ascii"),
            now=modified,
        )

    report = cleanup_orphans(
        repository,
        storage,
        index_version=INDEX_VERSION,
        older_than=timedelta(hours=24),
        now=NOW + timedelta(hours=48),
    )

    assert report.scanned == 4
    assert report.deleted == 1
    assert report.kept == 3
    assert build_derived_key(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        old_orphan_hash,
    ) not in storage.object_keys
    assert document_key in storage.object_keys
    assert build_derived_key(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        boundary_hash,
    ) in storage.object_keys
    assert seeded_job.preview_object_key in storage.object_keys


def test_orphan_cleanup_does_not_miss_a_job_becoming_a_ready_document(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preview_hash = "0a" * 32
    object_key = build_derived_key(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        preview_hash,
    )
    storage = InMemoryStorage()
    storage.write_features(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        preview_hash,
        b"old-unreferenced-upload",
        now=NOW,
    )
    documents_read = Event()
    release_cleanup = Event()
    real_pool = repository._pool

    class PausingCursor:
        def __init__(self, cursor) -> None:
            self._cursor = cursor

        def fetchall(self):
            rows = self._cursor.fetchall()
            documents_read.set()
            if not release_cleanup.wait(5):
                raise TimeoutError("cleanup publication barrier timed out")
            return rows

    class PausingConnection:
        def __init__(self, connection) -> None:
            self._connection = connection

        def execute(self, query, parameters=None):
            cursor = self._connection.execute(query, parameters)
            if "FROM visual_search_documents" in query:
                return PausingCursor(cursor)
            return cursor

        def transaction(self):
            return self._connection.transaction()

    class PausingPool:
        @contextmanager
        def connection(self):
            with real_pool.connection() as connection:
                yield PausingConnection(connection)

    monkeypatch.setattr(repository, "_pool", PausingPool())
    with ThreadPoolExecutor(max_workers=1) as executor:
        cleanup = executor.submit(
            cleanup_orphans,
            repository,
            storage,
            index_version=INDEX_VERSION,
            older_than=timedelta(hours=24),
            now=NOW + timedelta(hours=48),
        )
        assert documents_read.wait(5)
        with psycopg.connect(database_url) as publication:
            publication.execute(
                """
                INSERT INTO visual_search_documents (
                    id, owner_id, pattern_id, preview_asset_id, preview_hash,
                    index_version, status, local_feature_object_key,
                    indexed_at, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, 'ready', %s, %s, %s, %s)
                """,
                (
                    uuid4(),
                    seeded_job.owner_id,
                    seeded_job.pattern_id,
                    seeded_job.preview_asset_id,
                    preview_hash,
                    INDEX_VERSION,
                    object_key,
                    NOW,
                    NOW,
                    NOW,
                ),
            )
            publication.execute(
                """
                UPDATE visual_search_jobs
                SET status = 'complete', updated_at = %s
                WHERE id = %s
                """,
                (NOW, seeded_job.id),
            )
        release_cleanup.set()
        report = cleanup.result(timeout=5)
    monkeypatch.setattr(repository, "_pool", real_pool)

    assert report.deleted == 0
    assert object_key in storage.object_keys


def test_orphan_cleanup_rechecks_a_live_job_created_after_its_snapshot(
    repository: Repository,
    seeded_job: SeededJob,
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preview_hash = "0b" * 32
    object_key = build_derived_key(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        preview_hash,
    )
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "UPDATE visual_search_jobs SET status = 'failed' WHERE id = %s",
            (seeded_job.id,),
        )
    storage = InMemoryStorage()
    storage.write_features(
        seeded_job.owner_id,
        seeded_job.pattern_id,
        INDEX_VERSION,
        preview_hash,
        b"old-unreferenced-upload",
        now=NOW,
    )
    jobs_read = Event()
    release_cleanup = Event()
    real_pool = repository._pool

    class PausingCursor:
        def __init__(self, cursor) -> None:
            self._cursor = cursor

        def fetchall(self):
            rows = self._cursor.fetchall()
            jobs_read.set()
            if not release_cleanup.wait(5):
                raise TimeoutError("cleanup job snapshot barrier timed out")
            return rows

    class PausingConnection:
        def __init__(self, connection) -> None:
            self._connection = connection

        def execute(self, query, parameters=None):
            cursor = self._connection.execute(query, parameters)
            if "FROM visual_search_jobs" in query:
                return PausingCursor(cursor)
            return cursor

        def transaction(self):
            return self._connection.transaction()

    class PausingPool:
        @contextmanager
        def connection(self):
            with real_pool.connection() as connection:
                yield PausingConnection(connection)

    monkeypatch.setattr(repository, "_pool", PausingPool())
    with ThreadPoolExecutor(max_workers=1) as executor:
        cleanup = executor.submit(
            cleanup_orphans,
            repository,
            storage,
            index_version=INDEX_VERSION,
            older_than=timedelta(hours=24),
            now=NOW + timedelta(hours=48),
        )
        assert jobs_read.wait(5)
        with psycopg.connect(database_url) as connection:
            connection.execute(
                """
                UPDATE visual_search_jobs
                SET status = 'pending', preview_hash = %s, available_at = %s,
                    updated_at = %s
                WHERE id = %s
                """,
                (preview_hash, NOW, NOW, seeded_job.id),
            )
        release_cleanup.set()
        report = cleanup.result(timeout=5)
    monkeypatch.setattr(repository, "_pool", real_pool)

    assert report.deleted == 0
    assert object_key in storage.object_keys


def test_orphan_cleanup_keeps_object_for_live_job_hash(
    repository: Repository,
    seed_factory: SeedFactory,
) -> None:
    live_hash = "55" * 32
    orphan_hash = "66" * 32
    job = seed_factory.job(preview_hash=live_hash)
    storage = InMemoryStorage()
    seed_preview(storage, job)
    for preview_hash in (live_hash, orphan_hash):
        storage.write_features(
            job.owner_id,
            job.pattern_id,
            INDEX_VERSION,
            preview_hash,
            b"features",
            now=NOW,
        )

    report = cleanup_orphans(
        repository,
        storage,
        index_version=INDEX_VERSION,
        older_than=timedelta(hours=24),
        now=NOW + timedelta(hours=48),
    )

    assert report.deleted == 1
    assert build_derived_key(
        job.owner_id,
        job.pattern_id,
        INDEX_VERSION,
        live_hash,
    ) in storage.object_keys
    assert build_derived_key(
        job.owner_id,
        job.pattern_id,
        INDEX_VERSION,
        orphan_hash,
    ) not in storage.object_keys


def test_orphan_cleanup_live_job_without_hash_protects_its_prefix(
    repository: Repository,
    seeded_job: SeededJob,
) -> None:
    storage = InMemoryStorage()
    seed_preview(storage, seeded_job)
    for preview_hash in ("77" * 32, "88" * 32):
        storage.write_features(
            seeded_job.owner_id,
            seeded_job.pattern_id,
            INDEX_VERSION,
            preview_hash,
            b"features",
            now=NOW,
        )

    report = cleanup_orphans(
        repository,
        storage,
        index_version=INDEX_VERSION,
        older_than=timedelta(hours=24),
        now=NOW + timedelta(hours=48),
    )

    assert report.scanned == 2
    assert report.deleted == 0
    assert report.kept == 2


def test_orphan_cleanup_failed_job_does_not_keep_its_object(
    repository: Repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    failed_hash = "99" * 32
    job = seed_factory.job(preview_hash=failed_hash)
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "UPDATE visual_search_jobs SET status = 'failed' WHERE id = %s",
            (job.id,),
        )
    storage = InMemoryStorage()
    seed_preview(storage, job)
    storage.write_features(
        job.owner_id,
        job.pattern_id,
        INDEX_VERSION,
        failed_hash,
        b"failed-features",
        now=NOW,
    )

    report = cleanup_orphans(
        repository,
        storage,
        index_version=INDEX_VERSION,
        older_than=timedelta(hours=24),
        now=NOW + timedelta(hours=48),
    )

    assert report.deleted == 1
    assert storage.object_keys == (job.preview_object_key,)


def test_orphan_cleanup_refuses_an_unconfigured_non_test_database(
    repository: Repository,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(repository, "database_name", lambda: "melon")

    def inventory_must_not_run(*, index_version: str) -> None:
        raise AssertionError(f"cleanup scanned unsafe database for {index_version}")

    monkeypatch.setattr(repository, "cleanup_inventory", inventory_must_not_run)

    with pytest.raises(CleanupRefusedError):
        cleanup_orphans(
            repository,
            InMemoryStorage(),
            index_version=INDEX_VERSION,
            older_than=timedelta(hours=24),
            now=NOW,
        )


def test_cleanup_database_guard_requires_an_exact_explicit_production_name() -> None:
    assert_cleanup_database_allowed(
        "melon_production",
        production_database_name="melon_production",
    )
    with pytest.raises(CleanupRefusedError):
        assert_cleanup_database_allowed(
            "melon_production",
            production_database_name="other_production",
        )
    with pytest.raises(CleanupRefusedError):
        assert_cleanup_database_allowed("melon", production_database_name=None)


def test_cli_exposes_worker_and_cleanup_commands() -> None:
    parser = cli.build_parser()

    worker_args = parser.parse_args(["worker"])
    cleanup_args = parser.parse_args(["cleanup-orphans"])

    assert worker_args.command == "worker"
    assert cleanup_args.command == "cleanup-orphans"
    assert cleanup_args.older_than_hours == 24.0
    with pytest.raises(SystemExit):
        parser.parse_args(["cleanup-orphans", "--older-than-hours", "0"])


def test_cli_runtime_loader_uses_the_configured_deployment_artifact(
    tmp_path: Path,
) -> None:
    model_path = tmp_path / "deployed-model.onnx"
    checksum = "a" * 64
    lock_path = tmp_path / "model-lock.json"
    settings = Settings(
        internal_token="x" * 32,
        model_path=model_path,
        model_sha256=checksum,
    )
    captured: dict[str, object] = {}
    sentinel = object()

    def runtime_factory(path: Path, **kwargs):
        captured["lock_path"] = path
        captured.update(kwargs)
        return sentinel

    runtime = cli.load_embedding_runtime(
        settings,
        lock_path=lock_path,
        runtime_factory=runtime_factory,
    )

    assert runtime is sentinel
    assert captured == {
        "lock_path": lock_path,
        "artifact_path": model_path,
        "expected_sha256": checksum,
    }
