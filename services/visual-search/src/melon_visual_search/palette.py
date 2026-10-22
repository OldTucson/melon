from __future__ import annotations

import math
import re
from dataclasses import dataclass

import cv2
import numpy as np
import numpy.typing as npt

MAX_PALETTE_SAMPLES = 16_384
TARGET_COLOR_COUNT = 5
MIN_COLOR_COUNT = 3
MIN_VISIBLE_PIXELS = 16
ALPHA_CUTOFF = 16
MERGE_DISTANCE = 0.035
KMEANS_SEED = 20_261_022
_FALLBACK_LIGHTNESS_STEPS = (0.03, 0.06)
_HEX_PATTERN = re.compile(r"^#[0-9A-F]{6}$")


@dataclass(frozen=True)
class PaletteColor:
    display_hex: str
    oklab: tuple[float, float, float]
    coverage: float


@dataclass(frozen=True)
class _Cluster:
    oklab: npt.NDArray[np.float64]
    weight: float


def _validate_rgb(
    image: npt.NDArray[np.uint8],
    *,
    label: str,
) -> npt.NDArray[np.uint8]:
    if (
        not isinstance(image, np.ndarray)
        or image.dtype != np.uint8
        or image.ndim != 3
        or image.shape[2] != 3
        or image.shape[0] <= 0
        or image.shape[1] <= 0
    ):
        raise ValueError(f"{label} must be a non-empty HxWx3 uint8 RGB array")
    return image


def _validate_alpha(
    alpha: npt.NDArray[np.uint8] | None,
    shape: tuple[int, ...],
) -> npt.NDArray[np.uint8] | None:
    if alpha is None:
        return None
    if (
        not isinstance(alpha, np.ndarray)
        or alpha.dtype != np.uint8
        or alpha.ndim != 2
        or alpha.shape != shape
    ):
        raise ValueError("alpha must be a uint8 plane matching the RGB image")
    return alpha


def _bounded_sample_indexes(count: int) -> npt.NDArray[np.int64]:
    if count <= MAX_PALETTE_SAMPLES:
        return np.arange(count, dtype=np.int64)
    return np.linspace(
        0,
        count - 1,
        num=MAX_PALETTE_SAMPLES,
        dtype=np.int64,
    )


def _sample_palette_pixels(
    rgb: npt.NDArray[np.uint8],
    alpha: npt.NDArray[np.uint8] | None,
    *,
    fallback_rgb: npt.NDArray[np.uint8] | None = None,
) -> tuple[npt.NDArray[np.uint8], npt.NDArray[np.float64]]:
    source = _validate_rgb(rgb, label="rgb")
    alpha_plane = _validate_alpha(alpha, source.shape[:2])
    fallback = (
        source
        if fallback_rgb is None
        else _validate_rgb(fallback_rgb, label="fallback_rgb")
    )
    if fallback.shape != source.shape:
        raise ValueError("fallback_rgb must match the RGB image shape")

    colors: npt.NDArray[np.uint8]
    weights: npt.NDArray[np.float64]
    if alpha_plane is None:
        colors = source.reshape(-1, 3)
        weights = np.ones(colors.shape[0], dtype=np.float64)
    else:
        visible = alpha_plane >= ALPHA_CUTOFF
        if int(np.count_nonzero(visible)) < MIN_VISIBLE_PIXELS:
            colors = fallback.reshape(-1, 3)
            weights = np.ones(colors.shape[0], dtype=np.float64)
        else:
            colors = source[visible]
            weights = alpha_plane[visible].astype(np.float64) / 255.0

    indexes = _bounded_sample_indexes(colors.shape[0])
    return (
        np.ascontiguousarray(colors[indexes]),
        np.ascontiguousarray(weights[indexes]),
    )


