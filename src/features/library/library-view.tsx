"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  type InfiniteData,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { Download, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  patternQuerySchema,
  type PatternQuery,
} from "@/features/patterns/contracts";
import { readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import { IconButton } from "./icon-button";
import { Inspector, MultiSelectionInspector } from "./inspector";
import type { PatternPage } from "./library-types";
import {
  LibraryToolbar,
  type LibraryViewMode,
} from "./library-toolbar";
import { FormatPlaceholder } from "./pattern-card";
import { PatternGrid } from "./pattern-grid";
import { usePatternPatchMutation } from "./pattern-mutations";
import { serializeLibrarySearchParams } from "./query-state";
import { useSelectionStore } from "./selection-store";

async function fetchPatternPage(query: PatternQuery, cursor: string | null) {
  const searchParams = serializeLibrarySearchParams(query);
  if (cursor) searchParams.set("cursor", cursor);
  else searchParams.delete("cursor");
  return readApiResponse<PatternPage>(
    await fetch(`/api/patterns?${searchParams.toString()}`),
  );
}

const blocksLibraryShortcut = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'a, button, input, select, textarea, [contenteditable="true"], [role="dialog"], [role="listbox"], [role="menu"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
    ),
  );
};

export function LibraryView({ initialQuery }: { initialQuery: PatternQuery }) {
  const router = useRouter();
  const pathname = usePathname();
  const ownerId = useQueryOwnerId();
  const [viewMode, setViewMode] = useState<LibraryViewMode>("grid");
  const [collapsedSelectionKey, setCollapsedSelectionKey] = useState<
    string | null
  >(null);
  const selectedIds = useSelectionStore((state) => state.selectedIds);
  const previewId = useSelectionStore((state) => state.previewId);
  const select = useSelectionStore((state) => state.select);
  const clearSelection = useSelectionStore((state) => state.clear);
  const closePreview = useSelectionStore((state) => state.closePreview);
  const openPreview = useSelectionStore((state) => state.openPreview);
  const reconcileSelection = useSelectionStore((state) => state.reconcile);
  const togglePreview = useSelectionStore((state) => state.togglePreview);
  const mutation = usePatternPatchMutation(initialQuery);
  const querySignature = serializeLibrarySearchParams(initialQuery).toString();
  const patternsQuery = useInfiniteQuery<
    PatternPage,
    Error,
    InfiniteData<PatternPage, string | null>,
    ReturnType<typeof queryKeys.patterns>,
    string | null
  >({
    queryKey: queryKeys.patterns(ownerId, initialQuery),
    queryFn: ({ pageParam }) => fetchPatternPage(initialQuery, pageParam),
    initialPageParam: initialQuery.cursor ?? null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const items = useMemo(
    () => patternsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [patternsQuery.data],
  );
  const orderedIds = useMemo(() => items.map((item) => item.id), [items]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedPatterns = useMemo(
    () => items.filter((item) => selectedSet.has(item.id)),
    [items, selectedSet],
  );
  const previewPattern = items.find((item) => item.id === previewId) ?? null;
  const selectionKey = selectedIds.join("|");
  const inspectorCollapsed =
    selectedIds.length > 0 && collapsedSelectionKey === selectionKey;

  useEffect(() => {
    clearSelection();
  }, [clearSelection, querySignature]);

  useEffect(() => {
    reconcileSelection(orderedIds);
  }, [orderedIds, reconcileSelection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === " ") {
        if (blocksLibraryShortcut(event.target)) return;
        if (selectedIds.length === 0) return;
        event.preventDefault();
        togglePreview();
      } else if (event.key === "Escape") {
        if (previewId) {
          closePreview();
          return;
        }
        if (blocksLibraryShortcut(event.target)) return;
        clearSelection();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [clearSelection, closePreview, previewId, selectedIds.length, togglePreview]);

  const updateQuery = (nextQuery: PatternQuery) => {
    const parsed = patternQuerySchema.parse(nextQuery);
    const next = serializeLibrarySearchParams(parsed).toString();
    router.replace(`${pathname}${next ? `?${next}` : ""}`);
  };

  const showInspector = selectedIds.length > 0 && !inspectorCollapsed;

  return (
    <main className="library-layout">
      <section className="library-center" aria-labelledby="library-title">
        <header className="library-heading">
          <div>
            <p>私人图案库</p>
            <h1 id="library-title">全部图案</h1>
          </div>
        </header>
        <LibraryToolbar
          key={querySignature}
          inspectorHidden={inspectorCollapsed}
          onQueryChange={updateQuery}
          onShowInspector={() => setCollapsedSelectionKey(null)}
          onViewModeChange={setViewMode}
          query={initialQuery}
          resultCount={items.length}
          selectedCount={selectedIds.length}
          viewMode={viewMode}
        />

        {patternsQuery.isPending ? (
          <div className="library-state" aria-live="polite">
            <span className="loading-line" />
            <p>正在载入图案...</p>
          </div>
        ) : patternsQuery.isError ? (
          <div className="library-state" role="alert">
            <strong>图库暂时无法载入</strong>
            <p>请检查网络后重试。</p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void patternsQuery.refetch()}
            >
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="library-state">
            <strong>这里还没有图案</strong>
            <p>上传功能接入后，新图案会显示在这里。</p>
          </div>
        ) : (
          <PatternGrid
            hasNextPage={patternsQuery.hasNextPage}
            isFetchingNextPage={patternsQuery.isFetchingNextPage}
            items={items}
            mode={viewMode}
            onFavorite={(item) =>
              mutation.mutatePattern({
                patternId: item.id,
                patch: {
                  version: item.version,
                  isFavorite: !item.isFavorite,
                },
              })
            }
            onLoadMore={() => void patternsQuery.fetchNextPage()}
            onOpenPreview={openPreview}
            onSelect={(id, modifiers) => select(id, orderedIds, modifiers)}
            selectedIds={selectedSet}
          />
        )}
      </section>

      {showInspector && selectedPatterns.length === 1 ? (
        <Inspector
          key={selectedPatterns[0]!.id}
          activeQuery={initialQuery}
          onCollapse={() => setCollapsedSelectionKey(selectionKey)}
          pattern={selectedPatterns[0]!}
        />
      ) : null}
      {showInspector && selectedPatterns.length > 1 ? (
        <MultiSelectionInspector
          count={selectedPatterns.length}
          onCollapse={() => setCollapsedSelectionKey(selectionKey)}
        />
      ) : null}

      <Dialog.Root
        open={previewPattern !== null}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          {previewPattern ? (
            <Dialog.Content
              className="preview-dialog"
              aria-describedby="preview-description"
            >
              <header className="preview-header">
                <div>
                  <Dialog.Title>{previewPattern.name} 预览</Dialog.Title>
                  <Dialog.Description id="preview-description">
                    {previewPattern.originalFilename}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <IconButton label="关闭预览">
                    <X aria-hidden="true" />
                  </IconButton>
                </Dialog.Close>
              </header>
              <div className="preview-stage">
                <FormatPlaceholder
                  extension={previewPattern.extension}
                  previewStatus={previewPattern.previewStatus}
                />
              </div>
              <footer className="preview-footer">
                <button className="secondary-button" type="button" disabled>
                  <Download aria-hidden="true" />
                  下载将在存储接入后开放
                </button>
              </footer>
            </Dialog.Content>
          ) : null}
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
