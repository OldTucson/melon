"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import type { CSSProperties } from "react";

import { IconButton } from "@/features/library/icon-button";

function colorStyle(hex: string): CSSProperties {
  return { "--palette-color": hex } as CSSProperties;
}

export function PaletteQueryBar({
  busy,
  colors,
  error,
  limitMessage,
  onClear,
  onRemove,
  resultCount,
}: {
  busy: boolean;
  colors: readonly string[];
  error: string | null;
  limitMessage: string | null;
  onClear: () => void;
  onRemove: (hex: string) => void;
  resultCount: number;
}) {
  return (
    <div className="palette-query-bar">
      <div className="palette-query-heading">
        <h2>配色搜索</h2>
        <span role="status">
          {busy ? "正在更新结果" : `${resultCount} 个结果`}
        </span>
      </div>
      <div className="palette-query-colors" aria-label="已选颜色">
        {colors.map((hex) => (
          <Tooltip.Root key={hex}>
            <Tooltip.Trigger asChild>
              <button
                aria-label={`移除颜色 ${hex}`}
                className="palette-query-color"
                title={`移除颜色 ${hex}`}
                type="button"
                onClick={() => onRemove(hex)}
              >
                <span aria-hidden="true" style={colorStyle(hex)} />
                <X aria-hidden="true" />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip-content" sideOffset={6}>
                移除颜色 {hex}
                <Tooltip.Arrow className="tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        ))}
      </div>
      <IconButton
        className="palette-query-clear"
        label="清除配色"
        onClick={onClear}
      >
        <X aria-hidden="true" />
      </IconButton>
      {error ? (
        <p className="palette-query-error" role="alert">
          {error}
        </p>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {limitMessage}
      </span>
    </div>
  );
}
