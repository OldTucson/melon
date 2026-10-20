#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import tempfile
import warnings
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

INPUT_NAME = "pixel_values"
OUTPUT_NAME = "last_hidden_state"
OPSET_VERSION = 17
PARITY_ABSOLUTE_TOLERANCE = 1e-4
PARITY_RELATIVE_TOLERANCE = 0.0
_SOURCE_FIELDS = {"repoId", "revision", "license", "task", "inputSize", "dimensions"}
_PINNED_REVISION_PATTERN = re.compile(r"^[0-9a-f]{40}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_EXPORT_LOCK_ROOT = Path(tempfile.gettempdir()) / "melon-visual-search-export-locks"
FailureStage = Literal["source-validation", "model-export", "manifest-validation"]
_FAILURE_CODES: dict[FailureStage, str] = {
    "source-validation": "MODEL_SOURCE_INVALID",
    "model-export": "MODEL_EXPORT_FAILED",
    "manifest-validation": "MODEL_LOCK_INVALID",
}


class ExportError(RuntimeError):
    """Raised when the source contract, export, or parity validation fails."""


@dataclass(frozen=True)
class ModelSource:
    repo_id: str
    revision: str
    license: str
    task: str
    input_size: int
    dimensions: int

    def as_lock_data(self) -> dict[str, str | int]:
        return {
            "repoId": self.repo_id,
            "revision": self.revision,
            "license": self.license,
            "task": self.task,
            "inputSize": self.input_size,
            "dimensions": self.dimensions,
        }


MANDATED_MODEL_SOURCE = ModelSource(
    repo_id="facebook/dinov2-small",
    revision="ed25f3a31f01632728cabb09d1542f84ab7b0056",
    license="Apache-2.0",
    task="feature-extraction",
    input_size=224,
    dimensions=384,
)


def load_model_source(path: Path) -> ModelSource:
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExportError(f"unable to read model source contract: {type(exc).__name__}") from exc

    if not isinstance(raw, dict) or set(raw) != _SOURCE_FIELDS:
        raise ExportError("model source contract must contain exactly the supported fields")

    repo_id = raw["repoId"]
    revision = raw["revision"]
    license_name = raw["license"]
    task = raw["task"]
    input_size = raw["inputSize"]
    dimensions = raw["dimensions"]
    if not isinstance(repo_id, str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo_id):
        raise ExportError("model source repoId must identify an explicit repository")
    if not isinstance(revision, str) or not _PINNED_REVISION_PATTERN.fullmatch(revision):
        raise ExportError("model source revision must be a full 40-character commit SHA")
    if not isinstance(license_name, str) or not license_name:
        raise ExportError("model source license must be non-empty")
    if task != "feature-extraction":
        raise ExportError("model source task must be feature-extraction")
    if not isinstance(input_size, int) or isinstance(input_size, bool) or input_size <= 0:
        raise ExportError("model source inputSize must be a positive integer")
    if not isinstance(dimensions, int) or isinstance(dimensions, bool) or dimensions <= 0:
        raise ExportError("model source dimensions must be a positive integer")

    source = ModelSource(
        repo_id=repo_id,
        revision=revision,
        license=license_name,
        task=task,
        input_size=input_size,
        dimensions=dimensions,
    )
    if source != MANDATED_MODEL_SOURCE:
        raise ExportError("model source contract does not match the mandated identity")
    return source


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as artifact:
        for chunk in iter(lambda: artifact.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def content_addressed_artifact_path(requested_output: Path, checksum: str) -> Path:
    if not _SHA256_PATTERN.fullmatch(checksum):
        raise ExportError("artifact checksum must be 64 lowercase hexadecimal characters")
    return requested_output.with_name(
        f"{requested_output.stem}.{checksum}{requested_output.suffix}"
    )


def resolve_locked_artifact(
    lock_path: Path,
    lock_data: Mapping[str, object],
    *,
    artifact_root: Path,
) -> Path:
    artifact = lock_data.get("artifact")
    if not isinstance(artifact, Mapping):
        raise ExportError("model lock is missing the artifact contract")
    relative_path = artifact.get("path")
    if (
        not isinstance(relative_path, str)
        or not relative_path
        or Path(relative_path).is_absolute()
    ):
        raise ExportError("model lock artifact path must be relative to the lock")
    relative_artifact = Path(relative_path)
    if ".." in relative_artifact.parts:
        raise ExportError("model lock artifact path must not contain parent traversal")

    checksum = artifact.get("sha256")
    if not isinstance(checksum, str) or not _SHA256_PATTERN.fullmatch(checksum):
        raise ExportError("model lock is missing a canonical artifact checksum")
    suffix = relative_artifact.suffix
    basename_without_suffix = (
        relative_artifact.name[: -len(suffix)] if suffix else relative_artifact.name
    )
    if not basename_without_suffix.endswith(f".{checksum}"):
        raise ExportError("model lock artifact basename does not embed the declared checksum")

    resolved_root = artifact_root.resolve()
    resolved_artifact = (lock_path.resolve().parent / relative_artifact).resolve()
    if resolved_artifact == resolved_root or not resolved_artifact.is_relative_to(
        resolved_root
    ):
        raise ExportError("model lock artifact resolves outside the artifact root")
    return resolved_artifact


def _validate_distinct_paths(*roles: tuple[str, Path]) -> None:
    resolved: dict[Path, str] = {}
    for role, path in roles:
        canonical = path.resolve()
        previous_role = resolved.get(canonical)
        if previous_role is not None:
            raise ExportError(
                f"{previous_role}, {role}, and all export destination paths must be distinct"
            )
        resolved[canonical] = role


def _path_identity(path: Path) -> str:
    return hashlib.sha256(os.fsencode(path.resolve())).hexdigest()


def _staging_prefix(role: str, destination: Path) -> str:
    return f".melon-visual-search-{role}-{_path_identity(destination)}-"


def _release_locks(descriptors: list[int]) -> None:
    for descriptor in reversed(descriptors):
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)
    descriptors.clear()


@dataclass
class ExportStaging:
    artifact_directory: Path
    manifest_directory: Path
    _lock_descriptors: list[int]
    _closed: bool = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        cleanup_error: OSError | None = None
        try:
            for directory in (self.artifact_directory, self.manifest_directory):
                try:
                    shutil.rmtree(directory)
                except FileNotFoundError:
                    pass
                except OSError as error:
                    if cleanup_error is None:
                        cleanup_error = error
        finally:
            _release_locks(self._lock_descriptors)
        if cleanup_error is not None:
            raise cleanup_error


def _acquire_destination_locks(destinations: Sequence[Path]) -> list[int]:
    _EXPORT_LOCK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptors: list[int] = []
    identities = sorted({_path_identity(destination) for destination in destinations})
    try:
        for identity in identities:
            descriptor = os.open(
                _EXPORT_LOCK_ROOT / f"{identity}.lock",
                os.O_CREAT | os.O_RDWR,
                0o600,
            )
            descriptors.append(descriptor)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
    except BaseException:
        _release_locks(descriptors)
        raise
    return descriptors


def _remove_abandoned_staging_directories(parent: Path, prefix: str) -> None:
    for candidate in parent.iterdir():
        if (
            candidate.name.startswith(prefix)
            and candidate.is_dir()
            and not candidate.is_symlink()
        ):
            shutil.rmtree(candidate)


def _open_export_staging(output_path: Path, lock_path: Path) -> ExportStaging:
    output_path = output_path.resolve()
    lock_path = lock_path.resolve()
    _validate_distinct_paths(("requested model output", output_path), ("model lock", lock_path))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_descriptors = _acquire_destination_locks((output_path, lock_path))
    artifact_directory: Path | None = None
    manifest_directory: Path | None = None
    try:
        artifact_prefix = _staging_prefix("artifact", output_path)
        manifest_prefix = _staging_prefix("manifest", lock_path)
        _remove_abandoned_staging_directories(output_path.parent, artifact_prefix)
        _remove_abandoned_staging_directories(lock_path.parent, manifest_prefix)
        artifact_directory = Path(
            tempfile.mkdtemp(prefix=artifact_prefix, dir=output_path.parent)
        )
        manifest_directory = Path(
            tempfile.mkdtemp(prefix=manifest_prefix, dir=lock_path.parent)
        )
        return ExportStaging(
            artifact_directory=artifact_directory,
            manifest_directory=manifest_directory,
            _lock_descriptors=lock_descriptors,
        )
    except BaseException:
        for directory in (artifact_directory, manifest_directory):
            if directory is not None:
                shutil.rmtree(directory, ignore_errors=True)
        _release_locks(lock_descriptors)
        raise


def _package_version(distribution: str) -> str:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError as exc:
        raise ExportError(f"required model package is not installed: {distribution}") from exc


def _fixed_rgb_images(input_size: int) -> list[Any]:
    import numpy as np
    from PIL import Image

    height = input_size + 31
    width = input_size + 47
    y, x = np.indices((height, width), dtype=np.uint16)
    first = np.stack(
        (
            (3 * x + 5 * y) % 256,
            (7 * x + 11 * y + 17) % 256,
            (13 * x + 2 * y + 29) % 256,
        ),
        axis=-1,
    ).astype(np.uint8)
    second = np.stack(
        (
            (19 * x + y + 37) % 256,
            (x * y + 41) % 256,
            (5 * x + 23 * y + 53) % 256,
        ),
        axis=-1,
    ).astype(np.uint8)
    return [Image.fromarray(first, mode="RGB"), Image.fromarray(second, mode="RGB")]


def _normalize_size(value: object) -> dict[str, int] | int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, Mapping):
        normalized: dict[str, int] = {}
        for key, item in value.items():
            if isinstance(key, str) and isinstance(item, int) and not isinstance(item, bool):
                normalized[key] = item
        return normalized
    return None


