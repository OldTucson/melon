from __future__ import annotations

import copy
import hashlib
import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from PIL import Image

from melon_visual_search.embedding import (
    IMAGE_SEARCH_MODEL_INVALID,
    IMAGE_SEARCH_MODEL_RUNTIME_UNAVAILABLE,
    EmbeddingRuntime,
    EmbeddingRuntimeUnavailableError,
    load_model_contract,
    preprocess_images,
)
from melon_visual_search.image_io import (
    MAX_IMAGE_ASPECT_RATIO,
    ImageSearchError,
    decode_image,
    make_regions,
)

SERVICE_ROOT = Path(__file__).parents[1]
MODEL_LOCK_PATH = SERVICE_ROOT / "model-lock.json"
FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures"


@dataclass
class FakeNode:
    name: str
    type: str
    shape: list[str | int]


class FakeSession:
    def __init__(
        self,
        *,
        input_name: str = "pixel_values",
        output_name: str = "last_hidden_state",
        output_tokens: str | int = 257,
        output_factory: Callable[[int], np.ndarray] | None = None,
    ) -> None:
        self.input_name = input_name
        self.output_name = output_name
        self.output_tokens = output_tokens
        self.output_factory = output_factory or valid_output
        self.run_calls: list[tuple[list[str], dict[str, np.ndarray]]] = []

    def get_inputs(self) -> list[FakeNode]:
        return [FakeNode(self.input_name, "tensor(float)", ["batch", 3, 224, 224])]

    def get_outputs(self) -> list[FakeNode]:
        return [
            FakeNode(
                self.output_name,
                "tensor(float)",
                ["batch", self.output_tokens, 384],
            )
        ]

    def run(
        self,
        output_names: list[str],
        input_feed: dict[str, np.ndarray],
    ) -> list[np.ndarray]:
        self.run_calls.append((output_names, input_feed))
        model_input = input_feed[self.input_name]
        return [self.output_factory(model_input.shape[0])]


class FailingRuntimeSession(FakeSession):
    def run(
        self,
        output_names: list[str],
        input_feed: dict[str, np.ndarray],
    ) -> list[np.ndarray]:
        raise RuntimeError("temporary execution provider failure")


def valid_output(batch_size: int) -> np.ndarray:
    output = np.zeros((batch_size, 257, 384), dtype=np.float32)
    base = np.linspace(0.25, 2.25, 384, dtype=np.float32)
    for index in range(batch_size):
        output[index, 0] = base + index
    return output


def lock_data() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(MODEL_LOCK_PATH.read_text(encoding="utf-8"))
    data["input"]["preprocessing"]["alphaComposite"] = {
        "lightBackground": [240, 240, 240],
        "darkBackground": [24, 24, 24],
        "informationMetric": "grayscale-variance",
        "tieBreak": "light",
    }
    return data


