from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol
from uuid import UUID

import alibabacloud_oss_v2 as oss  # type: ignore[import-untyped]
from alibabacloud_credentials.client import Client as CredentialClient  # type: ignore[import-untyped]
from alibabacloud_credentials.models import Config as CredentialConfig  # type: ignore[import-untyped]
from alibabacloud_oss_v2.exceptions import ServiceError  # type: ignore[import-untyped]

_VERSION_PATTERN = re.compile(r"^[a-z0-9-]{1,64}$")
_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_PREVIEW_EXTENSIONS = frozenset({"jpg", "jpeg", "png", "webp"})


class StorageKeyError(ValueError):
    code = "INDEX_STORAGE_KEY_INVALID"

    def __init__(self) -> None:
        super().__init__(self.code)


class PreviewNotFoundError(FileNotFoundError):
    code = "INDEX_PREVIEW_NOT_FOUND"

    def __init__(self) -> None:
        super().__init__(self.code)


@dataclass(frozen=True)
class StoredObject:
    key: str
    last_modified: datetime


@dataclass(frozen=True)
class WriteResult:
    key: str
    created: bool


class FeatureStorage(Protocol):
    def read_preview(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        key: str,
    ) -> bytes: ...

    def write_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
        payload: bytes,
        *,
        now: datetime | None = None,
    ) -> WriteResult: ...

    def read_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
    ) -> bytes: ...

    def delete_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
    ) -> None: ...

    def list_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
    ) -> tuple[StoredObject, ...]: ...


@dataclass(frozen=True)
class _MemoryObject:
    payload: bytes
    last_modified: datetime


def _canonical_uuid(value: object) -> UUID:
    if isinstance(value, UUID):
        return value
    if not isinstance(value, str):
        raise StorageKeyError()
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as error:
        raise StorageKeyError() from error
    if str(parsed) != value:
        raise StorageKeyError()
    return parsed


def _index_version(value: object) -> str:
    if not isinstance(value, str) or not _VERSION_PATTERN.fullmatch(value):
        raise StorageKeyError()
    return value


def _preview_hash(value: object) -> str:
    if not isinstance(value, str) or not _HASH_PATTERN.fullmatch(value):
        raise StorageKeyError()
    return value


def build_derived_key(
    owner_id: object,
    pattern_id: object,
    index_version: object,
    preview_hash: object,
) -> str:
    owner = _canonical_uuid(owner_id)
    pattern = _canonical_uuid(pattern_id)
    version = _index_version(index_version)
    fingerprint = _preview_hash(preview_hash)
    return (
        f"users/{owner}/patterns/{pattern}/derived/search/"
        f"{version}/{fingerprint}.npz"
    )


def derived_prefix(
    owner_id: object,
    pattern_id: object,
    index_version: object,
) -> str:
    owner = _canonical_uuid(owner_id)
    pattern = _canonical_uuid(pattern_id)
    version = _index_version(index_version)
    return f"users/{owner}/patterns/{pattern}/derived/search/{version}/"


def parse_derived_key(key: str) -> tuple[UUID, UUID, str, str]:
    if not isinstance(key, str):
        raise StorageKeyError()
    segments = key.split("/")
    if (
        len(segments) != 8
        or segments[0] != "users"
        or segments[2] != "patterns"
        or segments[4:6] != ["derived", "search"]
        or not segments[7].endswith(".npz")
    ):
        raise StorageKeyError()
    owner = _canonical_uuid(segments[1])
    pattern = _canonical_uuid(segments[3])
    version = _index_version(segments[6])
    fingerprint = _preview_hash(segments[7].removesuffix(".npz"))
    if build_derived_key(owner, pattern, version, fingerprint) != key:
        raise StorageKeyError()
    return owner, pattern, version, fingerprint


