"use client";

import type { CSSProperties, KeyboardEvent } from "react";

import type {
  PatternPaletteColor,
  PatternPaletteStatus,
} from "@/features/library/library-types";

export type PaletteSwatchesProps = {
  colors: readonly PatternPaletteColor[];
  status: PatternPaletteStatus;
  selectedColors?: ReadonlySet<string>;
  size: "compact" | "detail";
  interactive: boolean;
  onToggle?: (hex: string) => void;
};

const stableTrackCount = 5;

function paletteStyle(trackCount: number): CSSProperties {
  return {
    "--palette-track-count": trackCount,
  } as CSSProperties;
}

function colorStyle(hex: string): CSSProperties {
  return {
    "--palette-color": hex,
  } as CSSProperties;
}

function stopPaletteKey(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Enter" || event.key === " ") {
    event.stopPropagation();
  }
}

export function PaletteSwatches({
  colors,
  status,
  selectedColors,
  size,
  interactive,
  onToggle,
}: PaletteSwatchesProps) {
  const readyColors = colors.slice(0, stableTrackCount);
  const trackCount = status === "ready" ? readyColors.length : stableTrackCount;

  if (status === "pending") {
    return (
      <div
        aria-label="正在提取主色"
        className="palette-swatches"
        data-size={size}
        data-status={status}
        role="status"
        style={paletteStyle(trackCount)}
      >
        {Array.from({ length: stableTrackCount }, (_, index) => (
          <span
            aria-hidden="true"
            className="palette-swatch-placeholder"
            data-palette-placeholder="true"
            key={index}
          />
        ))}
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div
        className="palette-swatches"
        data-size={size}
        data-status={status}
        style={paletteStyle(trackCount)}
      >
        {Array.from({ length: stableTrackCount }, (_, index) => (
          <button
            aria-label="主色提取失败"
            className="palette-swatch palette-swatch-failed"
            disabled
            key={index}
            title="主色提取失败"
            type="button"
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="palette-swatches"
      data-size={size}
      data-status={status}
      style={paletteStyle(Math.max(1, trackCount))}
    >
      {readyColors.map((color) => {
        const percent = Math.round(color.coverage * 100);
        const content = (
          <>
            <span
              aria-hidden="true"
              className="palette-swatch-color"
              style={colorStyle(color.hex)}
            />
            {size === "detail" ? (
              <span aria-hidden="true" className="palette-swatch-copy">
                <span>{color.hex}</span>
                <span>{percent}%</span>
              </span>
            ) : null}
          </>
        );

        if (!interactive) {
          return (
            <div
              aria-label={`${color.hex}，覆盖率 ${percent}%`}
              className="palette-swatch"
              key={color.hex}
            >
              {content}
            </div>
          );
        }

        return (
          <button
            aria-label={`按颜色 ${color.hex} 搜索`}
            aria-pressed={selectedColors?.has(color.hex) ?? false}
            className="palette-swatch"
            key={color.hex}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle?.(color.hex);
            }}
            onKeyDown={stopPaletteKey}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
