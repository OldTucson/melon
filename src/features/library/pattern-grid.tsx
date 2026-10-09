"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
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

export function PatternGrid({
  hasNextPage,
  isFetchingNextPage,
  items,
  mode,
  onFavorite,
  onLoadMore,
  onOpenPreview,
  onSelect,
  selectedIds,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  items: PatternItem[];
  mode: LibraryViewMode;
  onFavorite: (item: PatternItem) => void;
  onLoadMore: () => void;
  onOpenPreview: (id: string) => void;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  selectedIds: ReadonlySet<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);

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
    if (mode === "list") return 1;
    return Math.max(1, Math.min(6, Math.floor((width + 12) / 196)));
  }, [mode, width]);
  const rowCount = Math.ceil(items.length / columns);
  const rowHeight =
    mode === "list" ? 88 : Math.max(196, (width - (columns - 1) * 12) / columns) + 68;

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
        onOpenPreview={onOpenPreview}
        onSelect={onSelect}
        rowCount={rowCount}
        rowHeight={rowHeight}
        scrollRef={scrollRef}
        selectedIds={selectedIds}
      />
      {isFetchingNextPage ? (
        <p className="load-more-status" aria-live="polite">
          正在载入更多图案...
        </p>
      ) : null}
    </div>
  );
}

function VirtualPatternCanvas({
  columns,
  items,
  mode,
  onFavorite,
  onOpenPreview,
  onSelect,
  rowCount,
  rowHeight,
  scrollRef,
  selectedIds,
}: {
  columns: number;
  items: PatternItem[];
  mode: LibraryViewMode;
  onFavorite: (item: PatternItem) => void;
  onOpenPreview: (id: string) => void;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  rowCount: number;
  rowHeight: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  selectedIds: ReadonlySet<string>;
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
                onOpenPreview={onOpenPreview}
                onSelect={onSelect}
                selected={selectedIds.has(item.id)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
