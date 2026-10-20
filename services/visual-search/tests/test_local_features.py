from __future__ import annotations

import io
import zipfile
from pathlib import Path

import numpy as np
import pytest

from melon_visual_search.image_io import ImageSearchError, decode_image
from melon_visual_search.local_features import (
    IMAGE_SEARCH_FEATURES_INVALID,
    LOCAL_FEATURE_ARCHIVE_VERSION,
    MAX_LOCAL_FEATURE_ARCHIVE_BYTES,
    LocalFeatures,
    compute_phash,
    extract_local_features,
    geometric_evidence,
    load_local_features,
    phash_distance,
    serialize_local_features,
)

FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def checker_image() -> np.ndarray:
    return decode_image((FIXTURE_DIRECTORY / "checker.png").read_bytes())


@pytest.fixture(scope="module")
def checker_crop() -> np.ndarray:
    return decode_image((FIXTURE_DIRECTORY / "checker-crop.jpg").read_bytes())


def test_phash_is_deterministic_canonical_64_bit_hex(
    checker_image: np.ndarray,
) -> None:
    first = compute_phash(checker_image)
    second = compute_phash(checker_image.copy())

    assert first == second
    assert len(first) == 16
    assert set(first) <= set("0123456789abcdef")
    assert phash_distance(first, first) == 0
    assert phash_distance("0000000000000000", "ffffffffffffffff") == 64


@pytest.mark.parametrize(
    "invalid",
    ["ABCDEF0123456789", "0" * 15, "g" * 16],
)
def test_phash_distance_rejects_noncanonical_hashes(invalid: str) -> None:
    with pytest.raises(ValueError, match="canonical"):
        phash_distance(invalid, "0" * 16)


def test_sift_features_are_finite_capped_and_stably_ordered(
    checker_image: np.ndarray,
) -> None:
    first = extract_local_features(checker_image, max_keypoints=256)
    second = extract_local_features(checker_image.copy(), max_keypoints=256)

    assert first.phash == compute_phash(checker_image)
    assert first.keypoints.dtype == np.float32
    assert first.descriptors.dtype == np.float32
    assert first.keypoints.ndim == 2 and first.keypoints.shape[1] == 2
    assert first.descriptors.ndim == 2 and first.descriptors.shape[1] == 128
    assert first.keypoints.shape[0] == first.descriptors.shape[0]
    assert 10 <= first.keypoints.shape[0] <= 256
    assert np.isfinite(first.keypoints).all()
    assert np.isfinite(first.descriptors).all()
    assert np.all((first.keypoints >= 0.0) & (first.keypoints <= 1.0))
    np.testing.assert_array_equal(first.keypoints, second.keypoints)
    np.testing.assert_array_equal(first.descriptors, second.descriptors)


def test_crop_passes_geometric_verification(
    checker_image: np.ndarray,
    checker_crop: np.ndarray,
) -> None:
    reference = extract_local_features(checker_image, max_keypoints=256)
    query = extract_local_features(checker_crop, max_keypoints=256)

    evidence = geometric_evidence(query, reference)

    assert evidence.inliers >= 10
    assert evidence.inlier_ratio >= 0.25
    assert 0.0 < evidence.coverage <= 1.0


def test_too_few_and_repetitive_features_return_zero_evidence() -> None:
    too_few = LocalFeatures(
        phash="0" * 16,
        keypoints=np.array([[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]], dtype=np.float32),
        descriptors=np.eye(3, 128, dtype=np.float32),
    )
    repetitive = LocalFeatures(
        phash="f" * 16,
        keypoints=np.array(
            [[index / 10.0, (index * 3 % 10) / 10.0] for index in range(8)],
            dtype=np.float32,
        ),
        descriptors=np.zeros((8, 128), dtype=np.float32),
    )

    assert geometric_evidence(too_few, repetitive).inliers == 0
    assert geometric_evidence(repetitive, repetitive).inliers == 0
    assert geometric_evidence(repetitive, repetitive).inlier_ratio == 0.0
    assert geometric_evidence(repetitive, repetitive).coverage == 0.0