def _parse_preview_key(key: str) -> tuple[UUID, UUID, UUID, str]:
    if not isinstance(key, str):
        raise StorageKeyError()
    segments = key.split("/")
    filename = segments[5] if len(segments) == 6 else ""
    separator = filename.rfind(".")
    if (
        len(segments) != 6
        or segments[0] != "users"
        or segments[2] != "patterns"
        or segments[4] != "derived"
        or separator <= 0
    ):
        raise StorageKeyError()
    extension = filename[separator + 1 :]
    if extension not in _PREVIEW_EXTENSIONS:
        raise StorageKeyError()
    owner = _canonical_uuid(segments[1])
    pattern = _canonical_uuid(segments[3])
    asset = _canonical_uuid(filename[:separator])
    canonical = f"users/{owner}/patterns/{pattern}/derived/{asset}.{extension}"
    if canonical != key:
        raise StorageKeyError()
    return owner, pattern, asset, extension


def validate_preview_key(
    owner_id: object,
    pattern_id: object,
    key: str,
) -> str:
    expected_owner = _canonical_uuid(owner_id)
    expected_pattern = _canonical_uuid(pattern_id)
    owner, pattern, _, _ = _parse_preview_key(key)
    if owner != expected_owner or pattern != expected_pattern:
        raise StorageKeyError()
    return key


def _validated_bytes(payload: object) -> bytes:
    if not isinstance(payload, (bytes, bytearray, memoryview)):
        raise TypeError("storage payload must be bytes")
    return bytes(payload)


def _validated_time(value: datetime | None) -> datetime:
    result = value or datetime.now(timezone.utc)
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("object timestamps must be timezone-aware")
    return result


class InMemoryStorage:
    """Strict in-memory adapter for worker and cleanup tests."""

    def __init__(self) -> None:
        self._objects: dict[str, _MemoryObject] = {}
        self.write_count = 0

    @property
    def object_keys(self) -> tuple[str, ...]:
        return tuple(sorted(self._objects))

    def seed_preview(
        self,
        key: str,
        payload: bytes,
        *,
        last_modified: datetime,
    ) -> None:
        _parse_preview_key(key)
        self._objects[key] = _MemoryObject(
            payload=_validated_bytes(payload),
            last_modified=_validated_time(last_modified),
        )

    def read_preview(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        key: str,
    ) -> bytes:
        canonical = validate_preview_key(owner_id, pattern_id, key)
        try:
            return bytes(self._objects[canonical].payload)
        except KeyError:
            raise PreviewNotFoundError() from None

    def write_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
        payload: bytes,
        *,
        now: datetime | None = None,
    ) -> WriteResult:
        key = build_derived_key(
            owner_id,
            pattern_id,
            index_version,
            preview_hash,
        )
        if key in self._objects:
            return WriteResult(key=key, created=False)
        self._objects[key] = _MemoryObject(
            payload=_validated_bytes(payload),
            last_modified=_validated_time(now),
        )
        self.write_count += 1
        return WriteResult(key=key, created=True)

    def read_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
    ) -> bytes:
        key = build_derived_key(owner_id, pattern_id, index_version, preview_hash)
        return bytes(self._objects[key].payload)

    def delete_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
    ) -> None:
        key = build_derived_key(owner_id, pattern_id, index_version, preview_hash)
        self._objects.pop(key, None)

    def list_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
    ) -> tuple[StoredObject, ...]:
        prefix = derived_prefix(owner_id, pattern_id, index_version)
        return tuple(
            StoredObject(key=key, last_modified=value.last_modified)
            for key, value in sorted(self._objects.items())
            if key.startswith(prefix)
        )


# OSS requires this base at runtime; its untyped SDK exposes the base as Any.
class _CredentialProvider(oss.CredentialsProvider):  # type: ignore[misc]
    def __init__(self, client: Any) -> None:
        self._client = client

    def get_credentials(self) -> Any:
        credential = self._client.get_credential()
        access_key_id = getattr(credential, "access_key_id", None)
        access_key_secret = getattr(credential, "access_key_secret", None)
        security_token = getattr(credential, "security_token", None)
        if not access_key_id or not access_key_secret:
            raise RuntimeError("INDEX_STORAGE_CREDENTIAL_INVALID")
        return oss.Credentials(
            access_key_id,
            access_key_secret,
            security_token,
        )