def srgb_to_oklab(
    rgb: npt.NDArray[np.uint8],
) -> npt.NDArray[np.float64]:
    values = np.asarray(rgb)
    if values.dtype != np.uint8 or values.shape[-1:] != (3,):
        raise ValueError("rgb must be a uint8 array with a final dimension of three")
    srgb = values.astype(np.float64) / 255.0
    linear = np.where(
        srgb <= 0.04045,
        srgb / 12.92,
        ((srgb + 0.055) / 1.055) ** 2.4,
    )
    red, green, blue = np.moveaxis(linear, -1, 0)
    light = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue
    medium = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue
    short = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue
    light_root = np.cbrt(light)
    medium_root = np.cbrt(medium)
    short_root = np.cbrt(short)
    return np.stack(
        (
            0.2104542553 * light_root
            + 0.7936177850 * medium_root
            - 0.0040720468 * short_root,
            1.9779984951 * light_root
            - 2.4285922050 * medium_root
            + 0.4505937099 * short_root,
            0.0259040371 * light_root
            + 0.7827717662 * medium_root
            - 0.8086757660 * short_root,
        ),
        axis=-1,
    )


def oklab_to_srgb(
    oklab: npt.NDArray[np.float64],
) -> npt.NDArray[np.uint8]:
    values = np.asarray(oklab, dtype=np.float64)
    if values.shape[-1:] != (3,) or not np.isfinite(values).all():
        raise ValueError("oklab must be a finite array with a final dimension of three")
    lightness, axis_a, axis_b = np.moveaxis(values, -1, 0)
    light_root = lightness + 0.3963377774 * axis_a + 0.2158037573 * axis_b
    medium_root = lightness - 0.1055613458 * axis_a - 0.0638541728 * axis_b
    short_root = lightness - 0.0894841775 * axis_a - 1.2914855480 * axis_b
    light = light_root**3
    medium = medium_root**3
    short = short_root**3
    linear = np.stack(
        (
            4.0767416621 * light - 3.3077115913 * medium + 0.2309699292 * short,
            -1.2684380046 * light + 2.6097574011 * medium - 0.3413193965 * short,
            -0.0041960863 * light - 0.7034186147 * medium + 1.7076147010 * short,
        ),
        axis=-1,
    )
    positive = np.maximum(linear, 0.0)
    srgb = np.where(
        linear <= 0.0031308,
        12.92 * linear,
        1.055 * np.power(positive, 1.0 / 2.4) - 0.055,
    )
    return np.rint(np.clip(srgb, 0.0, 1.0) * 255.0).astype(np.uint8)


def _display_hex(oklab: npt.NDArray[np.float64]) -> str:
    red, green, blue = oklab_to_srgb(oklab).tolist()
    result = f"#{red:02X}{green:02X}{blue:02X}"
    if _HEX_PATTERN.fullmatch(result) is None:
        raise RuntimeError("PALETTE_HEX_INVALID")
    return result


def _initial_clusters(
    colors: npt.NDArray[np.uint8],
    weights: npt.NDArray[np.float64],
) -> list[_Cluster]:
    unique_count = int(np.unique(colors, axis=0).shape[0])
    cluster_count = min(TARGET_COLOR_COUNT, unique_count)
    samples = np.ascontiguousarray(srgb_to_oklab(colors).astype(np.float32))
    cv2.setRNGSeed(KMEANS_SEED)
    _, raw_labels, _ = cv2.kmeans(
        samples,
        cluster_count,
        np.empty((0, 1), dtype=np.int32),
        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 100, 1e-6),
        1,
        cv2.KMEANS_PP_CENTERS,
    )
    labels = np.asarray(raw_labels).reshape(-1)
    clusters: list[_Cluster] = []
    for index in range(cluster_count):
        selected = labels == index
        selected_weights = weights[selected]
        weight = float(selected_weights.sum())
        center = np.average(
            samples[selected].astype(np.float64),
            axis=0,
            weights=selected_weights,
        )
        clusters.append(_Cluster(np.asarray(center, dtype=np.float64), weight))
    return clusters