def write_locked_model(
    tmp_path: Path,
    *,
    model_bytes: bytes = b"deterministic fake ONNX model",
    mutate: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[Path, Path, str]:
    checksum = hashlib.sha256(model_bytes).hexdigest()
    models = tmp_path / "models"
    models.mkdir()
    artifact = models / f"dinov2-small.{checksum}.onnx"
    artifact.write_bytes(model_bytes)
    data = copy.deepcopy(lock_data())
    data["artifact"].update(
        {
            "filename": artifact.name,
            "path": f"models/{artifact.name}",
            "sha256": checksum,
            "sizeBytes": len(model_bytes),
        }
    )
    if mutate is not None:
        mutate(data)
    lock_path = tmp_path / "model-lock.json"
    lock_path.write_text(json.dumps(data), encoding="utf-8")
    return lock_path, artifact, checksum


def fake_runtime(
    tmp_path: Path,
    session: FakeSession | None = None,
) -> tuple[EmbeddingRuntime, FakeSession, list[bytes]]:
    lock_path, _, _ = write_locked_model(tmp_path)
    selected_session = session or FakeSession()
    initialized_with: list[bytes] = []

    def session_factory(model: bytes, *, providers: list[str]) -> FakeSession:
        assert providers == ["CPUExecutionProvider"]
        initialized_with.append(model)
        return selected_session

    runtime = EmbeddingRuntime.from_lock(
        lock_path,
        session_factory=session_factory,
    )
    return runtime, selected_session, initialized_with


def checker_regions() -> tuple[Any, ...]:
    checker = decode_image((FIXTURE_DIRECTORY / "checker.png").read_bytes())
    return make_regions(checker)


def test_embeddings_are_batched_once_and_l2_normalized(tmp_path: Path) -> None:
    runtime, session, initialized_with = fake_runtime(tmp_path)

    vectors = runtime.embed(checker_regions())

    assert len(initialized_with) == 1
    assert len(session.run_calls) == 1
    output_names, input_feed = session.run_calls[0]
    assert output_names == ["last_hidden_state"]
    assert list(input_feed) == ["pixel_values"]
    assert input_feed["pixel_values"].shape == (10, 3, 224, 224)
    assert input_feed["pixel_values"].dtype == np.float32
    assert vectors.shape == (10, 384)
    assert vectors.dtype == np.float32
    assert np.isfinite(vectors).all()
    np.testing.assert_allclose(
        np.linalg.norm(vectors, axis=1),
        np.ones(10),
        atol=1e-6,
    )


def test_runtime_execution_failure_has_a_retryable_stable_error(tmp_path: Path) -> None:
    runtime, _, _ = fake_runtime(tmp_path, FailingRuntimeSession())

    with pytest.raises(EmbeddingRuntimeUnavailableError) as captured:
        runtime.embed(checker_regions())

    assert captured.value.code == IMAGE_SEARCH_MODEL_RUNTIME_UNAVAILABLE
    assert str(captured.value) == IMAGE_SEARCH_MODEL_RUNTIME_UNAVAILABLE


def test_preprocessing_uses_every_numeric_value_from_the_lock(tmp_path: Path) -> None:
    lock_path, _, _ = write_locked_model(tmp_path)
    contract = load_model_contract(lock_path)
    image = np.full((96, 160, 3), (255, 128, 0), dtype=np.uint8)

    batch = preprocess_images([image], contract.preprocessing)

    expected_rgb = np.array([1.0, 128.0 / 255.0, 0.0], dtype=np.float32)
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    standard_deviation = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    expected = (expected_rgb - mean) / standard_deviation
    assert batch.shape == (1, 3, 224, 224)
    np.testing.assert_allclose(batch[0, :, 112, 112], expected, atol=1e-6)


def test_committed_lock_records_versioned_alpha_and_model_preprocessing() -> None:
    contract = load_model_contract(MODEL_LOCK_PATH)

    assert contract.preprocessing.alpha_light_background == (240, 240, 240)
    assert contract.preprocessing.alpha_dark_background == (24, 24, 24)
    assert contract.preprocessing.alpha_information_metric == "grayscale-variance"
    assert contract.preprocessing.alpha_tie_break == "light"
    assert contract.preprocessing.resize_shortest_edge == 256
    assert contract.preprocessing.crop_size == (224, 224)
    assert contract.preprocessing.tensor_layout == "NCHW"


def test_committed_lock_versions_the_decode_aspect_ratio() -> None:
    raw = json.loads(MODEL_LOCK_PATH.read_text(encoding="utf-8"))
    contract = load_model_contract(MODEL_LOCK_PATH)

    assert raw["input"]["preprocessing"]["maximumAspectRatio"] == (
        MAX_IMAGE_ASPECT_RATIO
    )
    assert contract.preprocessing.maximum_aspect_ratio == MAX_IMAGE_ASPECT_RATIO


def test_artifact_checksum_is_verified_before_session_creation(tmp_path: Path) -> None:
    lock_path, artifact, _ = write_locked_model(tmp_path)
    artifact.write_bytes(b"tampered")
    calls: list[bytes] = []

    def session_factory(model: bytes, *, providers: list[str]) -> FakeSession:
        calls.append(model)
        return FakeSession()

    with pytest.raises(ImageSearchError) as captured:
        EmbeddingRuntime.from_lock(lock_path, session_factory=session_factory)

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID
    assert calls == []


def test_runtime_loads_the_explicit_deployment_artifact_path(tmp_path: Path) -> None:
    model_bytes = b"deployed deterministic ONNX model"
    lock_path, locked_artifact, checksum = write_locked_model(
        tmp_path,
        model_bytes=model_bytes,
    )
    deployed_directory = tmp_path / "deployed"
    deployed_directory.mkdir()
    deployed_artifact = deployed_directory / "dinov2-small.onnx"
    deployed_artifact.write_bytes(model_bytes)
    locked_artifact.unlink()
    initialized_with: list[bytes] = []

    def session_factory(model: bytes, *, providers: list[str]) -> FakeSession:
        initialized_with.append(model)
        return FakeSession()

    runtime = EmbeddingRuntime.from_lock(
        lock_path,
        artifact_path=deployed_artifact,
        expected_sha256=checksum,
        session_factory=session_factory,
    )

    assert runtime.artifact_path == deployed_artifact.resolve()
    assert runtime.model_sha256 == checksum
    assert initialized_with == [model_bytes]


def test_runtime_rejects_a_configured_checksum_that_differs_from_the_lock(
    tmp_path: Path,
) -> None:
    lock_path, artifact, _ = write_locked_model(tmp_path)
    calls: list[bytes] = []

    def session_factory(model: bytes, *, providers: list[str]) -> FakeSession:
        calls.append(model)
        return FakeSession()

    with pytest.raises(ImageSearchError) as captured:
        EmbeddingRuntime.from_lock(
            lock_path,
            artifact_path=artifact,
            expected_sha256="0" * 64,
            session_factory=session_factory,
        )

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID
    assert calls == []


def test_artifact_parent_traversal_is_rejected_before_session_creation(
    tmp_path: Path,
) -> None:
    def add_traversal(data: dict[str, Any]) -> None:
        data["artifact"]["path"] = (
            f"models/../../outside/dinov2-small.{data['artifact']['sha256']}.onnx"
        )

    lock_path, _, _ = write_locked_model(tmp_path, mutate=add_traversal)
    calls: list[bytes] = []

    with pytest.raises(ImageSearchError) as captured:
        EmbeddingRuntime.from_lock(
            lock_path,
            session_factory=lambda model, *, providers: calls.append(model),
        )

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID
    assert calls == []


def test_artifact_checksum_must_be_the_final_basename_segment(
    tmp_path: Path,
) -> None:
    def add_suffix_after_checksum(data: dict[str, Any]) -> None:
        checksum = data["artifact"]["sha256"]
        filename = f"dinov2-small.{checksum}.copy.onnx"
        original = tmp_path / data["artifact"]["path"]
        renamed = original.with_name(filename)
        original.rename(renamed)
        data["artifact"]["filename"] = filename
        data["artifact"]["path"] = f"models/{filename}"

    lock_path, _, _ = write_locked_model(
        tmp_path,
        mutate=add_suffix_after_checksum,
    )
    calls: list[bytes] = []

    with pytest.raises(ImageSearchError) as captured:
        EmbeddingRuntime.from_lock(
            lock_path,
            session_factory=lambda model, *, providers: calls.append(model),
        )

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID
    assert calls == []


def test_artifact_symlink_escape_is_rejected_before_opening_target(
    tmp_path: Path,
) -> None:
    model_bytes = b"outside model"
    checksum = hashlib.sha256(model_bytes).hexdigest()
    outside = tmp_path / "outside"
    outside.mkdir()
    outside_artifact = outside / f"dinov2-small.{checksum}.onnx"
    outside_artifact.write_bytes(model_bytes)
    models = tmp_path / "models"
    models.mkdir()
    (models / "linked").symlink_to(outside, target_is_directory=True)
    data = lock_data()
    data["artifact"].update(
        {
            "filename": outside_artifact.name,
            "path": f"models/linked/{outside_artifact.name}",
            "sha256": checksum,
            "sizeBytes": len(model_bytes),
        }
    )
    lock_path = tmp_path / "model-lock.json"
    lock_path.write_text(json.dumps(data), encoding="utf-8")
    calls: list[bytes] = []

    with pytest.raises(ImageSearchError) as captured:
        EmbeddingRuntime.from_lock(
            lock_path,
            session_factory=lambda model, *, providers: calls.append(model),
        )

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID
    assert calls == []


@pytest.mark.parametrize("mutation", ["missing", "unknown", "nonfinite"])
def test_model_lock_preprocessing_schema_is_strict(
    tmp_path: Path,
    mutation: str,
) -> None:
    def mutate(data: dict[str, Any]) -> None:
        normalize = data["input"]["preprocessing"]["normalize"]
        if mutation == "missing":
            normalize.pop("mean")
        elif mutation == "unknown":
            normalize["unreviewed"] = 1
        else:
            normalize["mean"][0] = float("nan")

    lock_path, _, _ = write_locked_model(tmp_path, mutate=mutate)

    with pytest.raises(ImageSearchError) as captured:
        load_model_contract(lock_path)

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID


def test_model_lock_rejects_duplicate_top_level_fields(tmp_path: Path) -> None:
    encoded = MODEL_LOCK_PATH.read_text(encoding="utf-8").replace(
        "{",
        '{"schemaVersion": 2,',
        1,
    )
    lock_path = tmp_path / "model-lock.json"
    lock_path.write_text(encoded, encoding="utf-8")

    with pytest.raises(ImageSearchError) as captured:
        load_model_contract(lock_path)

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID


@pytest.mark.parametrize(
    ("field", "duplicate_value"),
    [
        ("sha256", "f" * 64),
        ("path", "../../sensitive-model-location"),
    ],
)
def test_model_lock_rejects_duplicate_nested_artifact_fields(
    tmp_path: Path,
    field: str,
    duplicate_value: str,
) -> None:
    encoded = MODEL_LOCK_PATH.read_text(encoding="utf-8").replace(
        '"artifact": {',
        f'"artifact": {{"{field}": {json.dumps(duplicate_value)},',
        1,
    )
    lock_path = tmp_path / "model-lock.json"
    lock_path.write_text(encoded, encoding="utf-8")

    with pytest.raises(ImageSearchError) as captured:
        load_model_contract(lock_path)

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID
    assert duplicate_value not in str(captured.value)


def test_session_contract_drift_is_rejected(tmp_path: Path) -> None:
    session = FakeSession(input_name="renamed_input")

    with pytest.raises(ImageSearchError) as captured:
        fake_runtime(tmp_path, session)

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID


def test_symbolic_output_token_metadata_is_rejected_before_inference(
    tmp_path: Path,
) -> None:
    session = FakeSession(output_tokens="tokens")

    with pytest.raises(ImageSearchError) as captured:
        fake_runtime(tmp_path, session)

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID
    assert session.run_calls == []


@pytest.mark.parametrize("failure", ["zero", "nan", "shape"])
def test_invalid_model_output_is_rejected(tmp_path: Path, failure: str) -> None:
    def invalid_output(batch_size: int) -> np.ndarray:
        if failure == "shape":
            return np.ones((batch_size, 384), dtype=np.float32)
        output = valid_output(batch_size)
        if failure == "zero":
            output[3, 0] = 0.0
        else:
            output[3, 0, 9] = np.nan
        return output

    runtime, _, _ = fake_runtime(
        tmp_path,
        FakeSession(output_factory=invalid_output),
    )

    with pytest.raises(ImageSearchError) as captured:
        runtime.embed(checker_regions())

    assert captured.value.code == IMAGE_SEARCH_MODEL_INVALID


def test_embed_requires_the_complete_ordered_region_set(tmp_path: Path) -> None:
    runtime, session, _ = fake_runtime(tmp_path)

    with pytest.raises(ValueError, match="ten ordered regions"):
        runtime.embed(checker_regions()[:-1])

    assert session.run_calls == []


def test_exporter_validation_path_calls_runtime_preprocessing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from melon_visual_search import embedding as embedding_module
    from tools import export_model

    calls: list[int] = []
    expected = np.ones((2, 3, 224, 224), dtype=np.float32)

    def capture(
        images: list[np.ndarray],
        preprocessing: object,
    ) -> np.ndarray:
        calls.append(len(images))
        return expected

    monkeypatch.setattr(embedding_module, "preprocess_images", capture)
    images = [Image.new("RGB", (250, 260)), Image.new("RGB", (270, 280))]

    actual = export_model._preprocess_validation_images(
        images,
        lock_data()["input"]["preprocessing"],
    )

    assert calls == [2]
    assert actual is expected


def test_exporter_rejects_a_processor_without_explicit_rgb_conversion() -> None:
    from tools import export_model

    processor = SimpleNamespace(
        do_convert_rgb=False,
        do_resize=True,
        size={"shortest_edge": 256},
        resample=3,
        do_center_crop=True,
        crop_size={"height": 224, "width": 224},
        do_rescale=True,
        rescale_factor=1.0 / 255.0,
        do_normalize=True,
        image_mean=[0.485, 0.456, 0.406],
        image_std=[0.229, 0.224, 0.225],
    )

    with pytest.raises(export_model.ExportError, match="RGB conversion"):
        export_model._preprocessing_contract(
            processor,
            export_model.MANDATED_MODEL_SOURCE,
        )


def test_exporter_canonicalizes_locked_output_dimensions() -> None:
    from tools import export_model

    class FakeDimension:
        def __init__(self, parameter: str) -> None:
            self.dim_param = parameter
            self.dim_value = 0

        def ClearField(self, field: str) -> None:
            assert field == "dim_param"
            self.dim_param = ""

    dimensions = [
        FakeDimension("batch"),
        FakeDimension("tokens"),
        FakeDimension("features"),
    ]
    model = SimpleNamespace(
        graph=SimpleNamespace(
            output=[
                SimpleNamespace(
                    name="last_hidden_state",
                    type=SimpleNamespace(
                        tensor_type=SimpleNamespace(
                            shape=SimpleNamespace(dim=dimensions),
                        )
                    ),
                )
            ]
        )
    )

    export_model._canonicalize_output_metadata(
        model,
        token_count=257,
        dimensions=384,
    )

    assert dimensions[0].dim_param == "batch"
    assert dimensions[1].dim_param == ""
    assert dimensions[1].dim_value == 257
    assert dimensions[2].dim_param == ""
    assert dimensions[2].dim_value == 384


@pytest.mark.skipif(
    os.environ.get("RUN_VISUAL_MODEL_TESTS") != "1",
    reason="set RUN_VISUAL_MODEL_TESTS=1 to exercise the pinned ONNX artifact",
)
def test_real_model_produces_ten_finite_normalized_embeddings() -> None:
    runtime = EmbeddingRuntime.from_lock(MODEL_LOCK_PATH)
    lock = json.loads(MODEL_LOCK_PATH.read_text(encoding="utf-8"))

    assert runtime.artifact_path.name == lock["artifact"]["filename"]
    assert runtime.model_sha256 == lock["artifact"]["sha256"]
    assert hashlib.sha256(runtime.artifact_path.read_bytes()).hexdigest() == (
        runtime.model_sha256
    )

    vectors = runtime.embed(checker_regions())

    assert vectors.shape == (10, 384)
    assert np.isfinite(vectors).all()
    np.testing.assert_allclose(
        np.linalg.norm(vectors, axis=1),
        np.ones(10),
        atol=1e-5,
    )
