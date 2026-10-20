from __future__ import annotations

import hashlib
import json
import math
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast

import numpy as np
import numpy.typing as npt
from PIL import Image

from .image_io import (
    ALPHA_DARK_BACKGROUND,
    ALPHA_INFORMATION_METRIC,
    ALPHA_LIGHT_BACKGROUND,
    ALPHA_TIE_BREAK,
    ImageSearchError,
    Region,
)

IMAGE_SEARCH_MODEL_INVALID = "IMAGE_SEARCH_MODEL_INVALID"
MODEL_LOCK_SCHEMA_VERSION = 2
MAX_MODEL_BYTES = 512 * 1024 * 1024

_SHA256_LENGTH = 64
_TOP_LEVEL_FIELDS = {
    "schemaVersion",
    "source",
    "artifact",
    "exporter",
    "runtime",
    "input",
    "output",
    "parity",
}
_PREPROCESSING_FIELDS = {
    "colorMode",
    "processorClass",
    "useFast",
    "resize",
    "centerCrop",
    "rescale",
    "normalize",
    "tensorLayout",
    "height",
    "width",
    "alphaComposite",
}


@dataclass(frozen=True)
class PreprocessingContract:
    color_mode: str
    resize_shortest_edge: int
    resize_resample: int
    crop_size: tuple[int, int]
    rescale_factor: float
    normalize_mean: tuple[float, float, float]
    normalize_standard_deviation: tuple[float, float, float]
    tensor_layout: str
    output_size: tuple[int, int]
    alpha_light_background: tuple[int, int, int]
    alpha_dark_background: tuple[int, int, int]
    alpha_information_metric: str
    alpha_tie_break: str


@dataclass(frozen=True)
class ModelContract:
    artifact_path: Path
    artifact_sha256: str
    artifact_size_bytes: int
    input_name: str
    output_name: str
    token_count: int
    dimensions: int
    cls_token_index: int
    preprocessing: PreprocessingContract


class _NodeMetadata(Protocol):
    name: str
    type: str
    shape: list[str | int | None]


class _InferenceSession(Protocol):
    def get_inputs(self) -> list[_NodeMetadata]: ...

    def get_outputs(self) -> list[_NodeMetadata]: ...

    def run(
        self,
        output_names: list[str],
        input_feed: dict[str, npt.NDArray[np.float32]],
    ) -> list[Any]: ...


SessionFactory = Callable[..., _InferenceSession]


def _model_error(detail: str) -> ImageSearchError:
    return ImageSearchError(IMAGE_SEARCH_MODEL_INVALID, detail)


def _mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not all(
        isinstance(key, str) for key in value
    ):
        raise _model_error(f"{label} must be an object")
    return cast(Mapping[str, object], value)


def _exact_fields(
    value: object,
    expected: set[str],
    label: str,
) -> Mapping[str, object]:
    mapping = _mapping(value, label)
    if set(mapping) != expected:
        raise _model_error(f"{label} fields do not match the supported schema")
    return mapping