def _merge_nearby(clusters: list[_Cluster]) -> list[_Cluster]:
    merged = list(clusters)
    while len(merged) > MIN_COLOR_COUNT:
        closest: tuple[float, int, int] | None = None
        for left in range(len(merged) - 1):
            for right in range(left + 1, len(merged)):
                distance = float(
                    np.linalg.norm(merged[left].oklab - merged[right].oklab)
                )
                candidate = (distance, left, right)
                if closest is None or candidate < closest:
                    closest = candidate
        if closest is None or closest[0] >= MERGE_DISTANCE:
            break
        _, left, right = closest
        left_cluster = merged[left]
        right_cluster = merged[right]
        weight = left_cluster.weight + right_cluster.weight
        center = (
            left_cluster.oklab * left_cluster.weight
            + right_cluster.oklab * right_cluster.weight
        ) / weight
        merged[left] = _Cluster(center, weight)
        del merged[right]
    return merged


def _coalesce_display_duplicates(clusters: list[_Cluster]) -> list[_Cluster]:
    by_hex: dict[str, _Cluster] = {}
    for cluster in clusters:
        display_hex = _display_hex(cluster.oklab)
        existing = by_hex.get(display_hex)
        if existing is None:
            by_hex[display_hex] = cluster
            continue
        weight = existing.weight + cluster.weight
        center = (
            existing.oklab * existing.weight + cluster.oklab * cluster.weight
        ) / weight
        by_hex[display_hex] = _Cluster(center, weight)
    return list(by_hex.values())


def _fallback_lightness_values(lightness: float, step: float) -> tuple[float, ...]:
    symmetric = (
        max(0.0, lightness - step),
        lightness,
        min(1.0, lightness + step),
    )
    if len(set(symmetric)) == 3:
        return symmetric
    if lightness + step > 1.0:
        return (max(0.0, lightness - (2 * step)), max(0.0, lightness - step), lightness)
    return (lightness, min(1.0, lightness + step), min(1.0, lightness + (2 * step)))


def _expand_dominant_cluster(clusters: list[_Cluster]) -> list[_Cluster]:
    dominant_index = min(
        range(len(clusters)),
        key=lambda index: (-clusters[index].weight, _display_hex(clusters[index].oklab)),
    )
    dominant = clusters[dominant_index]
    for step in _FALLBACK_LIGHTNESS_STEPS:
        expanded: list[_Cluster] = []
        for lightness in _fallback_lightness_values(float(dominant.oklab[0]), step):
            adjusted = dominant.oklab.copy()
            adjusted[0] = lightness
            expanded.append(_Cluster(adjusted, dominant.weight / 3.0))
        if len({_display_hex(cluster.oklab) for cluster in expanded}) == 3:
            return clusters[:dominant_index] + expanded + clusters[dominant_index + 1 :]
    raise RuntimeError("PALETTE_FALLBACK_COLORS_NOT_DISTINCT")


def extract_palette(
    rgb: npt.NDArray[np.uint8],
    alpha: npt.NDArray[np.uint8] | None = None,
    *,
    fallback_rgb: npt.NDArray[np.uint8] | None = None,
) -> tuple[PaletteColor, ...]:
    colors, weights = _sample_palette_pixels(
        rgb,
        alpha,
        fallback_rgb=fallback_rgb,
    )
    if colors.shape[0] == 0 or not np.isfinite(weights).all() or weights.sum() <= 0:
        raise ValueError("palette samples must have positive finite weight")

    clusters = _coalesce_display_duplicates(_merge_nearby(_initial_clusters(colors, weights)))
    if len(clusters) < MIN_COLOR_COUNT:
        clusters = _coalesce_display_duplicates(_expand_dominant_cluster(clusters))
    if not MIN_COLOR_COUNT <= len(clusters) <= TARGET_COLOR_COUNT:
        raise RuntimeError("PALETTE_COLOR_COUNT_INVALID")

    total_weight = math.fsum(cluster.weight for cluster in clusters)
    palette = [
        PaletteColor(
            display_hex=_display_hex(cluster.oklab),
            oklab=(
                float(cluster.oklab[0]),
                float(cluster.oklab[1]),
                float(cluster.oklab[2]),
            ),
            coverage=cluster.weight / total_weight,
        )
        for cluster in clusters
    ]
    palette.sort(key=lambda color: (-color.coverage, color.display_hex))
    normalized_total = math.fsum(color.coverage for color in palette)
    return tuple(
        PaletteColor(color.display_hex, color.oklab, color.coverage / normalized_total)
        for color in palette
    )