def _preprocessing_contract(processor: Any, source: ModelSource) -> dict[str, object]:
    resample = getattr(processor, "resample", None)
    return {
        "colorMode": "RGB",
        "processorClass": type(processor).__name__,
        "useFast": False,
        "resize": {
            "enabled": bool(getattr(processor, "do_resize", False)),
            "size": _normalize_size(getattr(processor, "size", None)),
            "resample": int(resample) if resample is not None else None,
        },
        "centerCrop": {
            "enabled": bool(getattr(processor, "do_center_crop", False)),
            "size": _normalize_size(getattr(processor, "crop_size", None)),
        },
        "rescale": {
            "enabled": bool(getattr(processor, "do_rescale", False)),
            "factor": float(getattr(processor, "rescale_factor", 1.0)),
        },
        "normalize": {
            "enabled": bool(getattr(processor, "do_normalize", False)),
            "mean": [float(value) for value in processor.image_mean],
            "standardDeviation": [float(value) for value in processor.image_std],
        },
        "tensorLayout": "NCHW",
        "height": source.input_size,
        "width": source.input_size,
    }


def _validate_tensor_shape(
    output: Any,
    *,
    batch_size: int,
    token_count: int,
    dimensions: int,
    label: str,
) -> None:
    import numpy as np

    expected_shape = (batch_size, token_count, dimensions)
    if output.shape != expected_shape:
        raise ExportError(f"{label} output has shape {output.shape}, expected {expected_shape}")
    if output.dtype != np.float32:
        raise ExportError(f"{label} output must use float32, received {output.dtype}")
    if not np.isfinite(output).all():
        raise ExportError(f"{label} output contains non-finite values")


