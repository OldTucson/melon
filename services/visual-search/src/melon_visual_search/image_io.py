from __future__ import annotations

import io
import math
import warnings
from dataclasses import dataclass
from typing import Literal

import numpy as np
import numpy.typing as npt
import pillow_heif
from PIL import Image, ImageCms, ImageOps, ImageStat, UnidentifiedImageError

IMAGE_SEARCH_INVALID_FILE = "IMAGE_SEARCH_INVALID_FILE"
IMAGE_SEARCH_IMAGE_TOO_LARGE = "IMAGE_SEARCH_IMAGE_TOO_LARGE"

MAX_ENCODED_BYTES = 20 * 1024 * 1024
MAX_DECODED_PIXELS = 40_000_000
MIN_IMAGE_EDGE = 96
MAX_IMAGE_ASPECT_RATIO = 64

# These values are part of the visual index contract. Changing them requires a
# new index version because transparent artwork can produce different features.
ALPHA_LIGHT_BACKGROUND = (240, 240, 240)
ALPHA_DARK_BACKGROUND = (24, 24, 24)
ALPHA_INFORMATION_METRIC = "grayscale-variance"
ALPHA_TIE_BREAK = "light"

_SUPPORTED_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "HEIF", "HEIC"})
_TILE_INTERVALS = ((0.0, 0.4), (0.3, 0.7), (0.6, 1.0))

pillow_heif.register_heif_opener()


class ImageSearchError(ValueError):
    """A stable, non-sensitive failure returned by image-search primitives."""

    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        super().__init__(f"{code}: {detail}")


@dataclass(frozen=True)
class Region:
    """An image region with normalized ``(x, y, width, height)`` bounds."""

    index: int
    kind: Literal["global", "tile"]
    bounds: tuple[float, float, float, float]
    image: npt.NDArray[np.uint8]


@dataclass(frozen=True)
class DecodedImage:
    """One normalized decode shared by embedding and palette extraction."""

    embedding_rgb: npt.NDArray[np.uint8]
    palette_rgb: npt.NDArray[np.uint8]
    palette_alpha: npt.NDArray[np.uint8] | None


def _invalid_file(detail: str) -> ImageSearchError:
    return ImageSearchError(IMAGE_SEARCH_INVALID_FILE, detail)


def _too_large(detail: str) -> ImageSearchError:
    return ImageSearchError(IMAGE_SEARCH_IMAGE_TOO_LARGE, detail)


def _convert_to_srgb(image: Image.Image) -> Image.Image:
    has_alpha = "A" in image.getbands() or "transparency" in image.info
    alpha = image.convert("RGBA").getchannel("A") if has_alpha else None
    color_source = image.convert("RGB") if has_alpha else image
    icc_profile = image.info.get("icc_profile")

    if icc_profile is None:
        color = color_source.convert("RGB")
    else:
        try:
            source_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
            converted = ImageCms.profileToProfile(
                color_source,
                source_profile,
                ImageCms.createProfile("sRGB"),
                outputMode="RGB",
            )
            if converted is None:
                raise _invalid_file("embedded color profile conversion failed")
            color = converted
        except (OSError, TypeError, ValueError, ImageCms.PyCMSError) as error:
            raise _invalid_file("invalid embedded color profile") from error

    if alpha is None:
        return color
    color.putalpha(alpha)
    return color


def _composite(image: Image.Image, background: tuple[int, int, int]) -> Image.Image:
    canvas = Image.new("RGBA", image.size, (*background, 255))
    return Image.alpha_composite(canvas, image.convert("RGBA")).convert("RGB")


def _grayscale_variance(image: Image.Image) -> float:
    grayscale = image.convert("L")
    return float(ImageStat.Stat(grayscale).var[0])


def _flatten_alpha(image: Image.Image) -> Image.Image:
    if image.mode != "RGBA":
        return image.convert("RGB")

    light = _composite(image, ALPHA_LIGHT_BACKGROUND)
    dark = _composite(image, ALPHA_DARK_BACKGROUND)
    if _grayscale_variance(dark) > _grayscale_variance(light):
        return dark
    return light


