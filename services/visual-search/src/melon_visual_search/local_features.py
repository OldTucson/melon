from __future__ import annotations

import io
import math
import re
import statistics
import threading
import zipfile
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt
from numpy.lib import format as npy_format

from .image_io import ImageSearchError

IMAGE_SEARCH_FEATURES_INVALID = "IMAGE_SEARCH_FEATURES_INVALID"
LOCAL_FEATURE_ARCHIVE_VERSION = 1
MAX_KEYPOINTS = 256
SIFT_DESCRIPTOR_DIMENSIONS = 128
MAX_LOCAL_FEATURE_ARCHIVE_BYTES = 1024 * 1024
MAX_LOCAL_FEATURE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024

_PHASH_PATTERN = re.compile(r"^[0-9a-f]{16}$")
_ARCHIVE_ARRAYS = {
    "format_version",
    "phash",
    "keypoints",
    "descriptors",
}
_RANSAC_LOCK = threading.Lock()


@dataclass(frozen=True)
class LocalFeatures:
    phash: str
    keypoints: npt.NDArray[np.float32]
    descriptors: npt.NDArray[np.float32]


@dataclass(frozen=True)
class GeometricEvidence:
    inliers: int = 0
    inlier_ratio: float = 0.0
    coverage: float = 0.0


def _features_error(detail: str) -> ImageSearchError:
    return ImageSearchError(IMAGE_SEARCH_FEATURES_INVALID, detail)


def _validate_rgb_image(image: npt.NDArray[np.uint8]) -> None:
    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("local features require an HxWx3 uint8 RGB image")
    if image.shape[0] <= 0 or image.shape[1] <= 0:
        raise ValueError("local features require a non-empty image")


def compute_phash(image: npt.NDArray[np.uint8]) -> str:
    """Return a canonical 64-bit perceptual hash."""

    _validate_rgb_image(image)
    grayscale = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    resized = cv2.resize(grayscale, (32, 32), interpolation=cv2.INTER_AREA)
    coefficients = cv2.dct(resized.astype(np.float32))[:8, :8].reshape(-1)
    threshold = statistics.median(float(value) for value in coefficients[1:])
    value = 0
    for coefficient in coefficients:
        value = (value << 1) | int(float(coefficient) > threshold)
    return f"{value:016x}"


def phash_distance(first: str, second: str) -> int:
    if not _PHASH_PATTERN.fullmatch(first) or not _PHASH_PATTERN.fullmatch(second):
        raise ValueError("pHash values must be canonical 16-character lowercase hex")
    return (int(first, 16) ^ int(second, 16)).bit_count()


def _empty_feature_arrays() -> tuple[
    npt.NDArray[np.float32],
    npt.NDArray[np.float32],
]:
    return (
        np.empty((0, 2), dtype=np.float32),
        np.empty((0, SIFT_DESCRIPTOR_DIMENSIONS), dtype=np.float32),
    )


