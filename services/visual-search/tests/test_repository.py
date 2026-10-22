from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import replace
from datetime import timedelta
from uuid import UUID, uuid4

import numpy as np
import psycopg
import pytest
from conftest import INDEX_VERSION, NOW, SeededJob, SeedFactory

from melon_visual_search.palette_search import PaletteDataError
from melon_visual_search.repository import (
    EmbeddingRecord,
    LeaseLostError,
    PaletteColorRecord,
    Repository,
)


def valid_publication_embeddings() -> tuple[EmbeddingRecord, ...]:
    return tuple(
        EmbeddingRecord(
            region_index=index,
            region_kind="global" if index == 0 else "tile",
            x=0.0,
            y=0.0,
            width=1.0,
            height=1.0,
            embedding=np.eye(10, 384, dtype=np.float32)[index],
        )
        for index in range(10)
    )


def valid_publication_palette() -> tuple[PaletteColorRecord, ...]:
    return (
        PaletteColorRecord(0, "#285947", (0.42, -0.08, 0.03), 0.5),
        PaletteColorRecord(1, "#CC9C3F", (0.72, 0.03, 0.11), 0.3),
        PaletteColorRecord(2, "#8F4038", (0.48, 0.1, 0.05), 0.2),
    )


def insert_palette_document(
    database_url: str,
    seeded: SeededJob,
    *,
    status: str = "ready",
    palette: tuple[PaletteColorRecord, ...] | None = None,
) -> UUID:
    document_id = uuid4()
    colors = palette or valid_publication_palette()
    with psycopg.connect(database_url) as connection:
        connection.execute(
            """
            INSERT INTO visual_search_documents (
                id, owner_id, pattern_id, preview_asset_id, preview_hash,
                index_version, status, phash, width, height,
                local_feature_object_key, indexed_at
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s,
                %s::bit(64), 512, 512, %s, %s
            )
            """,
            (
                document_id,
                seeded.owner_id,
                seeded.pattern_id,
                seeded.preview_asset_id,
                uuid4().hex * 2,
                seeded.index_version,
                status,
                "0" * 64,
                f"features/{document_id}.npz",
                NOW if status == "ready" else None,
            ),
        )
        with connection.cursor() as cursor:
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
                        document_id,
                        seeded.owner_id,
                        seeded.pattern_id,
                        color.color_index,
                        color.display_hex,
                        *color.oklab,
                        color.coverage,
                    )
                    for color in colors
                ],
            )
    return document_id