def decode_image_inputs(
    encoded: bytes | bytearray | memoryview,
    *,
    max_encoded_bytes: int = MAX_ENCODED_BYTES,
    max_pixels: int = MAX_DECODED_PIXELS,
    min_edge: int = MIN_IMAGE_EDGE,
) -> DecodedImage:
    """Decode one image while retaining alpha for palette extraction."""

    if max_encoded_bytes <= 0 or max_pixels <= 0 or min_edge <= 0:
        raise ValueError("image decode bounds must be positive")
    if not isinstance(encoded, (bytes, bytearray, memoryview)):
        raise _invalid_file("encoded image must be bytes")
    if len(encoded) > max_encoded_bytes:
        raise _too_large("encoded image exceeds the byte limit")
    if not encoded:
        raise _invalid_file("encoded image is empty")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(encoded)) as opened:
                image_format = opened.format
                if image_format not in _SUPPORTED_FORMATS:
                    raise _invalid_file("unsupported image format")
                if int(getattr(opened, "n_frames", 1)) != 1:
                    raise _invalid_file("animated or multi-frame images are not supported")

                width, height = opened.size
                if width <= 0 or height <= 0:
                    raise _invalid_file("image dimensions must be positive")
                if width * height > max_pixels:
                    raise _too_large("decoded image exceeds the pixel limit")
                if max(width, height) > min(width, height) * MAX_IMAGE_ASPECT_RATIO:
                    raise _too_large("image aspect ratio exceeds the supported limit")
                if min(width, height) < min_edge:
                    raise _invalid_file("image shortest edge is below the minimum")

                opened.load()
                oriented = ImageOps.exif_transpose(opened)
                srgb = _convert_to_srgb(oriented)
                palette_rgb = np.ascontiguousarray(
                    np.asarray(srgb.convert("RGB"), dtype=np.uint8)
                )
                palette_alpha = (
                    np.ascontiguousarray(
                        np.asarray(srgb.getchannel("A"), dtype=np.uint8)
                    )
                    if srgb.mode == "RGBA"
                    else None
                )
                normalized = _flatten_alpha(srgb)
                embedding_rgb = np.ascontiguousarray(
                    np.asarray(normalized, dtype=np.uint8)
                )
    except ImageSearchError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise _too_large("decoded image exceeds the pixel limit") from error
    except (OSError, SyntaxError, UnidentifiedImageError, ValueError) as error:
        raise _invalid_file("image data could not be decoded") from error

    if embedding_rgb.ndim != 3 or embedding_rgb.shape[2] != 3:
        raise _invalid_file("decoded image did not produce RGB pixels")
    if palette_rgb.shape != embedding_rgb.shape:
        raise _invalid_file("decoded palette pixels did not match the image")
    if palette_alpha is not None and palette_alpha.shape != embedding_rgb.shape[:2]:
        raise _invalid_file("decoded alpha pixels did not match the image")
    return DecodedImage(
        embedding_rgb=embedding_rgb,
        palette_rgb=palette_rgb,
        palette_alpha=palette_alpha,
    )


def decode_image(
    encoded: bytes | bytearray | memoryview,
    *,
    max_encoded_bytes: int = MAX_ENCODED_BYTES,
    max_pixels: int = MAX_DECODED_PIXELS,
    min_edge: int = MIN_IMAGE_EDGE,
) -> npt.NDArray[np.uint8]:
    """Decode one supported image into deterministic contiguous sRGB bytes."""

    return decode_image_inputs(
        encoded,
        max_encoded_bytes=max_encoded_bytes,
        max_pixels=max_pixels,
        min_edge=min_edge,
    ).embedding_rgb


def _crop_edge(position: float, length: int, *, upper: bool) -> int:
    scaled = position * length
    edge = math.ceil(scaled) if upper else math.floor(scaled)
    return min(length, max(0, edge))


def make_regions(image: npt.NDArray[np.uint8]) -> tuple[Region, ...]:
    """Return the global image followed by a row-major overlapping 3x3 grid."""

    if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("image must be an HxWx3 uint8 RGB array")
    height, width = image.shape[:2]
    if height <= 0 or width <= 0:
        raise ValueError("image dimensions must be positive")

    regions = [
        Region(
            index=0,
            kind="global",
            bounds=(0.0, 0.0, 1.0, 1.0),
            image=np.ascontiguousarray(image.copy()),
        )
    ]
    index = 1
    for top_normalized, bottom_normalized in _TILE_INTERVALS:
        top = _crop_edge(top_normalized, height, upper=False)
        bottom = _crop_edge(bottom_normalized, height, upper=True)
        for left_normalized, right_normalized in _TILE_INTERVALS:
            left = _crop_edge(left_normalized, width, upper=False)
            right = _crop_edge(right_normalized, width, upper=True)
            if right <= left or bottom <= top:
                raise ValueError("image is too small to create non-empty regions")
            regions.append(
                Region(
                    index=index,
                    kind="tile",
                    bounds=(
                        left / width,
                        top / height,
                        (right - left) / width,
                        (bottom - top) / height,
                    ),
                    image=np.ascontiguousarray(image[top:bottom, left:right].copy()),
                )
            )
            index += 1
    return tuple(regions)