def _validate_output_parity(candidate: Any, reference: Any) -> float:
    import numpy as np

    maximum_error = float(np.max(np.abs(candidate - reference)))
    if not np.isfinite(maximum_error) or maximum_error > PARITY_ABSOLUTE_TOLERANCE:
        raise ExportError(
            "ONNX parity failed at maximum absolute error tolerance "
            f"{PARITY_ABSOLUTE_TOLERANCE:.8g}; maximum absolute error "
            f"{maximum_error:.8g}"
        )
    return maximum_error


def _run_onnx_validation_batch(
    session: Any,
    model_input: Any,
    *,
    batch_size: int,
    token_count: int,
    dimensions: int,
    label: str,
) -> Any:
    try:
        output = session.run(
            [OUTPUT_NAME],
            {INPUT_NAME: model_input},
        )[0]
    except Exception as exc:
        raise ExportError(f"{label} failed ({type(exc).__name__})") from None
    _validate_tensor_shape(
        output,
        batch_size=batch_size,
        token_count=token_count,
        dimensions=dimensions,
        label=label,
    )
    return output


def _write_json_temp(
    destination: Path,
    data: Mapping[str, object],
    staging_directory: Path | None = None,
) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_directory = staging_directory or destination.parent
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=temporary_directory,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary_file:
            json.dump(data, temporary_file, indent=2, sort_keys=True)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise
    return temporary_path


