from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest
from alibabacloud_oss_v2.exceptions import ServiceError
from conftest import NOW

from melon_visual_search.storage import (
    AlibabaOssStorage,
    InMemoryStorage,
    PreviewNotFoundError,
    StorageKeyError,
    StoredObject,
    build_derived_key,
    derived_prefix,
    parse_derived_key,
    validate_preview_key,
)

OWNER_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
OTHER_OWNER_ID = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
PATTERN_ID = UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
OTHER_PATTERN_ID = UUID("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
ASSET_ID = UUID("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
INDEX_VERSION = "visual-search-v1"
PREVIEW_HASH = "12" * 32


def preview_key(
    *,
    owner_id: UUID = OWNER_ID,
    pattern_id: UUID = PATTERN_ID,
    asset_id: UUID = ASSET_ID,
    extension: str = "webp",
) -> str:
    return (
        f"users/{owner_id}/patterns/{pattern_id}/derived/"
        f"{asset_id}.{extension}"
    )


def test_builds_and_parses_only_the_canonical_derived_key() -> None:
    key = build_derived_key(
        OWNER_ID,
        PATTERN_ID,
        INDEX_VERSION,
        PREVIEW_HASH,
    )

    assert key == (
        f"users/{OWNER_ID}/patterns/{PATTERN_ID}/derived/search/"
        f"{INDEX_VERSION}/{PREVIEW_HASH}.npz"
    )
    assert parse_derived_key(key) == (
        OWNER_ID,
        PATTERN_ID,
        INDEX_VERSION,
        PREVIEW_HASH,
    )
    assert derived_prefix(OWNER_ID, PATTERN_ID, INDEX_VERSION) == (
        f"users/{OWNER_ID}/patterns/{PATTERN_ID}/derived/search/"
        f"{INDEX_VERSION}/"
    )


@pytest.mark.parametrize(
    ("owner_id", "pattern_id", "version", "preview_hash"),
    [
        ("not-a-uuid", PATTERN_ID, INDEX_VERSION, PREVIEW_HASH),
        (OWNER_ID, "../foreign", INDEX_VERSION, PREVIEW_HASH),
        (OWNER_ID, PATTERN_ID, "Visual-Search-v1", PREVIEW_HASH),
        (OWNER_ID, PATTERN_ID, "visual.search.v1", PREVIEW_HASH),
        (OWNER_ID, PATTERN_ID, "v" * 65, PREVIEW_HASH),
        (OWNER_ID, PATTERN_ID, INDEX_VERSION, "A" * 64),
        (OWNER_ID, PATTERN_ID, INDEX_VERSION, "0" * 63),
        (OWNER_ID, PATTERN_ID, INDEX_VERSION, "../" + "0" * 61),
    ],
)
def test_rejects_noncanonical_derived_key_segments(
    owner_id: object,
    pattern_id: object,
    version: str,
    preview_hash: str,
) -> None:
    with pytest.raises(StorageKeyError):
        build_derived_key(owner_id, pattern_id, version, preview_hash)


@pytest.mark.parametrize(
    "key",
    [
        "https://example.test/preview.webp",
        f"users/{OWNER_ID}/patterns/{PATTERN_ID}/derived/../source/file.webp",
        preview_key(owner_id=OTHER_OWNER_ID),
        preview_key(pattern_id=OTHER_PATTERN_ID),
        f"users/{OWNER_ID}/patterns/{PATTERN_ID}/source/{ASSET_ID}.png",
        (
            f"users/{OWNER_ID}/patterns/{PATTERN_ID}/derived/search/"
            f"{INDEX_VERSION}/{PREVIEW_HASH}.npz"
        ),
        preview_key().replace(str(ASSET_ID), str(ASSET_ID).upper()),
        preview_key(extension="svg"),
    ],
)
def test_preview_key_rejects_urls_traversal_and_foreign_scope(key: str) -> None:
    with pytest.raises(StorageKeyError):
        validate_preview_key(OWNER_ID, PATTERN_ID, key)


def test_preview_key_accepts_the_database_canonical_form() -> None:
    assert validate_preview_key(OWNER_ID, PATTERN_ID, preview_key()) == preview_key()


def test_memory_storage_reads_only_the_scoped_preview() -> None:
    storage = InMemoryStorage()
    key = preview_key()
    storage.seed_preview(key, b"preview", last_modified=NOW)

    assert storage.read_preview(OWNER_ID, PATTERN_ID, key) == b"preview"
    with pytest.raises(StorageKeyError):
        storage.read_preview(OTHER_OWNER_ID, PATTERN_ID, key)


def test_missing_preview_raises_a_stable_terminal_storage_error() -> None:
    storage = InMemoryStorage()

    with pytest.raises(PreviewNotFoundError) as error:
        storage.read_preview(OWNER_ID, PATTERN_ID, preview_key())

    assert str(error.value) == "INDEX_PREVIEW_NOT_FOUND"


def test_oss_404_preview_raises_a_stable_terminal_storage_error() -> None:
    class MissingObjectClient:
        def get_object(self, request: object) -> object:
            raise ServiceError(
                status_code=404,
                code="NoSuchKey",
                request_id="test-request",
                message="not found",
                ec=None,
                timestamp=None,
                request_target="test-target",
            )

    storage = AlibabaOssStorage(
        region="cn-shanghai",
        bucket="melon-private-assets",
        endpoint="https://oss-cn-shanghai.aliyuncs.com",
        environment="test",
        credential_client_factory=lambda: SimpleNamespace(get_credential=lambda: None),
        client_factory=lambda config: MissingObjectClient(),
    )

    with pytest.raises(PreviewNotFoundError) as error:
        storage.read_preview(OWNER_ID, PATTERN_ID, preview_key())

    assert str(error.value) == "INDEX_PREVIEW_NOT_FOUND"


def test_memory_storage_writes_without_overwriting_an_existing_fingerprint() -> None:
    storage = InMemoryStorage()

    first = storage.write_features(
        OWNER_ID,
        PATTERN_ID,
        INDEX_VERSION,
        PREVIEW_HASH,
        b"first",
        now=NOW,
    )
    replay = storage.write_features(
        OWNER_ID,
        PATTERN_ID,
        INDEX_VERSION,
        PREVIEW_HASH,
        b"different",
        now=NOW + timedelta(hours=1),
    )

    assert first.created is True
    assert replay.created is False
    assert replay.key == first.key
    assert storage.read_features(
        OWNER_ID,
        PATTERN_ID,
        INDEX_VERSION,
        PREVIEW_HASH,
    ) == b"first"
    assert storage.write_count == 1


def test_memory_storage_lists_and_deletes_only_one_canonical_prefix() -> None:
    storage = InMemoryStorage()
    own = storage.write_features(
        OWNER_ID,
        PATTERN_ID,
        INDEX_VERSION,
        PREVIEW_HASH,
        b"own",
        now=NOW,
    )
    storage.write_features(
        OWNER_ID,
        OTHER_PATTERN_ID,
        INDEX_VERSION,
        "34" * 32,
        b"other-pattern",
        now=NOW,
    )
    storage.write_features(
        OTHER_OWNER_ID,
        PATTERN_ID,
        INDEX_VERSION,
        "56" * 32,
        b"other-owner",
        now=NOW,
    )

    assert storage.list_features(OWNER_ID, PATTERN_ID, INDEX_VERSION) == (
        StoredObject(key=own.key, last_modified=NOW),
    )
    storage.delete_features(OWNER_ID, PATTERN_ID, INDEX_VERSION, PREVIEW_HASH)
    assert storage.list_features(OWNER_ID, PATTERN_ID, INDEX_VERSION) == ()
    assert len(storage.object_keys) == 2


@pytest.mark.parametrize(
    "environment",
    ["development", "test"],
)
def test_nonproduction_oss_uses_the_default_credential_chain(environment: str) -> None:
    credential_configs: list[object] = []

    def credential_client_factory(config: object = None) -> object:
        credential_configs.append(config)
        return SimpleNamespace(get_credential=lambda: None)

    AlibabaOssStorage(
        region="cn-shanghai",
        bucket="melon-private-assets",
        endpoint="https://oss-cn-shanghai.aliyuncs.com",
        environment=environment,
        credential_client_factory=credential_client_factory,
        client_factory=lambda config: SimpleNamespace(config=config),
    )

    assert credential_configs == [None]


def test_production_oss_explicitly_uses_ecs_ram_role_credentials() -> None:
    credential_configs: list[object] = []

    def credential_client_factory(config: object = None) -> object:
        credential_configs.append(config)
        return SimpleNamespace(get_credential=lambda: None)

    AlibabaOssStorage(
        region="cn-shanghai",
        bucket="melon-private-assets",
        endpoint="https://oss-cn-shanghai.aliyuncs.com",
        environment="production",
        credential_client_factory=credential_client_factory,
        client_factory=lambda config: SimpleNamespace(config=config),
    )

    assert len(credential_configs) == 1
    assert credential_configs[0].type == "ecs_ram_role"  # type: ignore[attr-defined]
