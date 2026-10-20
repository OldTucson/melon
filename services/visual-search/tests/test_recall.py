from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID, uuid4

import numpy as np
import psycopg
import pytest
from conftest import INDEX_VERSION, NOW, SeedFactory
from pgvector.psycopg import register_vector

from melon_visual_search.repository import Repository, validate_pgvector_version


def _unit_vector(axis: int = 0, *, sign: float = 1.0) -> np.ndarray:
    vector = np.zeros(384, dtype=np.float32)
    vector[axis] = sign
    return vector


def _seed_ready_document(
    database_url: str,
    seed_factory: SeedFactory,
    *,
    owner_id: UUID | None = None,
    index_version: str = INDEX_VERSION,
    status: str = "ready",
    vector: np.ndarray | None = None,
    region_vectors: list[np.ndarray] | None = None,
) -> tuple[UUID, UUID]:
    fingerprint = uuid4().hex * 2
    seeded = seed_factory.job(
        owner_id=owner_id,
        preview_hash=fingerprint,
        index_version=index_version,
        status="complete",
    )
    document_id = uuid4()
    embedding = vector if vector is not None else _unit_vector()
    selected_vectors = region_vectors or [embedding] * 10
    assert len(selected_vectors) == 10
    with psycopg.connect(database_url) as connection:
        register_vector(connection)
        connection.execute(
            """
            INSERT INTO visual_search_documents (
                id, owner_id, pattern_id, preview_asset_id, preview_hash,
                index_version, status, phash, width, height,
                local_feature_object_key, indexed_at, created_at, updated_at
            )
            VALUES (
                %s, %s, %s, %s, %s, %s,
                %s::visual_search_document_status, %s::bit(64),
                512, 512, %s, %s, %s, %s
            )
            """,
            (
                document_id,
                seeded.owner_id,
                seeded.pattern_id,
                seeded.preview_asset_id,
                fingerprint,
                index_version,
                status,
                "0" * 64,
                (
                    f"users/{seeded.owner_id}/patterns/{seeded.pattern_id}/"
                    f"derived/search/{index_version}/{fingerprint}.npz"
                ),
                NOW,
                NOW,
                NOW,
            ),
        )
        rows = [
            (
                document_id,
                seeded.owner_id,
                seeded.pattern_id,
                region_index,
                "global" if region_index == 0 else "tile",
                0.0,
                0.0,
                1.0,
                1.0,
                selected_vectors[region_index],
            )
            for region_index in range(10)
        ]
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO visual_search_embeddings (
                    document_id, owner_id, pattern_id, region_index,
                    region_kind, x, y, width, height, embedding
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                rows,
            )
    return seeded.pattern_id, document_id


def _query_vectors(vector: np.ndarray | None = None) -> np.ndarray:
    selected = vector if vector is not None else _unit_vector()
    return np.ascontiguousarray(np.stack([selected] * 10), dtype=np.float32)


def _ids(values: Iterable[tuple[UUID, UUID]]) -> list[UUID]:
    return [pattern_id for pattern_id, _ in values]


