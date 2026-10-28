"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { PatternItem } from "./library-types";
import type { LibraryViewMode } from "./library-toolbar";
import { PatternCard } from "./pattern-card";
import type { SelectionModifiers } from "./selection-store";

const getRowKey = (index: number) => index;

export function resolvePatternGridColumns(
  width: number,
  mode: LibraryViewMode,
) {
  if (mode === "list") return 1;
  if (width < 520) return 1;
  if (width < 860) return 3;
  return Math.max(4, Math.min(6, Math.floor((width + 16) / 238)));
}

export type PatternGridHandle = {
  getScrollOffset(): number;
  restoreScrollOffset(offset: number): void;
};

type PatternGridProps = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  items: PatternItem[];
  mode: LibraryViewMode;
  onFavorite: (item: PatternItem) => void;
  onInspect: (id: string) => void;
  onLoadMore: () => void;
  onOpenPreview: (id: string) => void;
  onPaletteToggle?: (hex: string) => void;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  paletteEnabled?: boolean;
  selectedIds: ReadonlySet<string>;
  selectedPaletteColors?: ReadonlySet<string>;
};

export const PatternGrid = forwardRef<PatternGridHandle, PatternGridProps>(
  function PatternGrid(
    {
      hasNextPage,
      isFetchingNextPage,
      items,
      mode,
      onFavorite,
      onInspect,
      onLoadMore,
      onOpenPreview,
      onPaletteToggle,
      onSelect,
      paletteEnabled = false,
      selectedIds,
      selectedPaletteColors,
    },
    ref,
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(900);

    useImperativeHandle(
      ref,
      () => ({
        getScrollOffset: () => scrollRef.current?.scrollTop ?? 0,
        restoreScrollOffset: (offset) => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = Math.max(0, offset);
          }
        },
      }),
      [],
    );

    useLayoutEffect(() => {
      const element = scrollRef.current;
      if (!element || typeof ResizeObserver === "undefined") return;
      const styles = getComputedStyle(element);
      const initialWidth =
        element.clientWidth -
        Number.parseFloat(styles.paddingLeft || "0") -
        Number.parseFloat(styles.paddingRight || "0");
      setWidth(Math.max(280, initialWidth));
      const observer = new ResizeObserver(([entry]) => {
        if (entry) setWidth(Math.max(280, entry.contentRect.width));
      });
      observer.observe(element);
      return () => observer.disconnect();
    }, []);

    const columns = useMemo(() => {
      return resolvePatternGridColumns(width, mode);
    }, [mode, width]);
    const rowCount = Math.ceil(items.length / columns);
    const paletteRowHeight = paletteEnabled ? (width <= 720 ? 44 : 28) : 0;
    const rowGap = 16;
    const rowHeight =
      mode === "list"
        ? 96 + paletteRowHeight
        : Math.max(196, (width - (columns - 1) * rowGap) / columns) +
          78 +
          paletteRowHeight +
          rowGap;

    return (
      <div
        className="pattern-results"
        data-virtualized="true"
        ref={scrollRef}
        role="region"
        aria-label="图案结果"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (
            hasNextPage &&
            !isFetchingNextPage &&
            element.scrollHeight - element.scrollTop - element.clientHeight < 480
          ) {
            onLoadMore();
          }
        }}
      >
        <VirtualPatternCanvas
          columns={columns}
          items={items}
          key={`${mode}:${columns}:${rowHeight}`}
          mode={mode}
          onFavorite={onFavorite}
          onInspect={onInspect}
          onOpenPreview={onOpenPreview}
          onPaletteToggle={onPaletteToggle}
          onSelect={onSelect}
          paletteEnabled={paletteEnabled}
          rowCount={rowCount}
          rowHeight={rowHeight}
          scrollRef={scrollRef}
          selectedIds={selectedIds}
          selectedPaletteColors={selectedPaletteColors}
        />
        {isFetchingNextPage ? (
          <p className="load-more-status" aria-live="polite">
            正在载入更多图案...
          </p>
        ) : null}
      </div>
    );
  },
);

function VirtualPatternCanvas({
  columns,
  items,
  mode,
  onFavorite,
  onInspect,
  onOpenPreview,
  onPaletteToggle,
  onSelect,
  paletteEnabled,
  rowCount,
  rowHeight,
  scrollRef,
  selectedIds,
  selectedPaletteColors,
}: {
  columns: number;
  items: PatternItem[];
  mode: LibraryViewMode;
  onFavorite: (item: PatternItem) => void;
  onInspect: (id: string) => void;
  onOpenPreview: (id: string) => void;
  onPaletteToggle?: (hex: string) => void;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  paletteEnabled: boolean;
  rowCount: number;
  rowHeight: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  selectedIds: ReadonlySet<string>;
  selectedPaletteColors?: ReadonlySet<string>;
}) {
  // TanStack Virtual is the approved engine; its methods intentionally resist compiler memoization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: () => rowHeight,
    getScrollElement: () => scrollRef.current,
    getItemKey: getRowKey,
    initialRect: { width: 900, height: 700 },
    overscan: 2,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const visibleRows =
    virtualRows.length > 0 || rowCount === 0
      ? virtualRows
      : Array.from(
          { length: Math.min(rowCount, Math.ceil(700 / rowHeight) + 2) },
          (_, index) => ({
            index,
            key: index,
            size: rowHeight,
            start: index * rowHeight,
          }),
        );

  return (
    <div
      className="virtual-pattern-canvas"
      role="list"
      aria-label="图案列表"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {visibleRows.map((virtualRow) => {
        const start = virtualRow.index * columns;
        const rowItems = items.slice(start, start + columns);
        return (
          <div
            className="virtual-pattern-row"
            data-mode={mode}
            key={virtualRow.key}
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {rowItems.map((item) => (
              <PatternCard
                item={item}
                key={item.id}
                mode={mode}
                onFavorite={onFavorite}
                onInspect={onInspect}
                onOpenPreview={onOpenPreview}
                onPaletteToggle={onPaletteToggle}
                onSelect={onSelect}
                paletteEnabled={paletteEnabled}
                selected={selectedIds.has(item.id)}
                selectedPaletteColors={selectedPaletteColors}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
