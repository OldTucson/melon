from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import stat
import threading
import time
from collections.abc import AsyncIterator, Iterator
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from tempfile import SpooledTemporaryFile
from uuid import UUID, uuid4

import pytest
import starlette.formparsers as starlette_formparsers
from httpx import ASGITransport, AsyncByteStream, AsyncClient
from pydantic import ValidationError
from starlette.datastructures import UploadFile

from melon_visual_search import app as app_module
from melon_visual_search import auth as auth_module
from melon_visual_search.app import (
    SearchConcurrencyLimiter,
    app,
    get_search_limiter,
    get_search_service,
)
from melon_visual_search.image_io import (
    IMAGE_SEARCH_IMAGE_TOO_LARGE,
    IMAGE_SEARCH_INVALID_FILE,
    ImageSearchError,
)
from melon_visual_search.search import (
    NoIndexError,
    SearchItem,
    SearchResult,
    SearchUnavailableError,
)
from melon_visual_search.settings import Settings, get_settings

INTERNAL_TOKEN = "test-token-with-at-least-thirty-two-bytes"
OTHER_INTERNAL_TOKEN = "other-token-with-at-least-thirty-two-bytes"
MODEL_SHA256 = "a" * 64
FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures"
OWNER_ID = uuid4()
PATTERN_ID = uuid4()
REQUEST_ID = uuid4()
MULTIPART_BOUNDARY = "melon-test-boundary"


def make_settings(tmp_path: Path, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "internal_token": INTERNAL_TOKEN,
        "active_version": "visual-search-v1",
        "model_path": tmp_path / "missing-model.onnx",
        "model_sha256": MODEL_SHA256,
        "temp_dir": tmp_path / "temp",
        "max_concurrency": 1,
        "host": "127.0.0.1",
        "port": 8091,
    }
    values.update(overrides)
    return Settings(**values)


def production_settings(tmp_path: Path, **overrides: object) -> dict[str, object]:
    model_path = tmp_path / "model.onnx"
    model_path.write_bytes(b"model")
    values: dict[str, object] = {
        "environment": "production",
        "database_url": "postgresql://melon:database-secret@127.0.0.1:5432/melon",
        "oss_region": "cn-shanghai",
        "oss_bucket": "melon-private-assets",
        "oss_endpoint": "https://oss-cn-shanghai.aliyuncs.com",
        "internal_token": INTERNAL_TOKEN,
        "active_version": "visual-search-v1",
        "model_path": model_path,
        "model_sha256": hashlib.sha256(b"model").hexdigest(),
        "temp_dir": tmp_path / "temp",
        "max_concurrency": 1,
        "host": "127.0.0.1",
        "port": 8091,
    }
    values.update(overrides)
    return values


@pytest.fixture(autouse=True)
def isolate_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    search_service_cache = app_module._get_search_service
    search_limiter_cache = app_module._get_search_limiter
    app_module._start_accepting_searches()
    for name in tuple(os.environ):
        if name.startswith("VISUAL_SEARCH_"):
            monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    search_service_cache.cache_clear()
    search_limiter_cache.cache_clear()
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()
    search_service_cache.cache_clear()
    search_limiter_cache.cache_clear()
    get_settings.cache_clear()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
async def client(settings: Settings) -> AsyncIterator[AsyncClient]:
    app.dependency_overrides[get_settings] = lambda: settings
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as test_client:
        yield test_client


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {INTERNAL_TOKEN}"}


async def test_rejects_missing_internal_token(client: AsyncClient) -> None:
    response = await client.get("/internal/health")

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "INTERNAL_AUTH_REQUIRED"}}


async def test_rejects_wrong_internal_token(client: AsyncClient) -> None:
    response = await client.get(
        "/internal/health",
        headers={"Authorization": f"Bearer {OTHER_INTERNAL_TOKEN}"},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "INTERNAL_AUTH_REQUIRED"}}


async def test_auth_uses_constant_time_comparison(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []
    original_compare_digest = auth_module.secrets.compare_digest

    def capture_compare_digest(candidate: str, expected: str) -> bool:
        calls.append((candidate, expected))
        return original_compare_digest(candidate, expected)

    monkeypatch.setattr(auth_module.secrets, "compare_digest", capture_compare_digest)

    response = await client.get(
        "/internal/health",
        headers={"Authorization": f"Bearer {OTHER_INTERNAL_TOKEN}"},
    )

    assert response.status_code == 401
    assert calls == [
        (
            f"Bearer {OTHER_INTERNAL_TOKEN}",
            f"Bearer {INTERNAL_TOKEN}",
        )
    ]


async def test_health_reports_version_without_loading_a_missing_model(
    client: AsyncClient,
    auth_headers: dict[str, str],
) -> None:
    response = await client.get("/internal/health", headers=auth_headers)

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "indexVersion": "visual-search-v1",
        "modelLoaded": False,
    }