def _positive_int(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise _model_error(f"{label} must be a positive integer")
    return value


def _finite_float(value: object, label: str, *, positive: bool = False) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise _model_error(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0.0):
        raise _model_error(f"{label} is outside the supported range")
    return result


def _float_triplet(value: object, label: str, *, positive: bool) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        raise _model_error(f"{label} must contain three numbers")
    values = tuple(
        _finite_float(item, f"{label}[{index}]", positive=positive)
        for index, item in enumerate(value)
    )
    return cast(tuple[float, float, float], values)


def _rgb_triplet(value: object, label: str) -> tuple[int, int, int]:
    if (
        not isinstance(value, list)
        or len(value) != 3
        or any(
            not isinstance(channel, int)
            or isinstance(channel, bool)
            or not 0 <= channel <= 255
            for channel in value
        )
    ):
        raise _model_error(f"{label} must be a three-channel RGB value")
    return cast(tuple[int, int, int], tuple(value))


def parse_preprocessing_contract(value: object) -> PreprocessingContract:
    data = _exact_fields(value, _PREPROCESSING_FIELDS, "input preprocessing")
    if data["colorMode"] != "RGB" or data["tensorLayout"] != "NCHW":
        raise _model_error("preprocessing color mode or tensor layout is unsupported")
    if not isinstance(data["processorClass"], str) or not data["processorClass"]:
        raise _model_error("preprocessing processorClass must be non-empty")
    if data["useFast"] is not False:
        raise _model_error("preprocessing must use the pinned slow processor")

    resize = _exact_fields(
        data["resize"],
        {"enabled", "size", "resample"},
        "resize preprocessing",
    )
    if resize["enabled"] is not True:
        raise _model_error("resize preprocessing must be enabled")
    resize_size = _exact_fields(
        resize["size"],
        {"shortest_edge"},
        "resize size",
    )
    shortest_edge = _positive_int(
        resize_size["shortest_edge"],
        "resize shortest edge",
    )
    resample = _positive_int(resize["resample"], "resize resample")
    try:
        Image.Resampling(resample)
    except ValueError as error:
        raise _model_error("resize resample is not supported by Pillow") from error

    center_crop = _exact_fields(
        data["centerCrop"],
        {"enabled", "size"},
        "center-crop preprocessing",
    )
    if center_crop["enabled"] is not True:
        raise _model_error("center-crop preprocessing must be enabled")
    crop_size = _exact_fields(
        center_crop["size"],
        {"height", "width"},
        "center-crop size",
    )
    crop_height = _positive_int(crop_size["height"], "center-crop height")
    crop_width = _positive_int(crop_size["width"], "center-crop width")
    if shortest_edge < max(crop_height, crop_width):
        raise _model_error("resize shortest edge must cover the center crop")

    rescale = _exact_fields(
        data["rescale"],
        {"enabled", "factor"},
        "rescale preprocessing",
    )
    if rescale["enabled"] is not True:
        raise _model_error("rescale preprocessing must be enabled")
    rescale_factor = _finite_float(
        rescale["factor"],
        "rescale factor",
        positive=True,
    )

    normalize = _exact_fields(
        data["normalize"],
        {"enabled", "mean", "standardDeviation"},
        "normalization preprocessing",
    )
    if normalize["enabled"] is not True:
        raise _model_error("normalization preprocessing must be enabled")
    mean = _float_triplet(normalize["mean"], "normalization mean", positive=False)
    standard_deviation = _float_triplet(
        normalize["standardDeviation"],
        "normalization standard deviation",
        positive=True,
    )

    height = _positive_int(data["height"], "preprocessing height")
    width = _positive_int(data["width"], "preprocessing width")
    if (height, width) != (crop_height, crop_width):
        raise _model_error("preprocessing dimensions must match the center crop")

    alpha = _exact_fields(
        data["alphaComposite"],
        {
            "lightBackground",
            "darkBackground",
            "informationMetric",
            "tieBreak",
        },
        "alpha compositing preprocessing",
    )
    light_background = _rgb_triplet(
        alpha["lightBackground"],
        "alpha light background",
    )
    dark_background = _rgb_triplet(
        alpha["darkBackground"],
        "alpha dark background",
    )
    if (
        light_background != ALPHA_LIGHT_BACKGROUND
        or dark_background != ALPHA_DARK_BACKGROUND
        or alpha["informationMetric"] != ALPHA_INFORMATION_METRIC
        or alpha["tieBreak"] != ALPHA_TIE_BREAK
    ):
        raise _model_error("alpha compositing contract does not match the decoder")

    return PreprocessingContract(
        color_mode="RGB",
        resize_shortest_edge=shortest_edge,
        resize_resample=resample,
        crop_size=(crop_height, crop_width),
        rescale_factor=rescale_factor,
        normalize_mean=mean,
        normalize_standard_deviation=standard_deviation,
        tensor_layout="NCHW",
        output_size=(height, width),
        alpha_light_background=light_background,
        alpha_dark_background=dark_background,
        alpha_information_metric=alpha["informationMetric"],
        alpha_tie_break=alpha["tieBreak"],
    )


def _resolve_artifact_path(
    lock_path: Path,
    artifact: Mapping[str, object],
    artifact_root: Path,
) -> tuple[Path, str, int]:
    relative_path = artifact.get("path")
    filename = artifact.get("filename")
    checksum = artifact.get("sha256")
    size_bytes = artifact.get("sizeBytes")
    if (
        not isinstance(relative_path, str)
        or not relative_path
        or Path(relative_path).is_absolute()
        or ".." in Path(relative_path).parts
    ):
        raise _model_error("artifact path must be a safe relative path")
    if not isinstance(filename, str) or filename != Path(relative_path).name:
        raise _model_error("artifact filename does not match its path")
    if (
        not isinstance(checksum, str)
        or len(checksum) != _SHA256_LENGTH
        or any(character not in "0123456789abcdef" for character in checksum)
    ):
        raise _model_error("artifact SHA-256 is not canonical")
    suffix = Path(filename).suffix
    basename_without_suffix = filename[: -len(suffix)] if suffix else filename
    if suffix != ".onnx" or not basename_without_suffix.endswith(f".{checksum}"):
        raise _model_error("artifact filename is not content-addressed")
    expected_size = _positive_int(size_bytes, "artifact size")
    if expected_size > MAX_MODEL_BYTES:
        raise _model_error("artifact exceeds the supported model size")

    resolved_root = artifact_root.resolve()
    resolved_artifact = (lock_path.resolve().parent / relative_path).resolve()
    if resolved_artifact == resolved_root or not resolved_artifact.is_relative_to(
        resolved_root
    ):
        raise _model_error("artifact resolves outside the model root")
    return resolved_artifact, checksum, expected_size


def load_model_contract(
    lock_path: Path,
    *,
    artifact_root: Path | None = None,
) -> ModelContract:
    try:
        raw: object = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise _model_error("model lock could not be read") from error

    data = _exact_fields(raw, _TOP_LEVEL_FIELDS, "model lock")
    if data["schemaVersion"] != MODEL_LOCK_SCHEMA_VERSION:
        raise _model_error("model lock schema version is unsupported")

    source = _exact_fields(
        data["source"],
        {"repoId", "revision", "license", "task", "inputSize", "dimensions"},
        "model source",
    )
    source_input_size = _positive_int(source["inputSize"], "source input size")
    source_dimensions = _positive_int(source["dimensions"], "source dimensions")

    artifact = _mapping(data["artifact"], "model artifact")
    root = artifact_root or (lock_path.parent / "models")
    artifact_path, checksum, artifact_size = _resolve_artifact_path(
        lock_path,
        artifact,
        root,
    )

    input_contract = _exact_fields(
        data["input"],
        {"name", "dtype", "shape", "dynamicAxes", "preprocessing"},
        "model input",
    )
    input_name = input_contract["name"]
    if not isinstance(input_name, str) or not input_name:
        raise _model_error("model input name must be non-empty")
    preprocessing = parse_preprocessing_contract(input_contract["preprocessing"])
    height, width = preprocessing.output_size
    if input_contract["dtype"] != "float32":
        raise _model_error("model input dtype must be float32")
    if input_contract["shape"] != ["batch", 3, height, width]:
        raise _model_error("model input shape does not match preprocessing")
    if input_contract["dynamicAxes"] != {"0": "batch"}:
        raise _model_error("model input batch axis must be dynamic")
    if source_input_size != height or height != width:
        raise _model_error("source input size does not match preprocessing")

    output_contract = _exact_fields(
        data["output"],
        {
            "name",
            "dtype",
            "shape",
            "dynamicAxes",
            "clsTokenIndex",
            "dimensions",
        },
        "model output",
    )
    output_name = output_contract["name"]
    if not isinstance(output_name, str) or not output_name:
        raise _model_error("model output name must be non-empty")
    if output_contract["dtype"] != "float32":
        raise _model_error("model output dtype must be float32")
    dimensions = _positive_int(output_contract["dimensions"], "output dimensions")
    shape = output_contract["shape"]
    if (
        not isinstance(shape, list)
        or len(shape) != 3
        or shape[0] != "batch"
        or not isinstance(shape[1], int)
        or isinstance(shape[1], bool)
        or shape[1] <= 0
        or shape[2] != dimensions
    ):
        raise _model_error("model output shape is invalid")
    token_count = shape[1]
    cls_token_index = output_contract["clsTokenIndex"]
    if (
        not isinstance(cls_token_index, int)
        or isinstance(cls_token_index, bool)
        or not 0 <= cls_token_index < token_count
    ):
        raise _model_error("CLS token index is outside the model output")
    if output_contract["dynamicAxes"] != {"0": "batch"}:
        raise _model_error("model output batch axis must be dynamic")
    if dimensions != source_dimensions:
        raise _model_error("output dimensions do not match the model source")

    return ModelContract(
        artifact_path=artifact_path,
        artifact_sha256=checksum,
        artifact_size_bytes=artifact_size,
        input_name=input_name,
        output_name=output_name,
        token_count=token_count,
        dimensions=dimensions,
        cls_token_index=cls_token_index,
        preprocessing=preprocessing,
    )


def _resize_dimensions(
    height: int,
    width: int,
    shortest_edge: int,
) -> tuple[int, int]:
    short, long = (width, height) if width <= height else (height, width)
    new_short = shortest_edge
    new_long = int(shortest_edge * long / short)
    if width <= height:
        return new_long, new_short
    return new_short, new_long


def _preprocess_image(
    image: npt.NDArray[np.uint8],
    contract: PreprocessingContract,
) -> npt.NDArray[np.float32]:
    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("preprocessing expects HxWx3 uint8 RGB images")
    height, width = image.shape[:2]
    if height <= 0 or width <= 0:
        raise ValueError("preprocessing images must not be empty")

    resized_height, resized_width = _resize_dimensions(
        height,
        width,
        contract.resize_shortest_edge,
    )
    resized = Image.fromarray(image, mode="RGB").resize(
        (resized_width, resized_height),
        resample=Image.Resampling(contract.resize_resample),
    )
    resized_array = np.asarray(resized, dtype=np.uint8)
    crop_height, crop_width = contract.crop_size
    top = (resized_height - crop_height) // 2
    left = (resized_width - crop_width) // 2
    cropped = resized_array[top : top + crop_height, left : left + crop_width]
    if cropped.shape != (crop_height, crop_width, 3):
        raise _model_error("preprocessing crop did not produce the locked dimensions")

    rescaled = (
        cropped.astype(np.float64) * contract.rescale_factor
    ).astype(np.float32)
    mean = np.asarray(contract.normalize_mean, dtype=np.float32)
    standard_deviation = np.asarray(
        contract.normalize_standard_deviation,
        dtype=np.float32,
    )
    normalized = (rescaled - mean) / standard_deviation
    return np.ascontiguousarray(normalized.transpose(2, 0, 1), dtype=np.float32)


def preprocess_images(
    images: Sequence[npt.NDArray[np.uint8]],
    preprocessing: PreprocessingContract,
) -> npt.NDArray[np.float32]:
    if not images:
        raise ValueError("at least one image is required for preprocessing")
    processed = [_preprocess_image(image, preprocessing) for image in images]
    return np.ascontiguousarray(np.stack(processed), dtype=np.float32)


def _default_session_factory(
    model: bytes,
    *,
    providers: list[str],
) -> _InferenceSession:
    import onnxruntime as ort  # type: ignore[import-untyped]

    return cast(
        _InferenceSession,
        ort.InferenceSession(model, providers=providers),
    )


def _read_verified_artifact(contract: ModelContract) -> bytes:
    try:
        with contract.artifact_path.open("rb") as model_file:
            model = model_file.read(contract.artifact_size_bytes + 1)
            if len(model) != contract.artifact_size_bytes or model_file.read(1):
                raise _model_error("model artifact size does not match the lock")
    except ImageSearchError:
        raise
    except OSError as error:
        raise _model_error("model artifact could not be read") from error
    digest = hashlib.sha256(model).hexdigest()
    if not secrets.compare_digest(digest, contract.artifact_sha256):
        raise _model_error("model artifact checksum does not match the lock")
    return model


def _dynamic_dimension(value: str | int | None) -> bool:
    return value is None or isinstance(value, str)


def _validate_session_contract(
    session: _InferenceSession,
    contract: ModelContract,
) -> None:
    inputs = session.get_inputs()
    outputs = session.get_outputs()
    if len(inputs) != 1 or len(outputs) != 1:
        raise _model_error("ONNX session must expose exactly one input and output")
    model_input = inputs[0]
    model_output = outputs[0]
    height, width = contract.preprocessing.output_size
    if (
        model_input.name != contract.input_name
        or model_input.type != "tensor(float)"
        or len(model_input.shape) != 4
        or not _dynamic_dimension(model_input.shape[0])
        or model_input.shape[1:] != [3, height, width]
    ):
        raise _model_error("ONNX input metadata does not match the model lock")
    if (
        model_output.name != contract.output_name
        or model_output.type != "tensor(float)"
        or len(model_output.shape) != 3
        or not _dynamic_dimension(model_output.shape[0])
        or (
            not _dynamic_dimension(model_output.shape[1])
            and model_output.shape[1] != contract.token_count
        )
        or model_output.shape[2] != contract.dimensions
    ):
        raise _model_error("ONNX output metadata does not match the model lock")


class EmbeddingRuntime:
    def __init__(
        self,
        contract: ModelContract,
        session: _InferenceSession,
    ) -> None:
        self.contract = contract
        self._session = session

    @property
    def artifact_path(self) -> Path:
        return self.contract.artifact_path

    @property
    def model_sha256(self) -> str:
        return self.contract.artifact_sha256

    @classmethod
    def from_lock(
        cls,
        lock_path: Path,
        *,
        artifact_root: Path | None = None,
        session_factory: SessionFactory | None = None,
    ) -> EmbeddingRuntime:
        contract = load_model_contract(lock_path, artifact_root=artifact_root)
        model = _read_verified_artifact(contract)
        factory = session_factory or _default_session_factory
        try:
            session = factory(model, providers=["CPUExecutionProvider"])
            _validate_session_contract(session, contract)
        except ImageSearchError:
            raise
        except Exception as error:
            raise _model_error("ONNX session could not be initialized") from error
        return cls(contract, session)

    def embed(self, regions: Sequence[Region]) -> npt.NDArray[np.float32]:
        expected_indices = list(range(10))
        if (
            len(regions) != 10
            or [region.index for region in regions] != expected_indices
            or regions[0].kind != "global"
            or any(region.kind != "tile" for region in regions[1:])
        ):
            raise ValueError("embedding requires ten ordered regions")

        model_input = preprocess_images(
            [region.image for region in regions],
            self.contract.preprocessing,
        )
        try:
            raw_outputs = self._session.run(
                [self.contract.output_name],
                {self.contract.input_name: model_input},
            )
        except Exception as error:
            raise _model_error("ONNX inference failed") from error
        if len(raw_outputs) != 1 or not isinstance(raw_outputs[0], np.ndarray):
            raise _model_error("ONNX inference returned an invalid output")
        output = raw_outputs[0]
        expected_shape = (
            10,
            self.contract.token_count,
            self.contract.dimensions,
        )
        if output.dtype != np.float32 or output.shape != expected_shape:
            raise _model_error("ONNX output shape or dtype does not match the lock")
        if not np.isfinite(output).all():
            raise _model_error("ONNX output contains non-finite values")

        vectors = output[:, self.contract.cls_token_index, :]
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if not np.isfinite(norms).all() or np.any(
            norms <= np.finfo(np.float32).tiny
        ):
            raise _model_error("ONNX output contains an invalid CLS vector")
        normalized = np.ascontiguousarray(vectors / norms, dtype=np.float32)
        if normalized.shape != (10, self.contract.dimensions) or not np.isfinite(
            normalized
        ).all():
            raise _model_error("normalized embeddings are invalid")
        return normalized