def test_local_feature_archive_round_trip_uses_numeric_versioned_arrays(
    checker_image: np.ndarray,
) -> None:
    features = extract_local_features(checker_image, max_keypoints=64)

    encoded = serialize_local_features(features)
    restored = load_local_features(encoded)

    assert len(encoded) <= MAX_LOCAL_FEATURE_ARCHIVE_BYTES
    with np.load(io.BytesIO(encoded), allow_pickle=False) as archive:
        assert set(archive.files) == {
            "format_version",
            "phash",
            "keypoints",
            "descriptors",
        }
        assert archive["format_version"].dtype == np.uint16
        assert int(archive["format_version"][0]) == LOCAL_FEATURE_ARCHIVE_VERSION
        assert all(archive[name].dtype != object for name in archive.files)
    assert restored.phash == features.phash
    np.testing.assert_array_equal(restored.keypoints, features.keypoints)
    np.testing.assert_array_equal(restored.descriptors, features.descriptors)


def feature_archive(**replacements: np.ndarray) -> bytes:
    arrays = {
        "format_version": np.array([LOCAL_FEATURE_ARCHIVE_VERSION], dtype=np.uint16),
        "phash": np.array([0x0123456789ABCDEF], dtype=np.uint64),
        "keypoints": np.zeros((4, 2), dtype=np.float32),
        "descriptors": np.ones((4, 128), dtype=np.float32),
    }
    arrays.update(replacements)
    output = io.BytesIO()
    np.savez_compressed(output, **arrays)
    return output.getvalue()


@pytest.mark.parametrize(
    "encoded",
    [
        b"not-an-npz",
        feature_archive(format_version=np.array([999], dtype=np.uint16)),
        feature_archive(keypoints=np.zeros((4, 2), dtype=np.float64)),
        feature_archive(descriptors=np.ones((4, 64), dtype=np.float32)),
        feature_archive(keypoints=np.zeros((3, 2), dtype=np.float32)),
        feature_archive(keypoints=np.full((4, 2), np.nan, dtype=np.float32)),
        feature_archive(
            keypoints=np.zeros((257, 2), dtype=np.float32),
            descriptors=np.ones((257, 128), dtype=np.float32),
        ),
        feature_archive(phash=np.array(["unsafe"], dtype=object)),
    ],
    ids=[
        "malformed",
        "version",
        "keypoint-dtype",
        "descriptor-shape",
        "count-mismatch",
        "nonfinite",
        "too-many-features",
        "object-array",
    ],
)
def test_local_feature_archive_rejects_invalid_numeric_contract(encoded: bytes) -> None:
    with pytest.raises(ImageSearchError) as captured:
        load_local_features(encoded)

    assert captured.value.code == IMAGE_SEARCH_FEATURES_INVALID


def test_local_feature_archive_rejects_missing_and_unexpected_names() -> None:
    missing = io.BytesIO()
    np.savez_compressed(
        missing,
        format_version=np.array([LOCAL_FEATURE_ARCHIVE_VERSION], dtype=np.uint16),
        phash=np.array([0], dtype=np.uint64),
        keypoints=np.empty((0, 2), dtype=np.float32),
    )
    unexpected = io.BytesIO()
    np.savez_compressed(
        unexpected,
        format_version=np.array([LOCAL_FEATURE_ARCHIVE_VERSION], dtype=np.uint16),
        phash=np.array([0], dtype=np.uint64),
        keypoints=np.empty((0, 2), dtype=np.float32),
        descriptors=np.empty((0, 128), dtype=np.float32),
        metadata=np.array([1], dtype=np.uint8),
    )

    for encoded in (missing.getvalue(), unexpected.getvalue()):
        with pytest.raises(ImageSearchError) as captured:
            load_local_features(encoded)
        assert captured.value.code == IMAGE_SEARCH_FEATURES_INVALID