async def test_health_reports_matching_model_artifact_as_loaded(tmp_path: Path) -> None:
    model_path = tmp_path / "model.onnx"
    model_bytes = b"a deterministic test model artifact"
    model_path.write_bytes(model_bytes)
    settings = make_settings(
        tmp_path,
        active_version="visual-search-v2",
        model_path=model_path,
        model_sha256=hashlib.sha256(model_bytes).hexdigest(),
    )
    app.dependency_overrides[get_settings] = lambda: settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(
            "/internal/health",
            headers={"Authorization": f"Bearer {INTERNAL_TOKEN}"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "indexVersion": "visual-search-v2",
        "modelLoaded": True,
    }


async def test_health_rejects_a_model_with_the_wrong_checksum(tmp_path: Path) -> None:
    model_path = tmp_path / "model.onnx"
    model_path.write_bytes(b"unexpected model")
    settings = make_settings(tmp_path, model_path=model_path, model_sha256=MODEL_SHA256)
    app.dependency_overrides[get_settings] = lambda: settings

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(
            "/internal/health",
            headers={"Authorization": f"Bearer {INTERNAL_TOKEN}"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "indexVersion": "visual-search-v1",
        "modelLoaded": False,
    }


@pytest.mark.parametrize("host", ["0.0.0.0", "localhost", "192.168.1.10"])
def test_production_rejects_non_loopback_service_host(tmp_path: Path, host: str) -> None:
    with pytest.raises(ValidationError):
        Settings(**production_settings(tmp_path, host=host))


@pytest.mark.parametrize("host", ["127.0.0.1", "::1"])
def test_production_accepts_only_supported_loopback_hosts(tmp_path: Path, host: str) -> None:
    settings = Settings(**production_settings(tmp_path, host=host))

    assert settings.host == host


def test_production_host_validation_applies_to_prefixed_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    values = production_settings(tmp_path, host="0.0.0.0")
    for field, value in values.items():
        env_name = "VISUAL_SEARCH_ENV" if field == "environment" else f"VISUAL_SEARCH_{field.upper()}"
        monkeypatch.setenv(env_name, str(value))

    with pytest.raises(ValidationError):
        Settings()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("internal_token", "too-short"),
        ("internal_token", "contains whitespace despite enough characters"),
        ("model_sha256", "not-a-sha256"),
        ("model_sha256", "A" * 64),
        ("max_concurrency", 0),
        ("max_concurrency", -1),
        ("port", 0),
        ("port", 65536),
    ],
)
def test_rejects_invalid_security_and_runtime_values(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    with pytest.raises(ValidationError):
        make_settings(tmp_path, **{field: value})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("database_url", "mysql://melon:secret@127.0.0.1/melon"),
        ("oss_region", "CN Shanghai"),
        ("oss_region", "oss-cn-shanghai"),
        ("oss_bucket", "Invalid_Bucket"),
        ("oss_endpoint", "oss-cn-shanghai.aliyuncs.com"),
        ("oss_endpoint", "https://user:secret@oss.example.test/private?token=secret"),
        ("active_version", "Visual Search V1"),
        ("active_version", "visual.search.v1"),
        ("active_version", "visual_search_v1"),
        ("active_version", "v" * 65),
        ("production_database_name", "melon production"),
        ("host", ""),
    ],
)
def test_rejects_noncanonical_settings(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    with pytest.raises(ValidationError):
        make_settings(tmp_path, **{field: value})


@pytest.mark.parametrize(
    "missing_field",
    [
        "database_url",
        "oss_region",
        "oss_bucket",
        "oss_endpoint",
        "model_path",
        "model_sha256",
    ],
)
def test_production_rejects_missing_external_service_and_model_settings(
    tmp_path: Path,
    missing_field: str,
) -> None:
    values = production_settings(tmp_path)
    values.pop(missing_field)

    with pytest.raises(ValidationError):
        Settings(**values)


def test_settings_repr_and_validation_errors_do_not_disclose_secrets(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    database_password = "database-password-that-must-stay-secret"
    token = "internal-token-that-must-stay-secret"
    settings = make_settings(
        tmp_path,
        database_url=f"postgresql://melon:{database_password}@127.0.0.1/melon",
        internal_token=token,
    )

    assert database_password not in repr(settings)
    assert token not in repr(settings)

    caplog.set_level(logging.DEBUG)
    with pytest.raises(ValidationError) as error:
        make_settings(
            tmp_path,
            database_url=f"mysql://melon:{database_password}@127.0.0.1/melon",
            internal_token=token,
            model_sha256="invalid",
        )

    rendered_error = str(error.value)
    rendered_logs = caplog.text
    assert database_password not in rendered_error
    assert token not in rendered_error
    assert database_password not in rendered_logs
    assert token not in rendered_logs


@pytest.mark.parametrize(
    "production_failure",
    [
        {"host": "0.0.0.0"},
        {"model_sha256": None},
    ],
    ids=["unsafe-host", "missing-model-setting"],
)
def test_all_validation_error_representations_hide_secrets(
    tmp_path: Path,
    production_failure: dict[str, object],
) -> None:
    token_canary = "TOKEN_CANARY_1234567890_ABCDEFGHIJ"
    password_canary = "PASSWORD_CANARY_0987654321"
    values = production_settings(
        tmp_path,
        database_url=(
            f"postgresql://melon:{password_canary}@127.0.0.1:5432/melon"
        ),
        internal_token=token_canary,
        **production_failure,
    )

    with pytest.raises(ValidationError) as captured:
        Settings(**values)

    error = captured.value
    representations = {
        "str": str(error),
        "repr": repr(error),
        "errors": repr(error.errors()),
        "json": error.json(),
    }
    for representation in representations.values():
        assert token_canary not in representation
        assert password_canary not in representation


def test_get_settings_cache_can_be_reset_between_isolated_environments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISUAL_SEARCH_INTERNAL_TOKEN", INTERNAL_TOKEN)
    first = get_settings()
    monkeypatch.setenv("VISUAL_SEARCH_INTERNAL_TOKEN", OTHER_INTERNAL_TOKEN)

    assert get_settings() is first

    get_settings.cache_clear()
    second = get_settings()

    assert second is not first
    assert second.internal_token.get_secret_value() == OTHER_INTERNAL_TOKEN


def test_settings_ignore_unrelated_environment_variables(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISUAL_SEARCH_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setenv("SOME_UNRELATED_SETTING", "ignored")

    settings = Settings()

    assert settings.internal_token.get_secret_value() == INTERNAL_TOKEN


def test_model_source_is_exact_and_immutable() -> None:
    from tools.export_model import load_model_source

    source_path = Path(__file__).parents[1] / "model-source.json"

    source = load_model_source(source_path)

    assert source.repo_id == "facebook/dinov2-small"
    assert source.revision == "ed25f3a31f01632728cabb09d1542f84ab7b0056"
    assert source.license == "Apache-2.0"
    assert source.task == "feature-extraction"
    assert source.input_size == 224
    assert source.dimensions == 384


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("repoId", "facebook/dinov2-base"),
        ("revision", "a" * 40),
        ("license", "MIT"),
        ("task", "image-classification"),
        ("inputSize", 256),
        ("dimensions", 768),
    ],
)
def test_export_cli_rejects_every_source_identity_mutation_before_export(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    replacement: str | int,
) -> None:
    from tools import export_model as export_tool

    source_data = json.loads(
        (Path(__file__).parents[1] / "model-source.json").read_text(encoding="utf-8")
    )
    source_data[field] = replacement
    source_path = tmp_path / "model-source.json"
    source_path.write_text(json.dumps(source_data), encoding="utf-8")
    export_called = False

    def forbidden_export(*args: object, **kwargs: object) -> dict[str, object]:
        nonlocal export_called
        export_called = True
        raise AssertionError("export must not run for an unapproved source")

    monkeypatch.setattr(export_tool, "export_model", forbidden_export)

    with pytest.raises(SystemExit) as captured:
        export_tool.main(
            [
                "--source",
                str(source_path),
                "--output",
                str(tmp_path / "model.onnx"),
                "--lock",
                str(tmp_path / "model-lock.json"),
            ]
        )

    assert captured.value.code == 1
    assert export_called is False


@pytest.mark.parametrize("revision", ["main", "latest", "ed25f3a"])
def test_model_source_rejects_floating_or_abbreviated_revisions(
    tmp_path: Path,
    revision: str,
) -> None:
    from tools.export_model import ExportError, load_model_source

    source_path = tmp_path / "model-source.json"
    source_path.write_text(
        json.dumps(
            {
                "repoId": "facebook/dinov2-small",
                "revision": revision,
                "license": "Apache-2.0",
                "task": "feature-extraction",
                "inputSize": 224,
                "dimensions": 384,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ExportError, match="40-character commit"):
        load_model_source(source_path)


def test_model_source_rejects_unknown_contract_fields(tmp_path: Path) -> None:
    from tools.export_model import ExportError, load_model_source

    source_path = tmp_path / "model-source.json"
    source_path.write_text(
        json.dumps(
            {
                "repoId": "facebook/dinov2-small",
                "revision": "ed25f3a31f01632728cabb09d1542f84ab7b0056",
                "license": "Apache-2.0",
                "task": "feature-extraction",
                "inputSize": 224,
                "dimensions": 384,
                "unreviewedOption": True,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ExportError, match="exactly"):
        load_model_source(source_path)


def test_model_artifact_sha256_is_streamed(tmp_path: Path) -> None:
    from tools.export_model import sha256_file

    model_path = tmp_path / "model.onnx"
    model_bytes = (b"deterministic-model-chunk" * 100_000) + b"tail"
    model_path.write_bytes(model_bytes)

    assert sha256_file(model_path) == hashlib.sha256(model_bytes).hexdigest()


def test_output_parity_enforces_the_absolute_error_limit() -> None:
    import numpy as np

    from tools.export_model import ExportError, _validate_output_parity

    reference = np.array([10.0], dtype=np.float32)
    candidate = np.array([10.0009], dtype=np.float32)

    with pytest.raises(ExportError, match="maximum absolute error"):
        _validate_output_parity(candidate, reference)


def test_dynamic_batch_runtime_validation_rejects_a_fixed_batch_session() -> None:
    import numpy as np

    from tools.export_model import ExportError, _run_onnx_validation_batch

    class FixedBatchSession:
        def run(
            self,
            output_names: list[str],
            input_feed: dict[str, object],
        ) -> list[object]:
            assert output_names == ["last_hidden_state"]
            model_input = input_feed["pixel_values"]
            assert isinstance(model_input, np.ndarray)
            assert model_input.shape[0] == 1
            raise RuntimeError("session was traced for a fixed batch of two")

    model_input = np.zeros((1, 3, 224, 224), dtype=np.float32)

    with pytest.raises(ExportError, match="dynamic batch validation failed"):
        _run_onnx_validation_batch(
            FixedBatchSession(),
            model_input,
            batch_size=1,
            token_count=257,
            dimensions=384,
            label="dynamic batch validation",
        )


def test_content_addressed_artifact_preserves_requested_location_and_basename(
    tmp_path: Path,
) -> None:
    from tools.export_model import content_addressed_artifact_path

    requested = tmp_path / "models" / "dinov2-small.onnx"
    checksum = "a" * 64

    derived = content_addressed_artifact_path(requested, checksum)

    assert derived == requested.with_name(f"dinov2-small.{checksum}.onnx")


def test_resolve_locked_artifact_accepts_a_checksum_qualified_path_under_root(
    tmp_path: Path,
) -> None:
    from tools.export_model import resolve_locked_artifact

    checksum = "a" * 64
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    artifact = models_dir / f"dinov2-small.{checksum}.onnx"
    lock_path = tmp_path / "model-lock.json"
    manifest: dict[str, object] = {
        "artifact": {
            "path": artifact.relative_to(tmp_path).as_posix(),
            "sha256": checksum,
        }
    }

    assert resolve_locked_artifact(
        lock_path,
        manifest,
        artifact_root=models_dir,
    ) == artifact.resolve()


def test_resolve_locked_artifact_rejects_parent_traversal(tmp_path: Path) -> None:
    from tools.export_model import ExportError, resolve_locked_artifact

    checksum = "a" * 64
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    lock_path = tmp_path / "model-lock.json"
    manifest: dict[str, object] = {
        "artifact": {
            "path": f"models/../outside/dinov2-small.{checksum}.onnx",
            "sha256": checksum,
        }
    }

    with pytest.raises(ExportError, match="parent traversal"):
        resolve_locked_artifact(
            lock_path,
            manifest,
            artifact_root=models_dir,
        )


def test_resolve_locked_artifact_rejects_a_symlink_escape_before_opening_it(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tools.export_model import ExportError, resolve_locked_artifact

    checksum = "a" * 64
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    escaped_artifact = outside_dir / f"dinov2-small.{checksum}.onnx"
    escaped_bytes = b"outside-root"
    escaped_artifact.write_bytes(escaped_bytes)
    (models_dir / "linked").symlink_to(outside_dir, target_is_directory=True)
    lock_path = tmp_path / "model-lock.json"
    manifest: dict[str, object] = {
        "artifact": {
            "path": f"models/linked/{escaped_artifact.name}",
            "sha256": checksum,
        }
    }
    original_open = Path.open

    def reject_escaped_open(path: Path, *args: object, **kwargs: object) -> object:
        if path.resolve() == escaped_artifact.resolve():
            raise AssertionError("escaped artifact must not be opened")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", reject_escaped_open)

    with pytest.raises(ExportError, match="artifact root"):
        resolve_locked_artifact(
            lock_path,
            manifest,
            artifact_root=models_dir,
        )

    monkeypatch.setattr(Path, "open", original_open)
    assert escaped_artifact.read_bytes() == escaped_bytes


def test_resolve_locked_artifact_rejects_checksum_basename_mismatch(
    tmp_path: Path,
) -> None:
    from tools.export_model import ExportError, resolve_locked_artifact

    declared_checksum = "a" * 64
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    lock_path = tmp_path / "model-lock.json"
    manifest: dict[str, object] = {
        "artifact": {
            "path": f"models/dinov2-small.{'b' * 64}.onnx",
            "sha256": declared_checksum,
        }
    }

    with pytest.raises(ExportError, match="declared checksum"):
        resolve_locked_artifact(
            lock_path,
            manifest,
            artifact_root=models_dir,
        )


def test_owned_staging_preserves_selected_paths_and_valid_generation(
    tmp_path: Path,
) -> None:
    from tools import export_model as export_tool

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    requested = models_dir / "dinov2-small.onnx"
    requested.write_bytes(b"selected-output")
    lock_path = models_dir / ".dinov2-small.active.onnx.tmp"
    lock_path.write_bytes(b"selected-lock")
    current_generation = models_dir / "dinov2-small.current.onnx"
    current_generation.write_bytes(b"current-generation")
    abandoned = models_dir / (
        f"{export_tool._staging_prefix('artifact', requested)}crashed"
    )
    abandoned.mkdir()
    (abandoned / "model.onnx.tmp").write_bytes(b"abandoned")

    staging = export_tool._open_export_staging(requested, lock_path)
    artifact_staging = staging.artifact_directory
    manifest_staging = staging.manifest_directory
    try:
        assert abandoned.exists() is False
        assert requested.read_bytes() == b"selected-output"
        assert lock_path.read_bytes() == b"selected-lock"
        assert current_generation.read_bytes() == b"current-generation"
    finally:
        staging.close()

    assert artifact_staging.exists() is False
    assert manifest_staging.exists() is False
    assert requested.read_bytes() == b"selected-output"
    assert lock_path.read_bytes() == b"selected-lock"
    assert current_generation.read_bytes() == b"current-generation"


def test_owned_staging_does_not_delete_another_exporters_workspace(
    tmp_path: Path,
) -> None:
    from tools import export_model as export_tool

    first_output = tmp_path / "first.onnx"
    first_lock = tmp_path / "first-lock.json"
    second_output = tmp_path / "second.onnx"
    second_lock = tmp_path / "second-lock.json"
    first = export_tool._open_export_staging(first_output, first_lock)
    first_sentinel = first.artifact_directory / "in-progress.onnx.tmp"
    first_sentinel.write_bytes(b"in-progress")
    second = export_tool._open_export_staging(second_output, second_lock)
    try:
        assert first_sentinel.read_bytes() == b"in-progress"
        assert first.artifact_directory.exists()
    finally:
        second.close()
        first.close()


def test_manifest_commit_publishes_a_resolvable_immutable_generation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tools import export_model as export_tool

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    old_artifact = models_dir / "dinov2-small.old.onnx"
    old_artifact.write_bytes(b"old-generation")
    lock_path = tmp_path / "model-lock.json"
    lock_path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "artifact": {
                    "path": "models/dinov2-small.old.onnx",
                    "sha256": hashlib.sha256(b"old-generation").hexdigest(),
                },
            }
        ),
        encoding="utf-8",
    )
    requested = models_dir / "dinov2-small.onnx"
    staged = models_dir / ".dinov2-small.staged.onnx.tmp"
    staged.write_bytes(b"new-generation")
    checksum = hashlib.sha256(b"new-generation").hexdigest()
    immutable = export_tool.content_addressed_artifact_path(requested, checksum)
    lock_data: dict[str, object] = {
        "schemaVersion": 2,
        "artifact": {
            "path": os.path.relpath(immutable, lock_path.parent),
            "requestedPath": os.path.relpath(requested, lock_path.parent),
            "sha256": checksum,
            "sizeBytes": len(b"new-generation"),
        },
    }
    events: list[tuple[str, Path]] = []
    original_replace = export_tool.os.replace

    monkeypatch.setattr(
        export_tool,
        "_fsync_file",
        lambda path: events.append(("fsync-file", Path(path))),
    )
    monkeypatch.setattr(
        export_tool,
        "_fsync_directory",
        lambda path: events.append(("fsync-directory", Path(path))),
    )

    def record_replace(source: Path, destination: Path) -> None:
        events.append(("replace-manifest", Path(destination)))
        original_replace(source, destination)

    monkeypatch.setattr(export_tool.os, "replace", record_replace)

    published = export_tool._publish_model_generation(
        staged,
        immutable,
        lock_path,
        lock_data,
    )

    manifest = json.loads(lock_path.read_text(encoding="utf-8"))
    resolved = export_tool.resolve_locked_artifact(
        lock_path,
        manifest,
        artifact_root=models_dir,
    )
    assert published == immutable
    assert resolved == immutable.resolve()
    assert export_tool.sha256_file(resolved) == manifest["artifact"]["sha256"]
    assert old_artifact.read_bytes() == b"old-generation"
    assert staged.exists() is False
    assert events == [
        ("fsync-file", immutable),
        ("fsync-directory", models_dir),
        ("replace-manifest", lock_path),
        ("fsync-directory", tmp_path),
    ]


def test_failed_manifest_commit_keeps_old_generation_and_cleans_staging(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tools import export_model as export_tool

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    old_artifact = models_dir / "dinov2-small.old.onnx"
    old_artifact.write_bytes(b"old-generation")
    lock_path = tmp_path / "model-lock.json"
    old_lock = b'{"artifact":{"path":"models/dinov2-small.old.onnx"}}\n'
    lock_path.write_bytes(old_lock)
    requested = models_dir / "dinov2-small.onnx"
    staged = models_dir / ".dinov2-small.staged.onnx.tmp"
    staged.write_bytes(b"new-generation")
    checksum = hashlib.sha256(b"new-generation").hexdigest()
    immutable = export_tool.content_addressed_artifact_path(requested, checksum)
    lock_data: dict[str, object] = {
        "schemaVersion": 2,
        "artifact": {
            "path": os.path.relpath(immutable, lock_path.parent),
            "requestedPath": os.path.relpath(requested, lock_path.parent),
            "sha256": checksum,
        },
    }

    def fail_manifest_replace(source: Path, destination: Path) -> None:
        raise OSError("simulated manifest commit failure")

    monkeypatch.setattr(export_tool.os, "replace", fail_manifest_replace)

    with pytest.raises(OSError, match="simulated manifest commit failure"):
        export_tool._publish_model_generation(
            staged,
            immutable,
            lock_path,
            lock_data,
        )

    assert lock_path.read_bytes() == old_lock
    assert old_artifact.read_bytes() == b"old-generation"
    assert immutable.exists() is False
    assert staged.exists() is False
    assert list(tmp_path.glob(".model-lock.json.*.tmp")) == []


def test_publication_never_overwrites_an_existing_immutable_artifact(
    tmp_path: Path,
) -> None:
    from tools import export_model as export_tool

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    requested = models_dir / "dinov2-small.onnx"
    staged = models_dir / ".dinov2-small.staged.onnx.tmp"
    staged.write_bytes(b"candidate-generation")
    checksum = hashlib.sha256(b"candidate-generation").hexdigest()
    immutable = export_tool.content_addressed_artifact_path(requested, checksum)
    immutable.write_bytes(b"existing-content-must-not-change")
    lock_path = tmp_path / "model-lock.json"
    old_lock = b'{"generation":"old"}\n'
    lock_path.write_bytes(old_lock)
    lock_data: dict[str, object] = {
        "schemaVersion": 2,
        "artifact": {
            "path": os.path.relpath(immutable, lock_path.parent),
            "requestedPath": os.path.relpath(requested, lock_path.parent),
            "sha256": checksum,
        },
    }

    with pytest.raises(export_tool.ExportError, match="immutable artifact"):
        export_tool._publish_model_generation(
            staged,
            immutable,
            lock_path,
            lock_data,
        )

    assert immutable.read_bytes() == b"existing-content-must-not-change"
    assert lock_path.read_bytes() == old_lock
    assert staged.exists() is False


def test_publication_rejects_an_immutable_artifact_symlink_escape(
    tmp_path: Path,
) -> None:
    from tools import export_model as export_tool

    model_bytes = b"candidate-generation"
    checksum = hashlib.sha256(model_bytes).hexdigest()
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    outside_artifact = outside_dir / f"dinov2-small.{checksum}.onnx"
    outside_artifact.write_bytes(model_bytes)
    immutable = models_dir / outside_artifact.name
    immutable.symlink_to(outside_artifact)
    staged = models_dir / ".dinov2-small.staged.onnx.tmp"
    staged.write_bytes(model_bytes)
    lock_path = tmp_path / "model-lock.json"
    old_lock = b'{"generation":"old"}\n'
    lock_path.write_bytes(old_lock)
    lock_data: dict[str, object] = {
        "schemaVersion": 2,
        "artifact": {
            "path": os.path.relpath(immutable, lock_path.parent),
            "sha256": checksum,
        },
    }

    with pytest.raises(export_tool.ExportError, match="artifact root"):
        export_tool._publish_model_generation(
            staged,
            immutable,
            lock_path,
            lock_data,
        )

    assert lock_path.read_bytes() == old_lock
    assert outside_artifact.read_bytes() == model_bytes
    assert immutable.is_symlink()
    assert staged.exists() is False


def test_publication_rejects_artifact_manifest_path_collision_before_changes(
    tmp_path: Path,
) -> None:
    from tools import export_model as export_tool

    models_dir = tmp_path / "models"
    models_dir.mkdir()
    requested = models_dir / "dinov2-small.onnx"
    requested_bytes = b"requested-output-must-not-change"
    requested.write_bytes(requested_bytes)
    previous_artifact = models_dir / "dinov2-small.previous.onnx"
    previous_artifact_bytes = b"previous-model-generation"
    previous_artifact.write_bytes(previous_artifact_bytes)
    previous_manifest = tmp_path / "previous-model-lock.json"
    previous_manifest_bytes = b'{"generation":"previous"}\n'
    previous_manifest.write_bytes(previous_manifest_bytes)
    staged = models_dir / ".candidate.onnx.tmp"
    staged.write_bytes(b"candidate-generation")
    checksum = hashlib.sha256(b"candidate-generation").hexdigest()
    collision_path = export_tool.content_addressed_artifact_path(requested, checksum)
    lock_data: dict[str, object] = {
        "schemaVersion": 2,
        "artifact": {
            "path": collision_path.name,
            "requestedPath": requested.name,
            "sha256": checksum,
        },
    }

    with pytest.raises(export_tool.ExportError, match="distinct"):
        export_tool._publish_model_generation(
            staged,
            collision_path,
            collision_path,
            lock_data,
        )

    assert collision_path.exists() is False
    assert requested.read_bytes() == requested_bytes
    assert previous_artifact.read_bytes() == previous_artifact_bytes
    assert previous_manifest.read_bytes() == previous_manifest_bytes
    assert staged.exists() is False
    assert list(models_dir.glob(f".{collision_path.name}.*.tmp")) == []


@pytest.mark.parametrize(
    "exception_text",
    [
        "token=EXPORT_ERROR_CANARY",
        "HF_TOKEN=EXPORT_ERROR_CANARY",
        "https://user:EXPORT_ERROR_CANARY@example.test/model",
        "Authorization: Bearer EXPORT_ERROR_CANARY",
        '{"internal_token":"EXPORT_ERROR_CANARY"}',
        "{'password': 'EXPORT_ERROR_CANARY'}",
    ],
)
def test_export_cli_never_prints_raw_exception_credentials(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    exception_text: str,
) -> None:
    from tools import export_model as export_tool

    def fail_export(*args: object, **kwargs: object) -> dict[str, object]:
        raise RuntimeError(exception_text)

    monkeypatch.setattr(export_tool, "export_model", fail_export)

    with pytest.raises(SystemExit) as captured:
        export_tool.main(
            [
                "--source",
                str(Path(__file__).parents[1] / "model-source.json"),
                "--output",
                str(tmp_path / "model.onnx"),
                "--lock",
                str(tmp_path / "model-lock.json"),
            ]
        )

    assert captured.value.code == 1
    assert capsys.readouterr().err == (
        "error: stage=model-export code=MODEL_EXPORT_FAILED "
        "exception=RuntimeError\n"
    )


def test_source_errors_report_safe_stage_context_without_raw_details(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from tools import export_model as export_tool

    def fail_source(path: Path) -> export_tool.ModelSource:
        raise OSError("https://user:SOURCE_ERROR_CANARY@example.test/model")

    monkeypatch.setattr(export_tool, "load_model_source", fail_source)

    with pytest.raises(SystemExit) as captured:
        export_tool.main(
            [
                "--source",
                str(tmp_path / "model-source.json"),
                "--output",
                str(tmp_path / "model.onnx"),
                "--lock",
                str(tmp_path / "model-lock.json"),
            ]
        )

    assert captured.value.code == 1
    assert capsys.readouterr().err == (
        "error: stage=source-validation code=MODEL_SOURCE_INVALID "
        "exception=OSError\n"
    )


class StubSearchService:
    def __init__(
        self,
        *,
        result: SearchResult | None = None,
        error: Exception | None = None,
    ) -> None:
        self.result = result or SearchResult(width=400, height=368, items=())
        self.error = error
        self.calls: list[tuple[UUID, tuple[UUID, ...], bytes]] = []
        self.temp_file_modes: list[int] = []
        self.temp_dir: Path | None = None

    def search_encoded(
        self,
        owner_id: UUID,
        allowed_pattern_ids: tuple[UUID, ...],
        encoded: bytes,
    ) -> SearchResult:
        self.calls.append((owner_id, allowed_pattern_ids, encoded))
        if self.temp_dir is not None:
            paths = list(self.temp_dir.iterdir())
            assert len(paths) == 1
            self.temp_file_modes.append(stat.S_IMODE(paths[0].stat().st_mode))
        if self.error is not None:
            raise self.error
        return self.result


class BlockingSearchService(StubSearchService):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def search_encoded(
        self,
        owner_id: UUID,
        allowed_pattern_ids: tuple[UUID, ...],
        encoded: bytes,
    ) -> SearchResult:
        self.calls.append((owner_id, allowed_pattern_ids, encoded))
        self.started.set()
        if not self.release.wait(timeout=5):
            raise RuntimeError("test search release timed out")
        return self.result


class ClosableBlockingSearchService(BlockingSearchService):
    def __init__(self) -> None:
        super().__init__()
        self.closed = threading.Event()

    def close(self) -> None:
        self.closed.set()


class PausingSecondAcquireLimiter(SearchConcurrencyLimiter):
    def __init__(self) -> None:
        super().__init__(2)
        self.acquire_calls = 0
        self.second_waiting = asyncio.Event()
        self.allow_second = asyncio.Event()

    async def try_acquire(self) -> bool:
        self.acquire_calls += 1
        if self.acquire_calls == 2:
            self.second_waiting.set()
            await self.allow_second.wait()
        return await super().try_acquire()


def _search_result() -> SearchResult:
    return SearchResult(
        width=400,
        height=368,
        items=(
            SearchItem(
                pattern_id=PATTERN_ID,
                kind="possible_source",
                score=0.91234567,
                category_rank=2,
            ),
        ),
    )


def _search_form(
    *,
    owner_id: str = str(OWNER_ID),
    allowed_ids: list[str] | None = None,
    request_id: str = str(REQUEST_ID),
) -> dict[str, str]:
    return {
        "ownerId": owner_id,
        "allowedPatternIds": json.dumps(
            allowed_ids if allowed_ids is not None else [str(PATTERN_ID)]
        ),
        "requestId": request_id,
    }


def _multipart_body(
    *,
    fields: list[tuple[str, str]],
    files: list[tuple[str, str, bytes]],
    boundary: str = MULTIPART_BOUNDARY,
) -> bytes:
    chunks: list[bytes] = []
    for name, value in fields:
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                value.encode(),
                b"\r\n",
            ]
        )
    for name, filename, payload in files:
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{filename}"\r\n'
                ).encode(),
                b"Content-Type: image/jpeg\r\n\r\n",
                payload,
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks)


def _search_fields() -> list[tuple[str, str]]:
    return list(_search_form().items())


class RecordingAsyncStream(AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.yielded: list[int] = []

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for index, chunk in enumerate(self.chunks):
            self.yielded.append(index)
            yield chunk


async def _post_search(
    client: AsyncClient,
    auth_headers: dict[str, str],
    *,
    image: bytes | None = None,
    data: dict[str, str] | None = None,
):
    return await client.post(
        "/internal/search",
        headers=auth_headers,
        data=data or _search_form(),
        files={
            "image": (
                "query.jpg",
                image
                if image is not None
                else (FIXTURE_DIRECTORY / "checker-crop.jpg").read_bytes(),
                "image/jpeg",
            )
        },
    )


@pytest.fixture
async def search_client(
    settings: Settings,
) -> AsyncIterator[tuple[AsyncClient, StubSearchService]]:
    service = StubSearchService(result=_search_result())
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_search_service] = lambda: service
    app.dependency_overrides[get_search_limiter] = lambda: SearchConcurrencyLimiter(1)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client, service


async def test_internal_search_requires_bearer_auth(
    search_client: tuple[AsyncClient, StubSearchService],
) -> None:
    client, service = search_client

    response = await client.post(
        "/internal/search",
        data=_search_form(),
        files={"image": ("query.jpg", b"image", "image/jpeg")},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "INTERNAL_AUTH_REQUIRED"}}
    assert service.calls == []