def test_list_ready_palettes_is_scoped_to_owner_version_status_and_ids(
    repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    owner_id = uuid4()
    included = seed_factory.job(owner_id=owner_id)
    out_of_scope = seed_factory.job(owner_id=owner_id)
    wrong_version = seed_factory.job(
        owner_id=owner_id,
        index_version="visual-search-v2",
    )
    wrong_owner = seed_factory.job()
    not_ready = seed_factory.job(owner_id=owner_id)
    for seeded in (included, out_of_scope, wrong_version, wrong_owner):
        insert_palette_document(database_url, seeded)
    insert_palette_document(database_url, not_ready, status="indexing")

    candidates = repository.list_ready_palettes(
        owner_id=owner_id,
        index_version=INDEX_VERSION,
        allowed_pattern_ids=(
            included.pattern_id,
            wrong_version.pattern_id,
            wrong_owner.pattern_id,
            not_ready.pattern_id,
        ),
    )

    assert [candidate.pattern_id for candidate in candidates] == [
        included.pattern_id
    ]
    assert [color.display_hex for color in candidates[0].colors] == [
        "#285947",
        "#CC9C3F",
        "#8F4038",
    ]


def test_list_ready_palettes_rejects_malformed_stored_palette(
    repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    seeded = seed_factory.job()
    insert_palette_document(
        database_url,
        seeded,
        palette=valid_publication_palette()[:2],
    )

    with pytest.raises(PaletteDataError) as caught:
        repository.list_ready_palettes(
            owner_id=seeded.owner_id,
            index_version=INDEX_VERSION,
            allowed_pattern_ids=(seeded.pattern_id,),
        )

    assert caught.value.code == "PALETTE_DATA_INVALID"


def test_list_ready_palettes_rejects_oversized_scope(repository) -> None:
    with pytest.raises(ValueError, match="supported limit"):
        repository.list_ready_palettes(
            owner_id=uuid4(),
            index_version=INDEX_VERSION,
            allowed_pattern_ids=tuple(uuid4() for _ in range(10_001)),
        )


def test_publication_accepts_three_to_five_valid_palette_colors() -> None:
    Repository._validate_publication(
        512,
        512,
        "0" * 16,
        valid_publication_embeddings(),
        valid_publication_palette(),
    )


@pytest.mark.parametrize(
    "palette",
    [
        valid_publication_palette()[:2],
        valid_publication_palette()
        + (
            PaletteColorRecord(3, "#102030", (0.2, 0.0, 0.0), 0.04),
            PaletteColorRecord(4, "#203040", (0.3, 0.0, 0.0), 0.03),
            PaletteColorRecord(5, "#304050", (0.4, 0.0, 0.0), 0.03),
        ),
        (
            PaletteColorRecord(0, "#285947", (0.42, -0.08, 0.03), 0.5),
            PaletteColorRecord(2, "#CC9C3F", (0.72, 0.03, 0.11), 0.3),
            PaletteColorRecord(3, "#8F4038", (0.48, 0.1, 0.05), 0.2),
        ),
        (
            PaletteColorRecord(0, "#285947", (0.42, -0.08, 0.03), 0.5),
            PaletteColorRecord(1, "#285947", (0.72, 0.03, 0.11), 0.3),
            PaletteColorRecord(2, "#8F4038", (0.48, 0.1, 0.05), 0.2),
        ),
        (
            PaletteColorRecord(0, "#285947", (0.42, -0.08, 0.03), 0.5),
            PaletteColorRecord(1, "#cc9c3f", (0.72, 0.03, 0.11), 0.3),
            PaletteColorRecord(2, "#8F4038", (0.48, 0.1, 0.05), 0.2),
        ),
        (
            PaletteColorRecord(0, "#285947", (float("nan"), 0.0, 0.0), 0.5),
            PaletteColorRecord(1, "#CC9C3F", (0.72, 0.03, 0.11), 0.3),
            PaletteColorRecord(2, "#8F4038", (0.48, 0.1, 0.05), 0.2),
        ),
        (
            PaletteColorRecord(0, "#285947", (0.42, -0.08, 0.03), 0.4),
            PaletteColorRecord(1, "#CC9C3F", (0.72, 0.03, 0.11), 0.3),
            PaletteColorRecord(2, "#8F4038", (0.48, 0.1, 0.05), 0.2),
        ),
    ],
    ids=[
        "too-few",
        "too-many",
        "nonconsecutive-indexes",
        "duplicate-hex",
        "lowercase-hex",
        "nonfinite-oklab",
        "coverage-does-not-sum-to-one",
    ],
)
def test_publication_rejects_invalid_palettes(
    palette: tuple[PaletteColorRecord, ...],
) -> None:
    with pytest.raises(ValueError, match="palette"):
        Repository._validate_publication(
            512,
            512,
            "0" * 16,
            valid_publication_embeddings(),
            palette,
        )


def test_workers_cannot_claim_the_same_job(repository, seeded_job: SeededJob) -> None:
    with ThreadPoolExecutor(max_workers=2) as executor:
        claims = list(
            executor.map(
                lambda worker_id: repository.claim_next(
                    worker_id,
                    index_version=INDEX_VERSION,
                    now=NOW,
                ),
                ("worker-a", "worker-b"),
            )
        )

    claimed = [job for job in claims if job is not None]
    assert [job.id for job in claimed] == [seeded_job.id]
    assert claimed[0].attempt_count == 1
    assert claimed[0].lease_until == NOW + timedelta(minutes=5)


def test_pending_job_is_not_claimed_before_available_at(
    repository,
    seed_factory: SeedFactory,
) -> None:
    seed_factory.job(available_at=NOW + timedelta(seconds=1))

    assert (
        repository.claim_next(
            "worker-a",
            index_version=INDEX_VERSION,
            now=NOW,
        )
        is None
    )


def test_expired_lease_is_reclaimed(
    repository,
    seeded_job: SeededJob,
) -> None:
    first = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW,
    )
    assert first is not None

    reclaimed = repository.claim_next(
        "worker-b",
        index_version=INDEX_VERSION,
        now=NOW + timedelta(minutes=6),
    )

    assert reclaimed is not None
    assert reclaimed.id == seeded_job.id
    assert reclaimed.leased_by == "worker-b"
    assert reclaimed.attempt_count == 2


def test_active_lease_can_be_renewed_only_by_its_owner(
    repository,
    seeded_job: SeededJob,
) -> None:
    job = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW,
    )
    assert job is not None

    with pytest.raises(LeaseLostError):
        repository.renew_lease(
            job,
            "worker-b",
            now=NOW + timedelta(seconds=15),
        )

    renewed = repository.renew_lease(
        job,
        "worker-a",
        now=NOW + timedelta(seconds=15),
    )
    assert renewed.lease_until == NOW + timedelta(minutes=5, seconds=15)
    assert renewed.id == seeded_job.id