def _fsync_file(path: Path) -> None:
    with path.open("rb") as artifact:
        os.fsync(artifact.fileno())


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _publish_model_generation(
    temporary_artifact: Path,
    immutable_artifact: Path,
    lock_path: Path,
    lock_data: Mapping[str, object],
    lock_staging_directory: Path | None = None,
) -> Path:
    temporary_artifact = temporary_artifact.resolve()
    artifact_root = immutable_artifact.parent.resolve()
    immutable_artifact = immutable_artifact.resolve()
    lock_path = lock_path.resolve()
    temporary_lock: Path | None = None
    created_artifact = False
    manifest_committed = False
    try:
        _validate_distinct_paths(
            ("immutable model artifact", immutable_artifact),
            ("model lock", lock_path),
        )
        artifact = lock_data.get("artifact")
        if not isinstance(artifact, Mapping):
            raise ExportError("model lock is missing the artifact contract")
        expected_checksum = artifact.get("sha256")
        if not isinstance(expected_checksum, str) or not _SHA256_PATTERN.fullmatch(
            expected_checksum
        ):
            raise ExportError("model lock is missing a canonical artifact checksum")
        if resolve_locked_artifact(
            lock_path,
            lock_data,
            artifact_root=artifact_root,
        ) != immutable_artifact:
            raise ExportError("model lock does not name the immutable artifact")
        if sha256_file(temporary_artifact) != expected_checksum:
            raise ExportError("staged artifact checksum does not match the model lock")

        immutable_artifact.parent.mkdir(parents=True, exist_ok=True)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(temporary_artifact, immutable_artifact)
            created_artifact = True
        except FileExistsError:
            if sha256_file(immutable_artifact) != expected_checksum:
                raise ExportError(
                    "immutable artifact path already exists with different content"
                ) from None

        _fsync_file(immutable_artifact)
        _fsync_directory(immutable_artifact.parent)
        temporary_artifact.unlink(missing_ok=True)

        temporary_lock = _write_json_temp(
            lock_path,
            lock_data,
            staging_directory=lock_staging_directory,
        )
        os.replace(temporary_lock, lock_path)
        temporary_lock = None
        manifest_committed = True
        _fsync_directory(lock_path.parent)
        return immutable_artifact
    except BaseException:
        if created_artifact and not manifest_committed:
            immutable_artifact.unlink(missing_ok=True)
            try:
                _fsync_directory(immutable_artifact.parent)
            except OSError:
                pass
        raise
    finally:
        temporary_artifact.unlink(missing_ok=True)
        if temporary_lock is not None:
            temporary_lock.unlink(missing_ok=True)


