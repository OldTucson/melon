from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pillow_heif
import pytest
from PIL import Image

from melon_visual_search.image_io import (
    ALPHA_DARK_BACKGROUND,
    ALPHA_LIGHT_BACKGROUND,
    IMAGE_SEARCH_IMAGE_TOO_LARGE,
    IMAGE_SEARCH_INVALID_FILE,
    MAX_ENCODED_BYTES,
    ImageSearchError,
    decode_image,
    make_regions,
)


def encoded_image(
    mode: str = "RGB",
    size: tuple[int, int] = (128, 96),
    *,
    image_format: str = "PNG",
    color: tuple[int, ...] | int = (20, 80, 140),
    **save_options: object,
) -> bytes:
    image = Image.new(mode, size, color)
    output = io.BytesIO()
    image.save(output, format=image_format, **save_options)
    return output.getvalue()


@pytest.mark.parametrize(
    ("image_format", "mode"),
    [("PNG", "RGB"), ("JPEG", "RGB"), ("WEBP", "RGB")],
)
def test_decode_accepts_supported_content_from_the_actual_file_signature(
    image_format: str,
    mode: str,
) -> None:
    decoded = decode_image(encoded_image(mode, image_format=image_format))

    assert decoded.shape == (96, 128, 3)
    assert decoded.dtype == np.uint8
    assert decoded.flags.c_contiguous


def test_heif_decoder_is_registered_and_decodes_heic_content() -> None:
    source = Image.new("RGB", (128, 96), (24, 120, 220))
    output = io.BytesIO()
    pillow_heif.from_pillow(source).save(output)

    assert Image.registered_extensions()[".heic"] == "HEIF"
    assert Image.registered_extensions()[".heif"] == "HEIF"
    decoded = decode_image(output.getvalue())
    assert decoded.shape == (96, 128, 3)
    assert decoded.dtype == np.uint8


def test_decode_rejects_encoded_data_one_byte_over_the_limit_before_opening(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    opened = False

    def forbidden_open(*args: object, **kwargs: object) -> Image.Image:
        nonlocal opened
        opened = True
        raise AssertionError("oversized encoded data must not reach the decoder")

    monkeypatch.setattr(Image, "open", forbidden_open)

    with pytest.raises(ImageSearchError) as captured:
        decode_image(b"x" * (MAX_ENCODED_BYTES + 1))

    assert captured.value.code == IMAGE_SEARCH_IMAGE_TOO_LARGE
    assert opened is False


def test_decode_accepts_encoded_data_at_the_exact_byte_limit() -> None:
    png = encoded_image()
    padded = png + (b"\0" * (MAX_ENCODED_BYTES - len(png)))

    decoded = decode_image(padded)

    assert decoded.shape == (96, 128, 3)


def test_decode_enforces_pixel_limit_without_an_off_by_one() -> None:
    png = encoded_image(size=(96, 96))

    assert decode_image(png, max_pixels=96 * 96).shape == (96, 96, 3)
    with pytest.raises(ImageSearchError) as captured:
        decode_image(png, max_pixels=(96 * 96) - 1)

    assert captured.value.code == IMAGE_SEARCH_IMAGE_TOO_LARGE


def test_decode_accepts_shortest_edge_96_and_rejects_95() -> None:
    assert decode_image(encoded_image(size=(128, 96))).shape == (96, 128, 3)

    with pytest.raises(ImageSearchError) as captured:
        decode_image(encoded_image(size=(128, 95)))

    assert captured.value.code == IMAGE_SEARCH_INVALID_FILE


def test_decode_applies_exif_orientation_before_returning_rgb() -> None:
    image = Image.new("RGB", (96, 120), (230, 30, 20))
    exif = Image.Exif()
    exif[274] = 6
    output = io.BytesIO()
    image.save(output, format="JPEG", exif=exif)

    decoded = decode_image(output.getvalue())

    assert decoded.shape == (96, 120, 3)
    assert decoded.dtype == np.uint8


def test_decode_selects_the_more_informative_alpha_background_deterministically() -> None:
    image = Image.new("RGBA", (96, 96), (255, 255, 255, 0))
    image.paste((255, 255, 255, 255), (24, 24, 72, 72))
    output = io.BytesIO()
    image.save(output, format="PNG")

    first = decode_image(output.getvalue())
    second = decode_image(output.getvalue())

    np.testing.assert_array_equal(first, second)
    np.testing.assert_array_equal(
        first[0, 0], np.array(ALPHA_DARK_BACKGROUND, dtype=np.uint8)
    )
    np.testing.assert_array_equal(
        first[48, 48], np.array([255, 255, 255], dtype=np.uint8)
    )


def test_decode_alpha_information_ties_choose_the_light_background() -> None:
    image = Image.new("RGBA", (96, 96), (120, 80, 40, 0))
    output = io.BytesIO()
    image.save(output, format="PNG")

    decoded = decode_image(output.getvalue())

    expected = np.full((96, 96, 3), ALPHA_LIGHT_BACKGROUND, dtype=np.uint8)
    np.testing.assert_array_equal(decoded, expected)


def test_decode_rejects_multiple_frames() -> None:
    frames = [
        Image.new("RGB", (96, 96), (255, 0, 0)),
        Image.new("RGB", (96, 96), (0, 0, 255)),
    ]
    output = io.BytesIO()
    frames[0].save(output, format="WEBP", save_all=True, append_images=frames[1:])

    with pytest.raises(ImageSearchError) as captured:
        decode_image(output.getvalue())

    assert captured.value.code == IMAGE_SEARCH_INVALID_FILE


@pytest.mark.parametrize(
    "encoded",
    [b"not-an-image", encoded_image(image_format="BMP")],
    ids=["malformed", "unsupported"],
)
def test_decode_rejects_malformed_and_unsupported_data(encoded: bytes) -> None:
    with pytest.raises(ImageSearchError) as captured:
        decode_image(encoded)

    assert captured.value.code == IMAGE_SEARCH_INVALID_FILE


def test_decode_does_not_change_pillows_process_global_pixel_limit() -> None:
    original_limit = Image.MAX_IMAGE_PIXELS

    with pytest.raises(ImageSearchError):
        decode_image(encoded_image(size=(96, 96)), max_pixels=1)

    assert Image.MAX_IMAGE_PIXELS == original_limit


def test_regions_are_global_plus_nine_overlapping_tiles() -> None:
    image = np.arange(97 * 101 * 3, dtype=np.uint32).reshape(97, 101, 3)
    image = (image % 256).astype(np.uint8)
    original = image.copy()

    regions = make_regions(image)

    assert [region.index for region in regions] == list(range(10))
    assert regions[0].kind == "global"
    assert all(region.kind == "tile" for region in regions[1:])
    assert regions[0].bounds == (0.0, 0.0, 1.0, 1.0)
    assert regions[1].bounds == pytest.approx((0.0, 0.0, 0.4, 0.4))
    assert regions[-1].bounds == pytest.approx((0.6, 0.6, 1.0, 1.0))
    assert all(region.image.size > 0 for region in regions)
    assert all(region.image.shape[0] > 0 for region in regions)
    assert all(region.image.shape[1] > 0 for region in regions)
    np.testing.assert_array_equal(image, original)


def test_fixture_images_are_committed_and_decodable() -> None:
    fixture_directory = Path(__file__).parent / "fixtures"

    checker = decode_image((fixture_directory / "checker.png").read_bytes())
    checker_crop = decode_image((fixture_directory / "checker-crop.jpg").read_bytes())

    assert checker.shape == (512, 512, 3)
    assert min(checker_crop.shape[:2]) >= 96