def test_reclaimed_job_fences_the_stale_worker(repository, seeded_job: SeededJob) -> None:
    stale = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW,
    )
    assert stale is not None
    current = repository.claim_next(
        "worker-b",
        index_version=INDEX_VERSION,
        now=NOW + timedelta(minutes=6),
    )
    assert current is not None

    with pytest.raises(LeaseLostError):
        repository.complete(
            stale,
            "worker-a",
            now=NOW + timedelta(minutes=6),
        )

    completed = repository.complete(
        current,
        "worker-b",
        now=NOW + timedelta(minutes=6),
    )
    assert completed.status == "complete"
    assert completed.id == seeded_job.id


def test_reclaim_with_the_same_worker_id_still_fences_the_stale_handle(
    repository,
    seeded_job: SeededJob,
) -> None:
    stale = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW,
    )
    assert stale is not None
    current = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW + timedelta(minutes=6),
    )
    assert current is not None
    assert current.attempt_count == stale.attempt_count + 1

    with pytest.raises(LeaseLostError):
        repository.complete(
            stale,
            "worker-a",
            now=NOW + timedelta(minutes=6),
        )

    assert repository.get_job(seeded_job.id).status == "leased"


def test_job_identity_is_checked_when_completing(repository, seeded_job: SeededJob) -> None:
    job = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW,
    )
    assert job is not None

    with pytest.raises(LeaseLostError):
        repository.complete(
            replace(job, owner_id=uuid4()),
            "worker-a",
            now=NOW,
        )

    assert repository.get_job(seeded_job.id).status == "leased"


def test_retry_backoff_uses_attempt_number(repository, seeded_job: SeededJob) -> None:
    first = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW,
    )
    assert first is not None
    first_failed = repository.fail(
        first,
        "INDEX_STORAGE_UNAVAILABLE",
        retryable=True,
        worker_id="worker-a",
        now=NOW,
    )
    assert first_failed.status == "pending"
    assert first_failed.available_at == NOW + timedelta(seconds=30)

    second_now = NOW + timedelta(seconds=30)
    second = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=second_now,
    )
    assert second is not None
    second_failed = repository.fail(
        second,
        "INDEX_STORAGE_UNAVAILABLE",
        retryable=True,
        worker_id="worker-a",
        now=second_now,
    )
    assert second_failed.status == "pending"
    assert second_failed.available_at == second_now + timedelta(seconds=60)


def test_fifth_failure_is_terminal(repository, seeded_job: SeededJob) -> None:
    attempt_time = NOW
    for attempt in range(1, 6):
        job = repository.claim_next(
            "worker-a",
            index_version=INDEX_VERSION,
            now=attempt_time,
        )
        assert job is not None
        result = repository.fail(
            job,
            "INDEX_STORAGE_UNAVAILABLE",
            retryable=True,
            worker_id="worker-a",
            now=attempt_time,
        )
        assert result.attempt_count == attempt
        if attempt < 5:
            assert result.status == "pending"
            attempt_time = result.available_at

    assert result.status == "failed"
    assert result.available_at == attempt_time
    assert repository.get_job(seeded_job.id).status == "failed"