@pytest.mark.parametrize(
    "authorization",
    [None, f"Bearer {OTHER_INTERNAL_TOKEN}"],
    ids=["missing", "invalid"],
)
async def test_internal_search_rejects_auth_without_reading_body(
    search_client: tuple[AsyncClient, StubSearchService],
    authorization: str | None,
) -> None:
    client, service = search_client
    body = _multipart_body(
        fields=_search_fields(),
        files=[("image", "query.jpg", b"query")],
    )
    stream = RecordingAsyncStream([body[:32], body[32:]])
    headers = {"content-type": f"multipart/form-data; boundary={MULTIPART_BOUNDARY}"}
    if authorization is not None:
        headers["authorization"] = authorization

    response = await client.post(
        "/internal/search",
        headers=headers,
        content=stream,
    )

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "INTERNAL_AUTH_REQUIRED"}}
    assert stream.yielded == []
    assert service.calls == []


async def test_internal_search_maps_service_initialization_failure_without_detail(
    settings: Settings,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unavailable_service() -> StubSearchService:
        raise RuntimeError("database password and /secret/model/path")

    monkeypatch.setattr(app_module, "_get_search_service", unavailable_service)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_search_limiter] = lambda: SearchConcurrencyLimiter(1)
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await _post_search(client, auth_headers)

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "UNAVAILABLE"}}
    assert "password" not in response.text
    assert "/secret/model/path" not in response.text


