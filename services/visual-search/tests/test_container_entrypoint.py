from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from melon_visual_search import container_entrypoint


def test_preflight_requires_lock_environment_and_mounted_model_to_match(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"checksum-locked-model"
    checksum = hashlib.sha256(payload).hexdigest()
    model = tmp_path / "dinov2-small.onnx"
    model.write_bytes(payload)
    monkeypatch.setattr(
        container_entrypoint,
        "load_model_contract",
        lambda lock_path: SimpleNamespace(
            artifact_sha256=checksum,
            artifact_size_bytes=len(payload),
        ),
    )

    container_entrypoint.verify_model_artifact(
        lock_path=tmp_path / "model-lock.json",
        model_path=model,
        expected_sha256=checksum,
    )

    with pytest.raises(container_entrypoint.ContainerPreflightError):
        container_entrypoint.verify_model_artifact(
            lock_path=tmp_path / "model-lock.json",
            model_path=model,
            expected_sha256="0" * 64,
        )

    model.write_bytes(b"changed")
    with pytest.raises(container_entrypoint.ContainerPreflightError):
        container_entrypoint.verify_model_artifact(
            lock_path=tmp_path / "model-lock.json",
            model_path=model,
            expected_sha256=checksum,
        )


def test_entrypoint_executes_only_after_preflight(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(container_entrypoint, "verify_model_artifact", lambda **_: None)

    result = container_entrypoint.run(
        ["melon-visual-search", "worker"],
        environ={
            "VISUAL_SEARCH_MODEL_LOCK_PATH": str(tmp_path / "model-lock.json"),
            "VISUAL_SEARCH_MODEL_PATH": str(tmp_path / "model.onnx"),
            "VISUAL_SEARCH_MODEL_SHA256": "a" * 64,
        },
        exec_fn=lambda executable, argv: calls.append((executable, argv)),
    )

    assert result == 0
    assert calls == [
        (
            "melon-visual-search",
            ["melon-visual-search", "worker"],
        )
    ]


def test_entrypoint_rejects_missing_command_without_exposing_environment() -> None:
    with pytest.raises(container_entrypoint.ContainerPreflightError) as raised:
        container_entrypoint.run([], environ={}, exec_fn=lambda *_: None)

    assert str(raised.value) == "IMAGE_SEARCH_CONTAINER_PREFLIGHT_FAILED"