def test_expired_fifth_attempt_is_terminal_instead_of_becoming_attempt_six(
    repository,
    seeded_job: SeededJob,
) -> None:
    attempt_time = NOW
    for _ in range(4):
        job = repository.claim_next(
            "worker-a",
            index_version=INDEX_VERSION,
            now=attempt_time,
        )
        assert job is not None
        failed = repository.fail(
            job,
            "INDEX_STORAGE_UNAVAILABLE",
            retryable=True,
            worker_id="worker-a",
            now=attempt_time,
        )
        attempt_time = failed.available_at

    fifth = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=attempt_time,
    )
    assert fifth is not None
    assert fifth.attempt_count == 5

    assert (
        repository.claim_next(
            "worker-b",
            index_version=INDEX_VERSION,
            now=attempt_time + timedelta(minutes=6),
        )
        is None
    )
    terminal = repository.get_job(seeded_job.id)
    assert terminal is not None
    assert terminal.status == "failed"
    assert terminal.attempt_count == 5
    assert terminal.last_error_code == "INDEX_LEASE_EXPIRED"


def test_locked_expired_fifth_attempt_does_not_block_another_claim(
    repository,
    seeded_job: SeededJob,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    claim_time = NOW + timedelta(minutes=6)
    available = seed_factory.job(available_at=claim_time)
    with psycopg.connect(database_url) as setup:
        setup.execute(
            """
            UPDATE visual_search_jobs
            SET status = 'leased', attempt_count = max_attempts,
                leased_by = 'stale-worker', lease_until = %s
            WHERE id = %s
            """,
            (NOW, seeded_job.id),
        )

    with psycopg.connect(database_url) as blocker:
        blocker.execute(
            "SELECT id FROM visual_search_jobs WHERE id = %s FOR UPDATE",
            (seeded_job.id,),
        )
        with ThreadPoolExecutor(max_workers=1) as executor:
            claim = executor.submit(
                repository.claim_next,
                "worker-a",
                index_version=INDEX_VERSION,
                now=claim_time,
            )
            try:
                result = claim.result(timeout=0.5)
            except FutureTimeoutError:
                blocker.rollback()
                claim.result(timeout=5)
                pytest.fail("terminal lease cleanup blocked a SKIP LOCKED claim")

    assert result is not None
    assert result.id == available.id


def test_non_retryable_failure_is_immediately_terminal(
    repository,
    seeded_job: SeededJob,
) -> None:
    job = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW,
    )
    assert job is not None

    failed = repository.fail(
        job,
        "INDEX_PREVIEW_INVALID",
        retryable=False,
        worker_id="worker-a",
        now=NOW,
    )

    assert failed.status == "failed"
    assert failed.last_error_code == "INDEX_PREVIEW_INVALID"


def test_worker_heartbeat_is_upserted(
    repository,
    seed_factory: SeedFactory,
    db_query,
) -> None:
    seed_factory.remember_worker("worker-heartbeat")

    repository.heartbeat_worker("worker-heartbeat", INDEX_VERSION, now=NOW)
    repository.heartbeat_worker(
        "worker-heartbeat",
        INDEX_VERSION,
        now=NOW + timedelta(seconds=15),
    )

    rows = db_query(
        """
        SELECT index_version, last_seen_at
        FROM visual_search_workers
        WHERE worker_id = %s
        """,
        ("worker-heartbeat",),
    )
    assert rows == [(INDEX_VERSION, NOW + timedelta(seconds=15))]


def test_asset_cascade_removes_a_claimed_job(
    repository,
    seeded_job: SeededJob,
    database_url: str,
) -> None:
    job = repository.claim_next(
        "worker-a",
        index_version=INDEX_VERSION,
        now=NOW,
    )
    assert job is not None
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "DELETE FROM assets WHERE id = %s AND owner_id = %s AND pattern_id = %s",
            (seeded_job.preview_asset_id, seeded_job.owner_id, seeded_job.pattern_id),
        )

    assert repository.get_job(seeded_job.id) is None
    with pytest.raises(LeaseLostError):
        repository.complete(job, "worker-a", now=NOW)