def extract_local_features(
    image: npt.NDArray[np.uint8],
    *,
    max_keypoints: int = MAX_KEYPOINTS,
) -> LocalFeatures:
    _validate_rgb_image(image)
    if (
        not isinstance(max_keypoints, int)
        or isinstance(max_keypoints, bool)
        or not 1 <= max_keypoints <= MAX_KEYPOINTS
    ):
        raise ValueError(f"max_keypoints must be between 1 and {MAX_KEYPOINTS}")

    grayscale = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    detector = cv2.SIFT.create(nfeatures=max_keypoints)
    detected, descriptor_values = detector.detectAndCompute(grayscale, None)
    if not detected or descriptor_values is None:
        keypoint_values, descriptors = _empty_feature_arrays()
        return LocalFeatures(compute_phash(image), keypoint_values, descriptors)

    descriptors = np.asarray(descriptor_values, dtype=np.float32)
    candidates: list[tuple[tuple[object, ...], int]] = []
    for index, (keypoint, descriptor) in enumerate(
        zip(detected, descriptors, strict=True)
    ):
        values = (
            float(keypoint.response),
            float(keypoint.pt[0]),
            float(keypoint.pt[1]),
            float(keypoint.size),
            float(keypoint.angle),
            float(keypoint.octave),
            float(keypoint.class_id),
        )
        if not all(math.isfinite(value) for value in values) or not np.isfinite(
            descriptor
        ).all():
            continue
        key = (
            -values[0],
            values[2],
            values[1],
            -values[3],
            values[4],
            values[5],
            values[6],
            descriptor.tobytes(),
            index,
        )
        candidates.append((key, index))
    candidates.sort(key=lambda candidate: candidate[0])
    selected_indices = [index for _, index in candidates[:max_keypoints]]
    if not selected_indices:
        keypoint_values, empty_descriptors = _empty_feature_arrays()
        return LocalFeatures(compute_phash(image), keypoint_values, empty_descriptors)

    height, width = image.shape[:2]
    width_scale = float(max(width - 1, 1))
    height_scale = float(max(height - 1, 1))
    keypoint_values = np.array(
        [
            (
                min(1.0, max(0.0, float(detected[index].pt[0]) / width_scale)),
                min(1.0, max(0.0, float(detected[index].pt[1]) / height_scale)),
            )
            for index in selected_indices
        ],
        dtype=np.float32,
    )
    selected_descriptors = np.ascontiguousarray(
        descriptors[selected_indices],
        dtype=np.float32,
    )
    return LocalFeatures(
        phash=compute_phash(image),
        keypoints=np.ascontiguousarray(keypoint_values),
        descriptors=selected_descriptors,
    )


def _valid_feature_arrays(features: LocalFeatures) -> bool:
    count = features.keypoints.shape[0] if features.keypoints.ndim == 2 else -1
    return bool(
        _PHASH_PATTERN.fullmatch(features.phash)
        and features.keypoints.dtype == np.float32
        and features.descriptors.dtype == np.float32
        and features.keypoints.shape == (count, 2)
        and features.descriptors.shape == (count, SIFT_DESCRIPTOR_DIMENSIONS)
        and 0 <= count <= MAX_KEYPOINTS
        and np.isfinite(features.keypoints).all()
        and np.isfinite(features.descriptors).all()
        and np.all((features.keypoints >= 0.0) & (features.keypoints <= 1.0))
    )


def _zero_evidence() -> GeometricEvidence:
    return GeometricEvidence()


def _coverage(points: npt.NDArray[np.float32]) -> float:
    if points.shape[0] < 3:
        return 0.0
    hull = cv2.convexHull(points.astype(np.float32).reshape(-1, 1, 2))
    return min(1.0, max(0.0, float(abs(cv2.contourArea(hull)))))