class AlibabaOssStorage:
    def __init__(
        self,
        *,
        region: str,
        bucket: str,
        endpoint: str,
        environment: str,
        credential_client_factory: Any = CredentialClient,
        client_factory: Any = oss.Client,
    ) -> None:
        credential_client = (
            credential_client_factory(CredentialConfig(type="ecs_ram_role"))
            if environment == "production"
            else credential_client_factory()
        )
        provider = _CredentialProvider(credential_client)
        config = oss.Config(
            region=region,
            endpoint=endpoint,
            credentials_provider=provider,
            retry_max_attempts=3,
        )
        self._bucket = bucket
        self._client = client_factory(config)

    def _read(self, key: str) -> bytes:
        result = self._client.get_object(
            oss.GetObjectRequest(bucket=self._bucket, key=key)
        )
        body = result.body
        if body is None:
            raise RuntimeError("INDEX_STORAGE_RESPONSE_INVALID")
        try:
            payload = body.read()
        finally:
            body.close()
        return _validated_bytes(payload)

    def read_preview(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        key: str,
    ) -> bytes:
        try:
            return self._read(validate_preview_key(owner_id, pattern_id, key))
        except ServiceError as error:
            if error.status_code == 404:
                raise PreviewNotFoundError() from None
            raise

    def write_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
        payload: bytes,
        *,
        now: datetime | None = None,
    ) -> WriteResult:
        del now
        key = build_derived_key(
            owner_id,
            pattern_id,
            index_version,
            preview_hash,
        )
        encoded = _validated_bytes(payload)
        try:
            self._client.put_object(
                oss.PutObjectRequest(
                    bucket=self._bucket,
                    key=key,
                    body=encoded,
                    content_length=len(encoded),
                    content_type="application/octet-stream",
                    forbid_overwrite=True,
                )
            )
        except ServiceError as error:
            if error.status_code == 409 and error.code in {
                "FileAlreadyExists",
                "ObjectAlreadyExists",
            }:
                return WriteResult(key=key, created=False)
            raise
        return WriteResult(key=key, created=True)

    def read_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
    ) -> bytes:
        return self._read(
            build_derived_key(owner_id, pattern_id, index_version, preview_hash)
        )

    def delete_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
        preview_hash: str,
    ) -> None:
        key = build_derived_key(owner_id, pattern_id, index_version, preview_hash)
        self._client.delete_object(
            oss.DeleteObjectRequest(bucket=self._bucket, key=key)
        )

    def list_features(
        self,
        owner_id: UUID,
        pattern_id: UUID,
        index_version: str,
    ) -> tuple[StoredObject, ...]:
        prefix = derived_prefix(owner_id, pattern_id, index_version)
        continuation_token: str | None = None
        seen_tokens: set[str] = set()
        objects: list[StoredObject] = []
        while True:
            result = self._client.list_objects_v2(
                oss.ListObjectsV2Request(
                    bucket=self._bucket,
                    prefix=prefix,
                    max_keys=1000,
                    continuation_token=continuation_token,
                )
            )
            for item in result.contents or ():
                key = item.key
                modified = item.last_modified
                if not isinstance(key, str) or not isinstance(modified, datetime):
                    raise RuntimeError("INDEX_STORAGE_RESPONSE_INVALID")
                parsed_owner, parsed_pattern, parsed_version, _ = parse_derived_key(key)
                if (
                    parsed_owner != owner_id
                    or parsed_pattern != pattern_id
                    or parsed_version != index_version
                ):
                    raise RuntimeError("INDEX_STORAGE_RESPONSE_INVALID")
                objects.append(
                    StoredObject(
                        key=key,
                        last_modified=_validated_time(modified),
                    )
                )
            if not result.is_truncated:
                break
            next_token = result.next_continuation_token
            if (
                not isinstance(next_token, str)
                or not next_token
                or next_token in seen_tokens
            ):
                raise RuntimeError("INDEX_STORAGE_RESPONSE_INVALID")
            seen_tokens.add(next_token)
            continuation_token = next_token
        return tuple(sorted(objects, key=lambda item: item.key))