def test_search_service_cold_start_is_single_flight(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(
        tmp_path,
        database_url="postgresql://melon:melon@127.0.0.1:5432/melon",
        oss_region="cn-shanghai",
        oss_bucket="melon-private-assets",
        oss_endpoint="https://oss-cn-shanghai.aliyuncs.com",
    )
    repository_instances: list[object] = []
    service_instances: list[object] = []

    class CountingRepository:
        def __init__(self, database_url: str) -> None:
            del database_url
            repository_instances.append(self)
            time.sleep(0.05)

        def require_pgvector_compatible(self) -> tuple[int, int, int]:
            return (0, 8, 0)

        def close(self) -> None:
            return None

    class CountingService:
        def __init__(self, *args: object, **kwargs: object) -> None:
            del args, kwargs
            service_instances.append(self)

    monkeypatch.setattr(app_module, "get_settings", lambda: settings)
    monkeypatch.setattr(app_module, "Repository", CountingRepository)
    monkeypatch.setattr(app_module, "AlibabaOssStorage", lambda **kwargs: object())
    monkeypatch.setattr(
        app_module,
        "load_embedding_runtime",
        lambda *args, **kwargs: object(),
    )
    monkeypatch.setattr(app_module, "SearchService", CountingService)
    app_module._get_search_service.cache_clear()
    barrier = threading.Barrier(2)

    def resolve() -> object:
        barrier.wait(timeout=2)
        return app_module.get_search_service()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(resolve)
            second = executor.submit(resolve)
            results = (first.result(timeout=2), second.result(timeout=2))
    finally:
        app_module._get_search_service.cache_clear()

    assert len(repository_instances) == 1
    assert len(service_instances) == 1
    assert results[0] is results[1]


def test_search_limiter_cold_start_is_single_flight(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limiter_instances: list[object] = []

    class CountingLimiter:
        def __init__(self, limit: int) -> None:
            assert limit == 1
            limiter_instances.append(self)
            time.sleep(0.05)

    monkeypatch.setattr(app_module, "get_settings", lambda: settings)
    monkeypatch.setattr(app_module, "SearchConcurrencyLimiter", CountingLimiter)
    cached_limiter = app_module._get_search_limiter
    cached_limiter.cache_clear()
    barrier = threading.Barrier(2)

    def resolve() -> object:
        barrier.wait(timeout=2)
        return app_module.get_search_limiter()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(resolve)
            second = executor.submit(resolve)
            results = (first.result(timeout=2), second.result(timeout=2))
    finally:
        cached_limiter.cache_clear()

    assert len(limiter_instances) == 1
    assert results[0] is results[1]


@pytest.mark.parametrize(
    ("content_type", "content"),
    [
        ("multipart/form-data", b""),
        (
            "multipart/form-data; boundary=melon",
            (
                b"--melon\r\n"
                b"Content-Disposition: form-data\r\n\r\n"
                b"invalid\r\n"
                b"--melon--\r\n"
            ),
        ),
    ],
    ids=["missing-boundary", "missing-part-name"],
)
async def test_internal_search_maps_malformed_multipart_to_invalid_file(
    search_client: tuple[AsyncClient, StubSearchService],
    auth_headers: dict[str, str],
    content_type: str,
    content: bytes,
) -> None:
    client, service = search_client

    response = await client.post(
        "/internal/search",
        headers={**auth_headers, "content-type": content_type},
        content=content,
    )

    assert response.status_code == 415
    assert response.json() == {"detail": {"code": "INVALID_FILE"}}
    assert service.calls == []


@pytest.mark.parametrize(
    "content_length",
    [None, "128"],
    ids=["without-content-length", "forged-content-length"],
)
async def test_internal_search_stops_stream_at_total_body_limit(
    search_client: tuple[AsyncClient, StubSearchService],
    auth_headers: dict[str, str],
    content_length: str | None,
) -> None:
    client, service = search_client
    boundary = MULTIPART_BOUNDARY
    prefix = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="image"; filename="query.jpg"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode()
    suffix = b"\r\n" + _multipart_body(
        fields=_search_fields(),
        files=[],
        boundary=boundary,
    )
    chunks = [prefix, *([b"x" * (1024 * 1024)] * 22), suffix]
    stream = RecordingAsyncStream(chunks)
    headers = {
        **auth_headers,
        "content-type": f"multipart/form-data; boundary={boundary}",
    }
    if content_length is not None:
        headers["content-length"] = content_length

    response = await client.post(
        "/internal/search",
        headers=headers,
        content=stream,
    )

    assert response.status_code == 413
    assert response.json() == {"detail": {"code": "IMAGE_TOO_LARGE"}}
    assert len(stream.yielded) < len(chunks)
    assert service.calls == []


async def test_internal_search_rejects_second_file_before_reading_its_payload(
    search_client: tuple[AsyncClient, StubSearchService],
    auth_headers: dict[str, str],
) -> None:
    client, service = search_client
    boundary = MULTIPART_BOUNDARY
    first_chunk = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="image"; filename="first.jpg"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
        "first\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="attachment"; filename="second.jpg"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode()
    second_payload = b"second-file-payload-must-not-be-read"
    suffix = b"\r\n" + _multipart_body(
        fields=_search_fields(),
        files=[],
        boundary=boundary,
    )
    stream = RecordingAsyncStream([first_chunk, second_payload, suffix])

    response = await client.post(
        "/internal/search",
        headers={
            **auth_headers,
            "content-type": f"multipart/form-data; boundary={boundary}",
        },
        content=stream,
    )

    assert response.status_code == 415
    assert response.json() == {"detail": {"code": "INVALID_FILE"}}
    assert 1 not in stream.yielded
    assert service.calls == []


@pytest.mark.parametrize(
    "fields",
    [
        [*_search_fields(), ("ownerId", str(OWNER_ID))],
        [*_search_fields(), ("unexpected", "value")],
    ],
    ids=["duplicate-field", "extra-field"],
)
async def test_internal_search_requires_exact_text_field_set(
    search_client: tuple[AsyncClient, StubSearchService],
    auth_headers: dict[str, str],
    fields: list[tuple[str, str]],
) -> None:
    client, service = search_client
    body = _multipart_body(
        fields=fields,
        files=[("image", "query.jpg", b"query")],
    )

    response = await client.post(
        "/internal/search",
        headers={
            **auth_headers,
            "content-type": f"multipart/form-data; boundary={MULTIPART_BOUNDARY}",
        },
        content=body,
    )

    assert response.status_code == 415
    assert response.json() == {"detail": {"code": "INVALID_FILE"}}
    assert service.calls == []


@pytest.mark.parametrize(
    "files",
    [
        [
            ("image", ("first.jpg", b"first", "image/jpeg")),
            ("image", ("second.jpg", b"second", "image/jpeg")),
        ],
        [
            ("image", ("query.jpg", b"query", "image/jpeg")),
            ("attachment", ("extra.jpg", b"extra", "image/jpeg")),
        ],
    ],
    ids=["duplicate-image", "extra-named-file"],
)
async def test_internal_search_rejects_additional_file_and_closes_open_spool(
    search_client: tuple[AsyncClient, StubSearchService],
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    files: list[tuple[str, tuple[str, bytes, str]]],
) -> None:
    client, service = search_client
    spools: list[SpooledTemporaryFile[bytes]] = []

    def recording_spooled_file(*, max_size: int) -> SpooledTemporaryFile[bytes]:
        spool = SpooledTemporaryFile(max_size=max_size)
        spools.append(spool)
        return spool

    monkeypatch.setattr(
        starlette_formparsers,
        "SpooledTemporaryFile",
        recording_spooled_file,
    )

    response = await client.post(
        "/internal/search",
        headers=auth_headers,
        data=_search_form(),
        files=files,
    )

    assert response.status_code == 415
    assert response.json() == {"detail": {"code": "INVALID_FILE"}}
    assert service.calls == []
    assert len(spools) == 1
    assert spools[0].closed


async def test_internal_search_validates_and_returns_ranked_diagnostics(
    search_client: tuple[AsyncClient, StubSearchService],
    auth_headers: dict[str, str],
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, service = search_client
    service.temp_dir = settings.temp_dir
    closed: list[str | None] = []
    original_close = UploadFile.close

    async def recording_close(upload: UploadFile) -> None:
        closed.append(upload.filename)
        await original_close(upload)

    monkeypatch.setattr(UploadFile, "close", recording_close)
    encoded = (FIXTURE_DIRECTORY / "checker-crop.jpg").read_bytes()

    response = await _post_search(client, auth_headers, image=encoded)

    assert response.status_code == 200
    assert response.json() == {
        "requestId": str(REQUEST_ID),
        "query": {"width": 400, "height": 368},
        "items": [
            {
                "patternId": str(PATTERN_ID),
                "kind": "possible_source",
                "score": 0.91234567,
            }
        ],
    }
    assert service.calls == [(OWNER_ID, (PATTERN_ID,), encoded)]
    assert service.temp_file_modes == [0o600]
    assert list(settings.temp_dir.iterdir()) == []
    assert closed
    assert set(closed) == {"query.jpg"}


@pytest.mark.parametrize(
    "data",
    [
        _search_form(owner_id=str(OWNER_ID).upper()),
        _search_form(request_id="not-a-uuid"),
        _search_form(allowed_ids=[str(PATTERN_ID).upper()]),
        {
            "ownerId": str(OWNER_ID),
            "allowedPatternIds": "not-json",
            "requestId": str(REQUEST_ID),
        },
        _search_form(allowed_ids=[str(PATTERN_ID), str(PATTERN_ID)]),
        _search_form(allowed_ids=[str(uuid4()) for _ in range(10_001)]),
    ],
    ids=[
        "owner-not-canonical",
        "request-id-invalid",
        "pattern-not-canonical",
        "ids-not-json",
        "duplicate-id",
        "too-many-ids",
    ],
)
async def test_internal_search_rejects_invalid_identity_fields(
    search_client: tuple[AsyncClient, StubSearchService],
    auth_headers: dict[str, str],
    data: dict[str, str],
) -> None:
    client, service = search_client

    response = await _post_search(client, auth_headers, data=data)

    assert response.status_code == 415
    assert response.json() == {"detail": {"code": "INVALID_FILE"}}
    assert service.calls == []


async def test_internal_search_rejects_more_than_twenty_mebibytes(
    search_client: tuple[AsyncClient, StubSearchService],
    auth_headers: dict[str, str],
    settings: Settings,
) -> None:
    client, service = search_client

    response = await _post_search(
        client,
        auth_headers,
        image=b"x" * (20 * 1024 * 1024 + 1),
    )

    assert response.status_code == 413
    assert response.json() == {"detail": {"code": "IMAGE_TOO_LARGE"}}
    assert service.calls == []
    assert list(settings.temp_dir.iterdir()) == []


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (
            ImageSearchError(IMAGE_SEARCH_INVALID_FILE, "bad query"),
            415,
            "INVALID_FILE",
        ),
        (
            ImageSearchError(IMAGE_SEARCH_IMAGE_TOO_LARGE, "large query"),
            413,
            "IMAGE_TOO_LARGE",
        ),
        (NoIndexError(), 409, "NO_INDEX"),
        (SearchUnavailableError(), 503, "UNAVAILABLE"),
        (
            ImageSearchError("IMAGE_SEARCH_INTERNAL_PATH", "/secret/model/path"),
            503,
            "UNAVAILABLE",
        ),
    ],
)
async def test_internal_search_maps_stable_errors_and_cleans_temp_files(
    settings: Settings,
    auth_headers: dict[str, str],
    error: Exception,
    status: int,
    code: str,
) -> None:
    service = StubSearchService(error=error)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_search_service] = lambda: service
    app.dependency_overrides[get_search_limiter] = lambda: SearchConcurrencyLimiter(1)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await _post_search(client, auth_headers)

    assert response.status_code == status
    assert response.json() == {"detail": {"code": code}}
    assert list(settings.temp_dir.iterdir()) == []