def export_model(source: ModelSource, output_path: Path, lock_path: Path) -> dict[str, object]:
    import numpy as np
    import onnx
    import onnxruntime as ort  # type: ignore[import-untyped]
    import torch
    from transformers import AutoImageProcessor, AutoModel

    output_path = output_path.resolve()
    lock_path = lock_path.resolve()
    _validate_distinct_paths(("requested model output", output_path), ("model lock", lock_path))

    torch.manual_seed(0)
    np.random.seed(0)
    torch.set_num_threads(1)

    processor = AutoImageProcessor.from_pretrained(
        source.repo_id,
        revision=source.revision,
        trust_remote_code=False,
        use_fast=False,
    )
    model = AutoModel.from_pretrained(
        source.repo_id,
        revision=source.revision,
        trust_remote_code=False,
        dtype=torch.float32,
        attn_implementation="eager",
    )
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)

    class LastHiddenState(torch.nn.Module):
        def __init__(self, wrapped_model: Any) -> None:
            super().__init__()
            self.wrapped_model = wrapped_model

        def forward(self, pixel_values: Any) -> Any:
            return self.wrapped_model(
                pixel_values=pixel_values,
                return_dict=False,
            )[0]

    wrapper = LastHiddenState(model).eval()
    processed = processor(images=_fixed_rgb_images(source.input_size), return_tensors="pt")
    pixel_values = processed[INPUT_NAME].to(dtype=torch.float32, device="cpu").contiguous()
    expected_input_shape = (2, 3, source.input_size, source.input_size)
    if tuple(pixel_values.shape) != expected_input_shape:
        raise ExportError(
            f"preprocessor produced shape {tuple(pixel_values.shape)}, expected {expected_input_shape}"
        )

    patch_size = getattr(model.config, "patch_size", None)
    if not isinstance(patch_size, int) or patch_size <= 0 or source.input_size % patch_size:
        raise ExportError("model patch size is incompatible with the pinned input size")
    token_count = 1 + (source.input_size // patch_size) ** 2

    with torch.inference_mode():
        torch_output = wrapper(pixel_values).detach().cpu().numpy()
    _validate_tensor_shape(
        torch_output,
        batch_size=2,
        token_count=token_count,
        dimensions=source.dimensions,
        label="PyTorch",
    )

    staging = _open_export_staging(output_path, lock_path)
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix="model-",
            suffix=".onnx.tmp",
            dir=staging.artifact_directory,
        )
        os.close(descriptor)
    except BaseException:
        staging.close()
        raise
    temporary_artifact = Path(temporary_name)
    try:
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="You are using the legacy TorchScript-based ONNX export.*",
                category=DeprecationWarning,
            )
            warnings.filterwarnings(
                "ignore",
                message="Converting a tensor to a Python boolean might cause the trace.*",
                category=torch.jit.TracerWarning,
            )
            torch.onnx.export(
                wrapper,
                (pixel_values,),
                str(temporary_artifact),
                export_params=True,
                opset_version=OPSET_VERSION,
                do_constant_folding=True,
                input_names=[INPUT_NAME],
                output_names=[OUTPUT_NAME],
                dynamic_axes={
                    INPUT_NAME: {0: "batch"},
                    OUTPUT_NAME: {0: "batch"},
                },
                dynamo=False,
                external_data=False,
            )
        with temporary_artifact.open("rb") as artifact:
            os.fsync(artifact.fileno())

        onnx_model = onnx.load(str(temporary_artifact), load_external_data=True)
        onnx.checker.check_model(onnx_model)
        session = ort.InferenceSession(
            str(temporary_artifact),
            providers=["CPUExecutionProvider"],
        )
        inputs = session.get_inputs()
        outputs = session.get_outputs()
        if len(inputs) != 1 or inputs[0].name != INPUT_NAME:
            raise ExportError("ONNX model does not expose the required pixel_values input")
        if len(outputs) != 1 or outputs[0].name != OUTPUT_NAME:
            raise ExportError("ONNX model does not expose the required last_hidden_state output")
        if not isinstance(inputs[0].shape[0], str) or not isinstance(outputs[0].shape[0], str):
            raise ExportError("ONNX model batch axis is not dynamic")

        numpy_input = pixel_values.detach().cpu().numpy()
        onnx_output = _run_onnx_validation_batch(
            session,
            numpy_input,
            batch_size=2,
            token_count=token_count,
            dimensions=source.dimensions,
            label="ONNX Runtime parity batch",
        )
        parity_error = _validate_output_parity(onnx_output, torch_output)
        dynamic_batch_size = 1
        dynamic_output = _run_onnx_validation_batch(
            session,
            numpy_input[:dynamic_batch_size],
            batch_size=dynamic_batch_size,
            token_count=token_count,
            dimensions=source.dimensions,
            label="ONNX Runtime dynamic batch validation",
        )
        dynamic_parity_error = _validate_output_parity(
            dynamic_output,
            torch_output[:dynamic_batch_size],
        )
        maximum_error = max(parity_error, dynamic_parity_error)

        artifact_checksum = sha256_file(temporary_artifact)
        artifact_size = temporary_artifact.stat().st_size
        immutable_artifact = content_addressed_artifact_path(
            output_path,
            artifact_checksum,
        )
        _validate_distinct_paths(
            ("requested model output", output_path),
            ("immutable model artifact", immutable_artifact),
            ("model lock", lock_path),
        )
        lock_data: dict[str, object] = {
            "schemaVersion": 2,
            "source": source.as_lock_data(),
            "artifact": {
                "filename": immutable_artifact.name,
                "path": Path(
                    os.path.relpath(immutable_artifact, lock_path.parent)
                ).as_posix(),
                "precision": "FP32",
                "requestedFilename": output_path.name,
                "requestedPath": Path(
                    os.path.relpath(output_path, lock_path.parent)
                ).as_posix(),
                "sha256": artifact_checksum,
                "sizeBytes": artifact_size,
            },
            "exporter": {
                "name": "torch.onnx.export",
                "mode": "legacyTorchScript",
                "opset": OPSET_VERSION,
                "pythonVersion": platform.python_version(),
                "torchVersion": _package_version("torch"),
                "transformersVersion": _package_version("transformers"),
                "onnxVersion": _package_version("onnx"),
                "optimumOnnxVersion": _package_version("optimum-onnx"),
            },
            "runtime": {
                "name": "onnxruntime",
                "version": _package_version("onnxruntime"),
                "providers": ["CPUExecutionProvider"],
            },
            "input": {
                "name": INPUT_NAME,
                "dtype": "float32",
                "shape": ["batch", 3, source.input_size, source.input_size],
                "dynamicAxes": {"0": "batch"},
                "preprocessing": _preprocessing_contract(processor, source),
            },
            "output": {
                "name": OUTPUT_NAME,
                "dtype": "float32",
                "shape": ["batch", token_count, source.dimensions],
                "dynamicAxes": {"0": "batch"},
                "clsTokenIndex": 0,
                "dimensions": source.dimensions,
            },
            "parity": {
                "validatedBatchSizes": [dynamic_batch_size, 2],
                "absoluteTolerance": PARITY_ABSOLUTE_TOLERANCE,
                "relativeTolerance": PARITY_RELATIVE_TOLERANCE,
                "maximumAbsoluteError": maximum_error,
            },
        }
        _publish_model_generation(
            temporary_artifact,
            immutable_artifact,
            lock_path,
            lock_data,
            lock_staging_directory=staging.manifest_directory,
        )
        return lock_data
    finally:
        temporary_artifact.unlink(missing_ok=True)
        staging.close()


