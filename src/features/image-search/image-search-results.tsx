"use client";

/* eslint-disable @next/next/no-img-element */

import { X } from "lucide-react";
import { useMemo } from "react";

import type { PatternItem } from "@/features/library/library-types";
import type { LibraryViewMode } from "@/features/library/library-toolbar";
import { PatternCard } from "@/features/library/pattern-card";
import type { SelectionModifiers } from "@/features/library/selection-store";

import type { ImageSearchResponse } from "./image-search-client";
import {
  imageSearchMatchKinds,
  type ImageSearchMatchKind,
} from "./contracts";

const resultLimit = 30;

const groupLabels: Record<ImageSearchMatchKind, string> = {
  probable_source: "高概率原图",
  possible_source: "可能是原图",
  visually_similar: "视觉相似",
};

export function flattenImageSearchGroups(
  groups: ImageSearchResponse["groups"],
) {
  const itemsByKind = new Map<ImageSearchMatchKind, PatternItem[]>();
  for (const group of groups) {
    const current = itemsByKind.get(group.kind) ?? [];
    current.push(...group.items);
    itemsByKind.set(group.kind, current);
  }

  let remaining = resultLimit;
  return imageSearchMatchKinds.flatMap((kind) => {
    if (remaining === 0) return [];
    const items = (itemsByKind.get(kind) ?? [])
      .slice(0, remaining)
      .map((item) => ({ ...item, matchKind: kind }));
    remaining -= items.length;
    return items.length > 0 ? [{ kind, items }] : [];
  });
}

export function ImageSearchResults({
  busy = false,
  error = null,
  mode,
  onExit,
  onFavorite,
  onInspect,
  onOpenPreview,
  onPaletteToggle,
  onSelect,
  paletteEnabled = false,
  response,
  selectedIds,
  selectedPaletteColors,
  thumbnailUrl,
}: {
  busy?: boolean;
  error?: string | null;
  mode: LibraryViewMode;
  onExit: () => void;
  onFavorite: (item: PatternItem) => void;
  onInspect: (id: string) => void;
  onOpenPreview: (id: string) => void;
  onPaletteToggle?: (hex: string) => void;
  onSelect: (id: string, modifiers: SelectionModifiers) => void;
  paletteEnabled?: boolean;
  response: ImageSearchResponse;
  selectedIds: ReadonlySet<string>;
  selectedPaletteColors?: ReadonlySet<string>;
  thumbnailUrl: string;
}) {
  const groups = useMemo(
    () => flattenImageSearchGroups(response.groups),
    [response.groups],
  );
  const resultCount = groups.reduce(
    (count, group) => count + group.items.length,
    0,
  );
  const hasSource = groups.some(
    (group) =>
      group.kind === "probable_source" || group.kind === "possible_source",
  );

  return (
    <div className="image-search-results" aria-label="以图搜图结果">
      <header className="image-search-results-header">
        <img alt="查询图片" src={thumbnailUrl} />
        <div>
          <strong>以图搜图</strong>
          <span role={busy ? "status" : undefined}>
            {busy ? "正在更新结果" : `${resultCount} 个结果`}
          </span>
        </div>
        <button className="secondary-button" type="button" onClick={onExit}>
          <X aria-hidden="true" />
          退出搜图
        </button>
      </header>

      {error ? (
        <p className="image-search-results-error" role="alert">
          {error}
        </p>
      ) : null}

      {!hasSource ? (
        <p className="image-search-no-source">未找到可能的原图</p>
      ) : null}

      {resultCount === 0 ? (
        <div className="library-state">
          <strong>没有找到相似图案</strong>
        </div>
      ) : (
        <div className="image-search-result-sections">
          {groups.map((group) => (
            <section
              className="image-search-result-group"
              key={group.kind}
              aria-labelledby={`image-search-${group.kind}`}
            >
              <h2 id={`image-search-${group.kind}`}>
                {groupLabels[group.kind]}
              </h2>
              <div
                className="image-search-result-grid"
                data-mode={mode}
                role="list"
                aria-label={`${groupLabels[group.kind]}结果`}
              >
                {group.items.map((item) => (
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
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