def test_recall_never_returns_another_owner_or_disallowed_pattern(
    repository: Repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    owner = uuid4()
    allowed = _seed_ready_document(database_url, seed_factory, owner_id=owner)
    disallowed = _seed_ready_document(database_url, seed_factory, owner_id=owner)
    foreign = _seed_ready_document(database_url, seed_factory)

    candidates = repository.recall_candidates(
        owner_id=owner,
        index_version=INDEX_VERSION,
        allowed_pattern_ids=[allowed[0], foreign[0]],
        query_vectors=_query_vectors(),
    )

    assert [candidate.pattern_id for candidate in candidates] == [allowed[0]]
    assert disallowed[0] not in {candidate.pattern_id for candidate in candidates}
    assert foreign[0] not in {candidate.pattern_id for candidate in candidates}
    assert all(candidate.owner_id == owner for candidate in candidates)


def test_recall_requires_ready_document_and_active_version(
    repository: Repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    owner = uuid4()
    ready = _seed_ready_document(database_url, seed_factory, owner_id=owner)
    indexing = _seed_ready_document(
        database_url,
        seed_factory,
        owner_id=owner,
        status="indexing",
    )
    other_version = _seed_ready_document(
        database_url,
        seed_factory,
        owner_id=owner,
        index_version="visual-search-v2",
    )

    candidates = repository.recall_candidates(
        owner_id=owner,
        index_version=INDEX_VERSION,
        allowed_pattern_ids=_ids([ready, indexing, other_version]),
        query_vectors=_query_vectors(),
    )

    assert [candidate.pattern_id for candidate in candidates] == [ready[0]]


def test_recall_reports_whether_the_filtered_scope_has_a_ready_index(
    repository: Repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    owner = uuid4()
    indexed = _seed_ready_document(database_url, seed_factory, owner_id=owner)
    missing = uuid4()

    assert repository.has_ready_documents(
        owner_id=owner,
        index_version=INDEX_VERSION,
        allowed_pattern_ids=[indexed[0]],
    )
    assert not repository.has_ready_documents(
        owner_id=owner,
        index_version=INDEX_VERSION,
        allowed_pattern_ids=[missing],
    )
    assert not repository.has_ready_documents(
        owner_id=uuid4(),
        index_version=INDEX_VERSION,
        allowed_pattern_ids=[indexed[0]],
    )


def test_exact_recall_merges_best_region_and_caps_candidates_at_fifty(
    repository: Repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    owner = uuid4()
    indexed = [
        _seed_ready_document(
            database_url,
            seed_factory,
            owner_id=owner,
            vector=_unit_vector(index % 10),
        )
        for index in range(60)
    ]
    query_vectors = np.ascontiguousarray(
        np.stack([_unit_vector(index) for index in range(10)]),
        dtype=np.float32,
    )

    candidates = repository.recall_candidates(
        owner_id=owner,
        index_version=INDEX_VERSION,
        allowed_pattern_ids=_ids(indexed),
        query_vectors=query_vectors,
    )

    assert len(candidates) == 50
    assert len({candidate.pattern_id for candidate in candidates}) == 50
    assert candidates[0].best_visual == 1.0
    assert all(-1.0 <= candidate.best_visual <= 1.0 for candidate in candidates)


def test_broad_recall_accepts_more_than_five_hundred_allowed_ids(
    repository: Repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    owner = uuid4()
    indexed = _seed_ready_document(database_url, seed_factory, owner_id=owner)
    allowed = [indexed[0], *(uuid4() for _ in range(500))]

    candidates = repository.recall_candidates(
        owner_id=owner,
        index_version=INDEX_VERSION,
        allowed_pattern_ids=allowed,
        query_vectors=_query_vectors(),
    )

    assert [candidate.pattern_id for candidate in candidates] == [indexed[0]]


def test_global_similarity_is_loaded_after_best_region_candidate_merge(
    repository: Repository,
    seed_factory: SeedFactory,
    database_url: str,
) -> None:
    owner = uuid4()
    competitors = [
        _seed_ready_document(database_url, seed_factory, owner_id=owner)
        for _ in range(11)
    ]
    target_vectors = [_unit_vector(0, sign=-1.0), _unit_vector(1)]
    target_vectors.extend([_unit_vector(2)] * 8)
    target = _seed_ready_document(
        database_url,
        seed_factory,
        owner_id=owner,
        region_vectors=target_vectors,
    )
    query_vectors = [_unit_vector(0), _unit_vector(1)]
    query_vectors.extend([_unit_vector(index) for index in range(2, 10)])

    candidates = repository.recall_candidates(
        owner_id=owner,
        index_version=INDEX_VERSION,
        allowed_pattern_ids=_ids([*competitors, target]),
        query_vectors=np.ascontiguousarray(
            np.stack(query_vectors),
            dtype=np.float32,
        ),
    )

    target_candidate = next(
        candidate for candidate in candidates if candidate.pattern_id == target[0]
    )
    assert target_candidate.best_visual == 1.0
    assert target_candidate.global_visual == -1.0


def test_recall_sql_shapes_lock_exact_and_hnsw_strategies() -> None:
    exact_sql = Repository._exact_recall_sql()
    hnsw_sql = Repository._hnsw_recall_sql()

    assert "AS MATERIALIZED" in exact_sql
    assert "<=>" in exact_sql
    assert "LIMIT %(limit)s" in exact_sql
    assert "AS MATERIALIZED" not in hnsw_sql
    assert "<=>" in hnsw_sql
    assert "ORDER BY e.embedding <=> %(query_vector)s\n" in hnsw_sql
    assert "LIMIT %(limit)s" in hnsw_sql


def test_pgvector_deployment_version_requires_at_least_0_8_0(
    repository: Repository,
) -> None:
    assert validate_pgvector_version("0.8.0") == (0, 8, 0)
    assert validate_pgvector_version("0.8.1") == (0, 8, 1)
    for unsupported in ("0.7.4", "0.8", "not-a-version"):
        with pytest.raises(RuntimeError, match="PGVECTOR_VERSION_UNSUPPORTED"):
            validate_pgvector_version(unsupported)

    assert repository.require_pgvector_compatible() >= (0, 8, 0)


def test_recall_rejects_invalid_vector_contract_and_too_many_ids(
    repository: Repository,
) -> None:
    owner = uuid4()

    for invalid in (
        np.zeros((9, 384), dtype=np.float32),
        np.zeros((10, 383), dtype=np.float32),
        np.zeros((10, 384), dtype=np.float64),
        np.full((10, 384), np.nan, dtype=np.float32),
    ):
        try:
            repository.recall_candidates(
                owner_id=owner,
                index_version=INDEX_VERSION,
                allowed_pattern_ids=[uuid4()],
                query_vectors=invalid,
            )
        except ValueError:
            pass
        else:
            raise AssertionError("invalid query vectors were accepted")

    try:
        repository.recall_candidates(
            owner_id=owner,
            index_version=INDEX_VERSION,
            allowed_pattern_ids=[uuid4() for _ in range(10_001)],
            query_vectors=_query_vectors(),
        )
    except ValueError:
        pass
    else:
        raise AssertionError("more than 10,000 allowed IDs were accepted")