async def test_internal_search_returns_busy_without_queueing(
    settings: Settings,
    auth_headers: dict[str, str],
) -> None:
    service = BlockingSearchService()
    limiter = SearchConcurrencyLimiter(1)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_search_service] = lambda: service
    app.dependency_overrides[get_search_limiter] = lambda: limiter
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        first = asyncio.create_task(_post_search(client, auth_headers))
        assert await asyncio.to_thread(service.started.wait, 2)

        second = await _post_search(client, auth_headers)
        service.release.set()
        first_response = await first

    assert second.status_code == 429
    assert second.json() == {"detail": {"code": "BUSY"}}
    assert first_response.status_code == 200
    assert len(service.calls) == 1


async def test_internal_search_timeout_keeps_permit_until_worker_finishes_and_cleans(
    settings: Settings,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = BlockingSearchService()
    limiter = SearchConcurrencyLimiter(1)
    monkeypatch.setattr(app_module, "SEARCH_TIMEOUT_SECONDS", 0.02)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_search_service] = lambda: service
    app.dependency_overrides[get_search_limiter] = lambda: limiter
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await _post_search(client, auth_headers)
        assert response.status_code == 504
        assert response.json() == {"detail": {"code": "TIMEOUT"}}
        assert list(settings.temp_dir.iterdir()) == []

        busy = await _post_search(client, auth_headers)
        assert busy.status_code == 429
        service.release.set()
        for _ in range(100):
            if not limiter.locked:
                break
            await asyncio.sleep(0.01)
        assert not limiter.locked