def _cli_failure_message(stage: FailureStage, error: BaseException) -> str:
    exception_name = type(error).__name__
    if not exception_name.isidentifier():
        exception_name = "Exception"
    return (
        f"error: stage={stage} code={_FAILURE_CODES[stage]} "
        f"exception={exception_name}\n"
    )


def build_parser() -> argparse.ArgumentParser:
    service_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Export the pinned DINOv2 model to ONNX")
    parser.add_argument(
        "--source",
        type=Path,
        default=service_root / "model-source.json",
        help="path to the pinned model source contract",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help=(
            "requested ONNX basename/location; publication inserts .<sha256> "
            "before the suffix"
        ),
    )
    parser.add_argument("--lock", type=Path, required=True, help="destination model lock path")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        source = load_model_source(arguments.source)
    except Exception as exc:
        parser.exit(1, _cli_failure_message("source-validation", exc))

    try:
        lock_data = export_model(source, arguments.output, arguments.lock)
    except Exception as exc:
        parser.exit(1, _cli_failure_message("model-export", exc))

    try:
        artifact = lock_data["artifact"]
        if not isinstance(artifact, dict) or not isinstance(artifact.get("sha256"), str):
            raise ExportError("generated lock is missing the artifact checksum")
        artifact_checksum = artifact["sha256"]
        published_artifact = resolve_locked_artifact(
            arguments.lock,
            lock_data,
            artifact_root=arguments.output.resolve().parent,
        )
    except Exception as exc:
        parser.exit(1, _cli_failure_message("manifest-validation", exc))

    print(f"exported {published_artifact} sha256={artifact_checksum}")
    print(f"wrote {arguments.lock}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