def test_local_feature_archive_rejects_encoded_input_over_the_limit() -> None:
    with pytest.raises(ImageSearchError) as captured:
        load_local_features(b"x" * (MAX_LOCAL_FEATURE_ARCHIVE_BYTES + 1))

    assert captured.value.code == IMAGE_SEARCH_FEATURES_INVALID


def test_local_feature_archive_rejects_huge_declared_shape_before_numpy_load(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from melon_visual_search import local_features as local_features_module

    def npy_bytes(array: np.ndarray) -> bytes:
        output = io.BytesIO()
        np.save(output, array, allow_pickle=False)
        return output.getvalue()

    huge_header = io.BytesIO()
    np.lib.format.write_array_header_1_0(
        huge_header,
        {
            "descr": np.dtype(np.float32).str,
            "fortran_order": False,
            "shape": (1_000_000_000, 128),
        },
    )
    encoded = io.BytesIO()
    with zipfile.ZipFile(encoded, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "format_version.npy",
            npy_bytes(np.array([LOCAL_FEATURE_ARCHIVE_VERSION], dtype=np.uint16)),
        )
        archive.writestr(
            "phash.npy",
            npy_bytes(np.array([0], dtype=np.uint64)),
        )
        archive.writestr(
            "keypoints.npy",
            npy_bytes(np.empty((0, 2), dtype=np.float32)),
        )
        archive.writestr("descriptors.npy", huge_header.getvalue())

    def forbidden_numpy_load(*args: object, **kwargs: object) -> object:
        raise AssertionError("unsafe array headers must be rejected before np.load")

    monkeypatch.setattr(local_features_module.np, "load", forbidden_numpy_load)

    with pytest.raises(ImageSearchError) as captured:
        load_local_features(encoded.getvalue())

    assert captured.value.code == IMAGE_SEARCH_FEATURES_INVALID


def test_local_feature_archive_rejects_boolean_shape_dimensions() -> None:
    def npy_bytes(array: np.ndarray) -> bytes:
        output = io.BytesIO()
        np.save(output, array, allow_pickle=False)
        return output.getvalue()

    def raw_float32_npy(shape: tuple[object, ...], payload_size: int) -> bytes:
        output = io.BytesIO()
        np.lib.format.write_array_header_1_0(
            output,
            {
                "descr": np.dtype(np.float32).str,
                "fortran_order": False,
                "shape": shape,
            },
        )
        output.write(b"\0" * payload_size)
        return output.getvalue()

    encoded = io.BytesIO()
    with zipfile.ZipFile(encoded, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "format_version.npy",
            npy_bytes(np.array([LOCAL_FEATURE_ARCHIVE_VERSION], dtype=np.uint16)),
        )
        archive.writestr("phash.npy", npy_bytes(np.array([0], dtype=np.uint64)))
        archive.writestr("keypoints.npy", raw_float32_npy((True, 2), 2 * 4))
        archive.writestr("descriptors.npy", raw_float32_npy((True, 128), 128 * 4))

    with pytest.raises(ImageSearchError) as captured:
        load_local_features(encoded.getvalue())

    assert captured.value.code == IMAGE_SEARCH_FEATURES_INVALID


def test_local_feature_archive_translates_header_parser_type_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from melon_visual_search import local_features as local_features_module

    def malformed_header(*args: object, **kwargs: object) -> object:
        raise TypeError("untrusted header details")

    monkeypatch.setattr(
        local_features_module.npy_format,
        "read_magic",
        malformed_header,
    )

    with pytest.raises(ImageSearchError) as captured:
        load_local_features(feature_archive())

    assert captured.value.code == IMAGE_SEARCH_FEATURES_INVALID
    assert "untrusted header details" not in str(captured.value)