def geometric_evidence(
    query: LocalFeatures,
    reference: LocalFeatures,
    *,
    lowe_ratio: float = 0.75,
    ransac_reprojection_threshold: float = 0.015,
) -> GeometricEvidence:
    if (
        not math.isfinite(lowe_ratio)
        or not 0.0 < lowe_ratio < 1.0
        or not math.isfinite(ransac_reprojection_threshold)
        or ransac_reprojection_threshold <= 0.0
    ):
        raise ValueError("matching thresholds are outside the supported range")
    if not _valid_feature_arrays(query) or not _valid_feature_arrays(reference):
        return _zero_evidence()
    if len(query.descriptors) < 4 or len(reference.descriptors) < 4:
        return _zero_evidence()

    try:
        matcher = cv2.BFMatcher(cv2.NORM_L2, crossCheck=False)
        neighbors = matcher.knnMatch(query.descriptors, reference.descriptors, k=2)
    except cv2.error:
        return _zero_evidence()

    candidates = []
    for pair in neighbors:
        if len(pair) != 2:
            continue
        closest, second = pair
        if (
            math.isfinite(float(closest.distance))
            and math.isfinite(float(second.distance))
            and float(second.distance) > 0.0
            and float(closest.distance) < lowe_ratio * float(second.distance)
        ):
            candidates.append(closest)
    candidates.sort(
        key=lambda match: (
            float(match.distance),
            int(match.queryIdx),
            int(match.trainIdx),
        )
    )

    matches = []
    used_query: set[int] = set()
    used_reference: set[int] = set()
    for match in candidates:
        query_index = int(match.queryIdx)
        reference_index = int(match.trainIdx)
        if query_index in used_query or reference_index in used_reference:
            continue
        used_query.add(query_index)
        used_reference.add(reference_index)
        matches.append(match)
    if len(matches) < 4:
        return _zero_evidence()

    query_points = np.array(
        [query.keypoints[int(match.queryIdx)] for match in matches],
        dtype=np.float32,
    )
    reference_points = np.array(
        [reference.keypoints[int(match.trainIdx)] for match in matches],
        dtype=np.float32,
    )
    if (
        np.unique(query_points, axis=0).shape[0] < 4
        or np.unique(reference_points, axis=0).shape[0] < 4
    ):
        return _zero_evidence()

    try:
        with _RANSAC_LOCK:
            cv2.setRNGSeed(0)
            homography, mask = cv2.findHomography(
                query_points,
                reference_points,
                method=cv2.RANSAC,
                ransacReprojThreshold=ransac_reprojection_threshold,
                maxIters=2000,
                confidence=0.995,
            )
    except cv2.error:
        return _zero_evidence()
    if homography is None or mask is None:
        return _zero_evidence()
    homography_values: npt.NDArray[np.float64] = np.asarray(
        homography,
        dtype=np.float64,
    )
    if not np.isfinite(homography_values).all():
        return _zero_evidence()
    if np.linalg.matrix_rank(homography_values) < 3:
        return _zero_evidence()
    condition = float(np.linalg.cond(homography_values))
    if not math.isfinite(condition) or condition > 1e10:
        return _zero_evidence()

    inlier_mask = np.asarray(mask).reshape(-1).astype(bool)
    if inlier_mask.shape != (len(matches),):
        return _zero_evidence()
    inliers = int(np.count_nonzero(inlier_mask))
    if inliers < 4:
        return _zero_evidence()
    query_inliers = query_points[inlier_mask]
    reference_inliers = reference_points[inlier_mask]
    coverage = min(_coverage(query_inliers), _coverage(reference_inliers))
    if coverage <= 0.0:
        return _zero_evidence()
    return GeometricEvidence(
        inliers=inliers,
        inlier_ratio=min(1.0, max(0.0, inliers / len(matches))),
        coverage=coverage,
    )


def _validated_features(features: LocalFeatures) -> LocalFeatures:
    if not _valid_feature_arrays(features):
        raise _features_error("local feature arrays do not match the schema")
    return features


def serialize_local_features(features: LocalFeatures) -> bytes:
    validated = _validated_features(features)
    output = io.BytesIO()
    np.savez_compressed(
        output,
        format_version=np.array(
            [LOCAL_FEATURE_ARCHIVE_VERSION],
            dtype=np.uint16,
        ),
        phash=np.array([int(validated.phash, 16)], dtype=np.uint64),
        keypoints=np.ascontiguousarray(validated.keypoints, dtype=np.float32),
        descriptors=np.ascontiguousarray(validated.descriptors, dtype=np.float32),
    )
    encoded = output.getvalue()
    if len(encoded) > MAX_LOCAL_FEATURE_ARCHIVE_BYTES:
        raise _features_error("local feature archive exceeds the byte limit")
    return encoded


def _read_array_metadata(
    archive: zipfile.ZipFile,
    entry: zipfile.ZipInfo,
) -> tuple[tuple[int, ...], np.dtype[Any]]:
    with archive.open(entry, "r") as array_file:
        version = npy_format.read_magic(array_file)  # type: ignore[no-untyped-call]
        if version == (1, 0):
            shape, fortran_order, dtype = npy_format.read_array_header_1_0(  # type: ignore[no-untyped-call]
                array_file
            )
        elif version == (2, 0):
            shape, fortran_order, dtype = npy_format.read_array_header_2_0(  # type: ignore[no-untyped-call]
                array_file
            )
        else:
            raise _features_error("local feature array version is unsupported")
        if fortran_order or dtype.hasobject:
            raise _features_error("local feature array storage is unsupported")
        if any(
            not isinstance(dimension, int) or dimension < 0 for dimension in shape
        ):
            raise _features_error("local feature array shape is invalid")
        payload_size = math.prod(shape) * dtype.itemsize
        if (
            payload_size > MAX_LOCAL_FEATURE_UNCOMPRESSED_BYTES
            or entry.file_size - array_file.tell() != payload_size
        ):
            raise _features_error("local feature array payload size is invalid")
    return shape, dtype


