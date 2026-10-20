from __future__ import annotations

import os
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest

from melon_visual_search.repository import Repository

TEST_DATABASE_URL = "postgres://melon:melon@127.0.0.1:55432/melon_test"
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)
INDEX_VERSION = "visual-search-v1"


@dataclass(frozen=True)
class SeededJob:
    id: UUID
    owner_id: UUID
    pattern_id: UUID
    preview_asset_id: UUID
    preview_object_key: str
    index_version: str


class SeedFactory:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.owner_ids: set[UUID] = set()
        self.worker_ids: set[str] = set()

    def job(
        self,
        *,
        owner_id: UUID | None = None,
        pattern_id: UUID | None = None,
        preview_asset_id: UUID | None = None,
        preview_hash: str | None = None,
        preview_object_key: str | None = None,
        index_version: str = INDEX_VERSION,
        status: str = "pending",
        available_at: datetime = NOW,
    ) -> SeededJob:
        owner_id = owner_id or uuid4()
        pattern_id = pattern_id or uuid4()
        preview_asset_id = preview_asset_id or uuid4()
        job_id = uuid4()
        preview_object_key = preview_object_key or (
            f"users/{owner_id}/patterns/{pattern_id}/derived/"
            f"{preview_asset_id}.webp"
        )
        self.owner_ids.add(owner_id)

        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                """
                INSERT INTO users (id, email, display_name, password_hash)
                VALUES (%s, %s, 'Visual Search Test', 'not-a-real-password')
                ON CONFLICT (id) DO NOTHING
                """,
                (owner_id, f"visual-search-{owner_id}@example.test"),
            )
            connection.execute(
                """
                INSERT INTO patterns (
                    id, owner_id, name, original_filename, extension,
                    size_bytes, status, preview_status
                )
                VALUES (%s, %s, 'Test pattern', 'pattern.png', 'png',
                        1024, 'ready', 'ready')
                ON CONFLICT (id) DO NOTHING
                """,
                (pattern_id, owner_id),
            )
            connection.execute(
                """
                INSERT INTO assets (
                    id, owner_id, pattern_id, role, object_key,
                    original_filename, detected_mime_type, size_bytes,
                    width, height, content_hash
                )
                VALUES (
                    %s, %s, %s, 'preview', %s,
                    'preview.webp', 'image/webp', 1024, 512, 512, %s
                )
                ON CONFLICT (id) DO NOTHING
                """,
                (
                    preview_asset_id,
                    owner_id,
                    pattern_id,
                    preview_object_key,
                    preview_hash,
                ),
            )
            connection.execute(
                """
                INSERT INTO visual_search_jobs (
                    id, owner_id, pattern_id, preview_asset_id, preview_hash,
                    index_version, status, available_at, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    job_id,
                    owner_id,
                    pattern_id,
                    preview_asset_id,
                    preview_hash,
                    index_version,
                    status,
                    available_at,
                    NOW,
                    NOW,
                ),
            )

        return SeededJob(
            id=job_id,
            owner_id=owner_id,
            pattern_id=pattern_id,
            preview_asset_id=preview_asset_id,
            preview_object_key=preview_object_key,
            index_version=index_version,
        )

    def remember_worker(self, worker_id: str) -> None:
        self.worker_ids.add(worker_id)

    def cleanup(self) -> None:
        with psycopg.connect(self.database_url) as connection:
            if self.owner_ids:
                owner_ids = list(self.owner_ids)
                connection.execute(
                    "DELETE FROM visual_search_embeddings WHERE owner_id = ANY(%s)",
                    (owner_ids,),
                )
                connection.execute(
                    "DELETE FROM visual_search_documents WHERE owner_id = ANY(%s)",
                    (owner_ids,),
                )
                connection.execute(
                    "DELETE FROM visual_search_jobs WHERE owner_id = ANY(%s)",
                    (owner_ids,),
                )
                connection.execute(
                    "DELETE FROM assets WHERE owner_id = ANY(%s)",
                    (owner_ids,),
                )
                connection.execute(
                    "DELETE FROM patterns WHERE owner_id = ANY(%s)",
                    (owner_ids,),
                )
                connection.execute(
                    "DELETE FROM users WHERE id = ANY(%s)",
                    (owner_ids,),
                )
            if self.worker_ids:
                connection.execute(
                    "DELETE FROM visual_search_workers WHERE worker_id = ANY(%s)",
                    (list(self.worker_ids),),
                )


@pytest.fixture(scope="session")
def database_url() -> str:
    value = os.environ.get("VISUAL_SEARCH_DATABASE_URL", TEST_DATABASE_URL)
    with psycopg.connect(value, connect_timeout=2) as connection:
        database_name = connection.execute("SELECT current_database()").fetchone()[0]
    if not str(database_name).endswith("_test"):
        pytest.fail("visual-search integration tests require a *_test database")
    return value


@pytest.fixture
def repository(database_url: str) -> Iterator[Repository]:
    instance = Repository(database_url, min_size=1, max_size=8)
    yield instance
    instance.close()


@pytest.fixture
def seed_factory(database_url: str) -> Iterator[SeedFactory]:
    factory = SeedFactory(database_url)
    yield factory
    factory.cleanup()


@pytest.fixture
def seeded_job(seed_factory: SeedFactory) -> SeededJob:
    return seed_factory.job()


@pytest.fixture
def db_query(database_url: str) -> Any:
    def query(statement: str, parameters: tuple[object, ...] = ()) -> list[tuple[Any, ...]]:
        with psycopg.connect(database_url) as connection:
            return list(connection.execute(statement, parameters).fetchall())

    return query