async def test_internal_search_cancellation_closes_upload_and_deletes_temp_file(
    settings: Settings,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = BlockingSearchService()
    limiter = SearchConcurrencyLimiter(1)
    closed = threading.Event()
    original_close = UploadFile.close

    async def recording_close(upload: UploadFile) -> None:
        await original_close(upload)
        closed.set()

    monkeypatch.setattr(UploadFile, "close", recording_close)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_search_service] = lambda: service
    app.dependency_overrides[get_search_limiter] = lambda: limiter
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        request = asyncio.create_task(_post_search(client, auth_headers))
        assert await asyncio.to_thread(service.started.wait, 2)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert closed.is_set()
        assert list(settings.temp_dir.iterdir()) == []
        assert limiter.locked
        service.release.set()
        for _ in range(100):
            if not limiter.locked:
                break
            await asyncio.sleep(0.01)
        assert not limiter.locked


async def test_lifespan_waits_for_timed_out_worker_before_closing_service(
    settings: Settings,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ClosableBlockingSearchService()
    limiter = PausingSecondAcquireLimiter()

    @lru_cache(maxsize=1)
    def cached_service() -> ClosableBlockingSearchService:
        return service

    monkeypatch.setattr(app_module, "SEARCH_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(app_module, "_get_search_service", cached_service)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_search_limiter] = lambda: limiter
    lifespan = app_module._lifespan(app)
    await lifespan.__aenter__()
    shutdown_task: asyncio.Task[bool | None] | None = None
    racing_request: asyncio.Task[object] | None = None
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            timed_out = await _post_search(client, auth_headers)
            assert timed_out.status_code == 504
            assert timed_out.json() == {"detail": {"code": "TIMEOUT"}}

            racing_request = asyncio.create_task(_post_search(client, auth_headers))
            await asyncio.wait_for(limiter.second_waiting.wait(), timeout=2)
            shutdown_task = asyncio.create_task(
                lifespan.__aexit__(None, None, None)
            )
            await asyncio.sleep(0)
            closed_before_release = service.closed.is_set()
            shutdown_done_before_release = shutdown_task.done()

            limiter.allow_second.set()
            racing_response = await racing_request
            calls_before_release = len(service.calls)
    finally:
        limiter.allow_second.set()
        service.release.set()
        if racing_request is not None and not racing_request.done():
            await asyncio.gather(racing_request, return_exceptions=True)
        if shutdown_task is None:
            await lifespan.__aexit__(None, None, None)
        else:
            await shutdown_task

    assert not closed_before_release
    assert not shutdown_done_before_release
    assert racing_response.status_code == 503
    assert racing_response.json() == {"detail": {"code": "UNAVAILABLE"}}
    assert calls_before_release == 1
    assert service.closed.is_set()


async def test_lifespan_waits_for_cancelled_worker_before_closing_service(
    settings: Settings,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ClosableBlockingSearchService()
    limiter = SearchConcurrencyLimiter(1)

    @lru_cache(maxsize=1)
    def cached_service() -> ClosableBlockingSearchService:
        return service

    monkeypatch.setattr(app_module, "_get_search_service", cached_service)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_search_limiter] = lambda: limiter
    lifespan = app_module._lifespan(app)
    await lifespan.__aenter__()
    shutdown_task: asyncio.Task[bool | None] | None = None
    request: asyncio.Task[object] | None = None
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            request = asyncio.create_task(_post_search(client, auth_headers))
            assert await asyncio.to_thread(service.started.wait, 2)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request

            shutdown_task = asyncio.create_task(
                lifespan.__aexit__(None, None, None)
            )
            await asyncio.sleep(0)
            closed_before_release = service.closed.is_set()
            shutdown_done_before_release = shutdown_task.done()
            stopping_response = await _post_search(client, auth_headers)
            calls_before_release = len(service.calls)
    finally:
        service.release.set()
        if request is not None and not request.done():
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
        if shutdown_task is None:
            await lifespan.__aexit__(None, None, None)
        else:
            await shutdown_task

    assert not closed_before_release
    assert not shutdown_done_before_release
    assert stopping_response.status_code == 503
    assert stopping_response.json() == {"detail": {"code": "UNAVAILABLE"}}
    assert calls_before_release == 1
    assert service.closed.is_set()


async def test_lifespan_waits_for_admitted_request_before_clearing_cold_caches(
    settings: Settings,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ClosableBlockingSearchService()
    service_factory_calls = 0
    admitted = asyncio.Event()
    allow_request = asyncio.Event()
    original_admission = app_module._require_search_running

    @lru_cache(maxsize=1)
    def cached_service() -> ClosableBlockingSearchService:
        nonlocal service_factory_calls
        service_factory_calls += 1
        return service

    async def paused_admission() -> AsyncIterator[None]:
        admission = original_admission()
        admission_iterator = admission if isinstance(admission, Iterator) else None
        if admission_iterator is not None:
            next(admission_iterator)
        admitted.set()
        try:
            await allow_request.wait()
            yield
        finally:
            if admission_iterator is not None:
                try:
                    next(admission_iterator)
                except StopIteration:
                    pass

    monkeypatch.setattr(app_module, "_get_search_service", cached_service)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[original_admission] = paused_admission
    lifespan = app_module._lifespan(app)
    await lifespan.__aenter__()
    shutdown_task: asyncio.Task[bool | None] | None = None
    request: asyncio.Task[object] | None = None
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            request = asyncio.create_task(_post_search(client, auth_headers))
            await asyncio.wait_for(admitted.wait(), timeout=2)
            shutdown_task = asyncio.create_task(
                lifespan.__aexit__(None, None, None)
            )
            await asyncio.sleep(0)
            shutdown_done_while_admitted = shutdown_task.done()

            allow_request.set()
            response = await request
    finally:
        allow_request.set()
        service.release.set()
        if request is not None and not request.done():
            await asyncio.gather(request, return_exceptions=True)
        if shutdown_task is None:
            await lifespan.__aexit__(None, None, None)
        else:
            await shutdown_task

    assert not shutdown_done_while_admitted
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "UNAVAILABLE"}}
    assert service.calls == []
    assert service_factory_calls == 1
    assert service.closed.is_set()
    assert cached_service.cache_info().currsize == 0
    assert app_module._get_search_limiter.cache_info().currsize == 0


async def test_service_initialization_failure_releases_search_admission(
    settings: Settings,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    @lru_cache(maxsize=1)
    def unavailable_service() -> ClosableBlockingSearchService:
        raise RuntimeError("service initialization failed")

    monkeypatch.setattr(app_module, "_get_search_service", unavailable_service)
    app.dependency_overrides[get_settings] = lambda: settings
    lifespan = app_module._lifespan(app)
    await lifespan.__aenter__()
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await _post_search(client, auth_headers)

    await asyncio.wait_for(lifespan.__aexit__(None, None, None), timeout=2)

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "UNAVAILABLE"}}
    assert unavailable_service.cache_info().currsize == 0
