from __future__ import annotations

import re

import numpy as np
import pytest

from melon_visual_search.palette import (
    MAX_PALETTE_SAMPLES,
    PaletteColor,
    _sample_palette_pixels,
    extract_palette,
    oklab_to_srgb,
    srgb_to_oklab,
)


def striped_image(
    colors: tuple[tuple[int, int, int], ...],
    *,
    height: int = 60,
    stripe_width: int = 40,
) -> np.ndarray:
    image = np.empty((height, stripe_width * len(colors), 3), dtype=np.uint8)
    for index, color in enumerate(colors):
        image[:, index * stripe_width : (index + 1) * stripe_width] = color
    return image


def nearest_color(
    palette: tuple[PaletteColor, ...],
    target: tuple[int, int, int],
) -> PaletteColor:
    target_array = np.asarray(target, dtype=np.float64)
    return min(
        palette,
        key=lambda color: float(
            np.linalg.norm(
                np.asarray(
                    tuple(int(color.display_hex[offset : offset + 2], 16) for offset in (1, 3, 5)),
                    dtype=np.float64,
                )
                - target_array
            )
        ),
    )


def test_extract_palette_is_deterministic_and_normalized() -> None:
    image = striped_image(
        (
            (35, 89, 71),
            (204, 156, 63),
            (143, 64, 56),
            (55, 95, 170),
            (228, 220, 190),
        )
    )

    first = extract_palette(image)
    second = extract_palette(image)

    assert first == second
    assert 3 <= len(first) <= 5
    assert len({color.display_hex for color in first}) == len(first)
    assert sum(color.coverage for color in first) == pytest.approx(1.0)
    assert [color.coverage for color in first] == sorted(
        (color.coverage for color in first), reverse=True
    )
    assert all(re.fullmatch(r"#[0-9A-F]{6}", color.display_hex) for color in first)
    assert all(np.isfinite(color.oklab).all() for color in first)


def test_extract_palette_ignores_fully_transparent_pixels() -> None:
    image = np.full((60, 120, 3), (255, 0, 0), dtype=np.uint8)
    alpha = np.zeros((60, 120), dtype=np.uint8)
    visible = ((0, 255, 0), (0, 0, 255), (255, 255, 0))
    for index, color in enumerate(visible):
        left = index * 30
        image[:, left : left + 30] = color
        alpha[:, left : left + 30] = 255

    palette = extract_palette(
        image,
        alpha,
        fallback_rgb=np.full_like(image, 127),
    )

    assert len(palette) == 3
    assert nearest_color(palette, (255, 0, 0)).display_hex != "#FF0000"
    for color in visible:
        assert nearest_color(palette, color).display_hex == (
            f"#{color[0]:02X}{color[1]:02X}{color[2]:02X}"
        )


def test_extract_palette_weights_partially_transparent_pixels() -> None:
    colors = ((255, 0, 0), (0, 255, 0), (0, 0, 255))
    image = striped_image(colors)
    alpha = np.full(image.shape[:2], 255, dtype=np.uint8)
    alpha[:, 80:120] = 128

    palette = extract_palette(image, alpha, fallback_rgb=image)

    red = nearest_color(palette, colors[0])
    green = nearest_color(palette, colors[1])
    blue = nearest_color(palette, colors[2])
    assert red.coverage == pytest.approx(0.4, abs=0.02)
    assert green.coverage == pytest.approx(0.4, abs=0.02)
    assert blue.coverage == pytest.approx(0.2, abs=0.02)


def test_extract_palette_uses_composited_fallback_when_too_few_pixels_are_visible() -> None:
    hidden = np.full((32, 32, 3), (255, 0, 0), dtype=np.uint8)
    alpha = np.zeros((32, 32), dtype=np.uint8)
    alpha[0, 0] = 255
    fallback = np.full((32, 32, 3), (40, 90, 70), dtype=np.uint8)

    palette = extract_palette(hidden, alpha, fallback_rgb=fallback)

    assert len(palette) == 3
    assert nearest_color(palette, (40, 90, 70)).display_hex == "#285A46"
    assert all(color.display_hex != "#FF0000" for color in palette)


def test_uniform_image_gets_three_distinct_lightness_steps() -> None:
    image = np.full((32, 32, 3), (40, 90, 70), dtype=np.uint8)

    palette = extract_palette(image)

    assert len(palette) == 3
    assert len({color.display_hex for color in palette}) == 3
    assert "#285A46" in {color.display_hex for color in palette}
    assert [color.coverage for color in palette] == pytest.approx([1 / 3] * 3)
    lightness = sorted(color.oklab[0] for color in palette)
    assert lightness[1] - lightness[0] == pytest.approx(0.03, abs=0.002)
    assert lightness[2] - lightness[1] == pytest.approx(0.03, abs=0.002)


def test_sampling_is_deterministic_and_bounded() -> None:
    image = np.arange(400 * 300 * 3, dtype=np.uint32).reshape(400, 300, 3)
    image = (image % 256).astype(np.uint8)
    alpha = np.full((400, 300), 255, dtype=np.uint8)

    first_colors, first_weights = _sample_palette_pixels(image, alpha)
    second_colors, second_weights = _sample_palette_pixels(image, alpha)

    assert first_colors.shape == (MAX_PALETTE_SAMPLES, 3)
    assert first_weights.shape == (MAX_PALETTE_SAMPLES,)
    np.testing.assert_array_equal(first_colors, second_colors)
    np.testing.assert_array_equal(first_weights, second_weights)


def test_oklab_conversion_round_trips_srgb_primaries() -> None:
    rgb = np.asarray(
        [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
        dtype=np.uint8,
    )

    restored = oklab_to_srgb(srgb_to_oklab(rgb))

    np.testing.assert_allclose(restored, rgb, atol=1)