def _validate_zip_container(encoded: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(encoded)) as archive:
            entries = archive.infolist()
            expected_names = {f"{name}.npy" for name in _ARCHIVE_ARRAYS}
            names = [entry.filename for entry in entries]
            if len(entries) != len(expected_names) or set(names) != expected_names:
                raise _features_error("local feature archive members are invalid")
            if (
                any(
                    entry.is_dir()
                    or entry.file_size < 0
                    or entry.flag_bits & 0x1
                    or entry.compress_type
                    not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                    for entry in entries
                )
                or sum(entry.file_size for entry in entries)
                > MAX_LOCAL_FEATURE_UNCOMPRESSED_BYTES
            ):
                raise _features_error("local feature archive expands beyond its limit")
            metadata = {
                entry.filename.removesuffix(".npy"): _read_array_metadata(
                    archive,
                    entry,
                )
                for entry in entries
            }
            format_shape, format_dtype = metadata["format_version"]
            phash_shape, phash_dtype = metadata["phash"]
            keypoint_shape, keypoint_dtype = metadata["keypoints"]
            descriptor_shape, descriptor_dtype = metadata["descriptors"]
            if format_shape != (1,) or format_dtype != np.dtype(np.uint16):
                raise _features_error("local feature archive version metadata is invalid")
            if phash_shape != (1,) or phash_dtype != np.dtype(np.uint64):
                raise _features_error("local feature archive pHash metadata is invalid")
            if (
                len(keypoint_shape) != 2
                or keypoint_shape[1] != 2
                or keypoint_shape[0] > MAX_KEYPOINTS
                or keypoint_dtype != np.dtype(np.float32)
                or descriptor_shape
                != (keypoint_shape[0], SIFT_DESCRIPTOR_DIMENSIONS)
                or descriptor_dtype != np.dtype(np.float32)
            ):
                raise _features_error("local feature array metadata is invalid")
    except ImageSearchError:
        raise
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        raise _features_error("local feature archive is malformed") from error


def load_local_features(encoded: bytes | bytearray | memoryview) -> LocalFeatures:
    if not isinstance(encoded, (bytes, bytearray, memoryview)):
        raise _features_error("local feature archive must be bytes")
    if not encoded or len(encoded) > MAX_LOCAL_FEATURE_ARCHIVE_BYTES:
        raise _features_error("local feature archive exceeds the byte limit")
    archive_bytes = bytes(encoded)
    _validate_zip_container(archive_bytes)

    try:
        with np.load(io.BytesIO(archive_bytes), allow_pickle=False) as archive:
            if set(archive.files) != _ARCHIVE_ARRAYS:
                raise _features_error("local feature archive arrays are invalid")
            version = archive["format_version"]
            phash_value = archive["phash"]
            keypoints = archive["keypoints"]
            descriptors = archive["descriptors"]
            if (
                version.dtype != np.uint16
                or version.shape != (1,)
                or int(version[0]) != LOCAL_FEATURE_ARCHIVE_VERSION
            ):
                raise _features_error("local feature archive version is unsupported")
            if phash_value.dtype != np.uint64 or phash_value.shape != (1,):
                raise _features_error("local feature pHash representation is invalid")
            features = LocalFeatures(
                phash=f"{int(phash_value[0]):016x}",
                keypoints=np.ascontiguousarray(keypoints),
                descriptors=np.ascontiguousarray(descriptors),
            )
    except ImageSearchError:
        raise
    except (EOFError, KeyError, OSError, ValueError, zipfile.BadZipFile) as error:
        raise _features_error("local feature archive arrays could not be loaded") from error
    return _validated_features(features)


def deserialize_local_features(
    encoded: bytes | bytearray | memoryview,
) -> LocalFeatures:
    return load_local_features(encoded)
