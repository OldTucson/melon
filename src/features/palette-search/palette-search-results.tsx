"use client";

import { useMemo } from "react";

import type { PatternItem } from "@/features/library/library-types";
import type { LibraryViewMode } from "@/features/library/library-toolbar";
import { PatternGrid } from "@/features/library/pattern-grid";
import type { SelectionModifiers } from "@/features/library/selection-store";

import type { PaletteSearchResponse } from "./contracts";
import { PaletteQueryBar } from "./palette-query-bar";

export function PaletteSearchResults({
  busy,
  colors,
  error,
  limitMessage,
  mode,
  onClear,
  onFavorite,
  onInspect,
  onOpenPreview,
  onPaletteToggle,
  onRemoveColor,
  onSelect,
  response,
  selectedIds,
}: {
  busy: boolean;
  colors: readonly string[];
  error: string | null;
  limitMessage: string | null;
  mode: LibraryViewMode;
  onClear: () => void;
  onFavorite: (item: PatternItem) => void;
  onInspect: (id: string) => void;
  onOpenPreview: (id: string) => void;
  onPaletteToggle: (hex: string) => void;
  onRemoveColor: (hex: string) => void;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  response: PaletteSearchResponse | null;
  selectedIds: ReadonlySet<string>;
}) {
  const selectedColors = useMemo(() => new Set(colors), [colors]);
  const items = response?.items ?? [];

  return (
    <section
      aria-label="配色搜索结果"
      className="palette-search-results"
      role="region"
    >
      <PaletteQueryBar
        busy={busy}
        colors={colors}
        error={error}
        limitMessage={limitMessage}
        onClear={onClear}
        onRemove={onRemoveColor}
        resultCount={items.length}
      />
      {response === null ? (
        <div className="library-state" aria-live="polite">
          <span className="loading-line" />
          <p>正在查找接近的配色...</p>
        </div>
      ) : items.length === 0 ? (
        <div className="library-state">
          <strong>没有找到接近这组配色的图案</strong>
        </div>
      ) : (
        <PatternGrid
          hasNextPage={false}
          isFetchingNextPage={false}
          items={items}
          mode={mode}
          onFavorite={onFavorite}
          onInspect={onInspect}
          onLoadMore={() => undefined}
          onOpenPreview={onOpenPreview}
          onPaletteToggle={onPaletteToggle}
          onSelect={onSelect}
          paletteEnabled
          selectedIds={selectedIds}
          selectedPaletteColors={selectedColors}
        />
      )}
    </section>
  );
}
