"use client";

/* eslint-disable @next/next/no-img-element */

import * as Dialog from "@radix-ui/react-dialog";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Download, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  patternQuerySchema,
  type PatternQuery,
} from "@/features/patterns/contracts";
import { useUploadStore } from "@/features/uploads/upload-store";
import { ApiResponseError, readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import { IconButton } from "./icon-button";
import { Inspector, MultiSelectionInspector } from "./inspector";
import { BulkActionBar } from "./bulk-action-bar";
import { isPatternEditable } from "./selection-availability";
import type { PatternPage } from "./library-types";
import { LibraryToolbar, type LibraryViewMode } from "./library-toolbar";
import { FormatPlaceholder } from "./pattern-card";
import { PatternGrid } from "./pattern-grid";
import { usePatternPatchMutation } from "./pattern-mutations";
import {
  isTransientPatternStatus,
  patternStatusRefreshInterval,
} from "./pattern-status-watch";
import { serializeLibrarySearchParams } from "./query-state";
import { useSelectionStore } from "./selection-store";
import { useFoldersQuery } from "@/features/folders/folder-client";

async function fetchPatternPage(query: PatternQuery, cursor: string | null) {
  const searchParams = serializeLibrarySearchParams(query);
  if (cursor) searchParams.set("cursor", cursor);
  else searchParams.delete("cursor");
  return readApiResponse<PatternPage>(
    await fetch(`/api/patterns?${searchParams.toString()}`),
  );
}

async function fetchPattern(patternId: string) {
  return readApiResponse<PatternPage["items"][number]>(
    await fetch(`/api/patterns/${patternId}`),
  );
}

const libraryStatuses = new Set([
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
]);

const blocksLibraryShortcut = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'a, button, input, select, textarea, [contenteditable="true"], [role="dialog"], [role="listbox"], [role="menu"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
    ),
  );
};

export function LibraryView({
  initialQuery,
  initialSelectedId,
}: {
  initialQuery: PatternQuery;
  initialSelectedId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const ownerId = useQueryOwnerId();
  const queryClient = useQueryClient();
  const folders = useFoldersQuery();
  const activeFolder = !initialQuery.unfiled
    ? folders.data?.find(
        (folder) =>
          folder.id === initialQuery.folderId &&
          folder.status === "active" &&
          !folder.optimisticCreate,
      )
    : undefined;
  const [viewMode, setViewMode] = useState<LibraryViewMode>("grid");
  const [collapsedInspectorKey, setCollapsedInspectorKey] = useState<
    string | null
  >(null);
  const uploadTasks = useUploadStore((state) => state.tasks);
  const inspectorIds = useSelectionStore((state) => state.inspectorIds);
  const selectedIds = useSelectionStore((state) => state.selectedIds);
  const previewId = useSelectionStore((state) => state.previewId);
  const select = useSelectionStore((state) => state.select);
  const clearSelection = useSelectionStore((state) => state.clear);
  const closeInspector = useSelectionStore((state) => state.closeInspector);
  const closePreview = useSelectionStore((state) => state.closePreview);
  const openInspector = useSelectionStore((state) => state.openInspector);
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
  const soleInspectorId = inspectorIds.length === 1 ? inspectorIds[0] : undefined;
  const soleInspectorPattern = soleInspectorId
    ? items.find((pattern) => pattern.id === soleInspectorId)
    : undefined;
  const activeLocalPatternIds = useMemo(
    () =>
      new Set(
        uploadTasks
          .filter(
            (task) =>
              task.runPending ||
              task.recoveryPending ||
              task.cancellationPending,
          )
          .map((task) => task.patternId),
      ),
    [uploadTasks],
  );
  const watchedPatternId =
    soleInspectorId &&
    (!soleInspectorPattern || isTransientPatternStatus(soleInspectorPattern.status))
      ? soleInspectorId
      : undefined;
  const locallyActiveWatch = activeLocalPatternIds.has(watchedPatternId ?? "");
  const watch = useRef<{
    patternId?: string;
    startedAt?: number;
  }>({});
  const inspectedPatternQuery = useQuery({
    queryKey: queryKeys.pattern(ownerId, watchedPatternId ?? "none"),
    queryFn: () => fetchPattern(watchedPatternId!),
    enabled: Boolean(watchedPatternId) && !locallyActiveWatch,
    refetchInterval: (query) => {
      if (locallyActiveWatch) return false;
      const status = query.state.data?.status ?? soleInspectorPattern?.status;
      if (query.state.error) {
        return query.state.error instanceof ApiResponseError &&
          query.state.error.status === 404
          ? false
          : isTransientPatternStatus(status)
            ? 15_000
            : false;
      }
      const currentTime = Date.now();
      let startedAt = watch.current.startedAt;
      if (
        watch.current.patternId !== watchedPatternId ||
        startedAt === undefined
      ) {
        startedAt = currentTime;
        watch.current = {
          patternId: watchedPatternId,
          startedAt,
        };
      }
      return patternStatusRefreshInterval(
        status,
        startedAt,
        currentTime,
      );
    },
    refetchIntervalInBackground: false,
  });
  const inspectedDetailPattern =
    inspectedPatternQuery.data &&
    libraryStatuses.has(inspectedPatternQuery.data.status)
      ? inspectedPatternQuery.data
      : null;
  const displayItems = useMemo(
    () =>
      inspectedDetailPattern
        ? items.map((item) =>
            item.id === inspectedDetailPattern.id ? inspectedDetailPattern : item,
          )
        : items,
    [items, inspectedDetailPattern],
  );
  const orderedIds = useMemo(
    () => displayItems.map((item) => item.id),
    [displayItems],
  );
  const availableIds = useMemo(
    () => {
      const detailId = inspectedDetailPattern?.id ?? initialSelectedId;
      return detailId && !orderedIds.includes(detailId)
        ? [...orderedIds, detailId]
        : orderedIds;
    },
    [initialSelectedId, inspectedDetailPattern, orderedIds],
  );
  const patternsById = useMemo(() => {
    const result = new Map(displayItems.map((item) => [item.id, item]));
    if (inspectedDetailPattern) {
      result.set(inspectedDetailPattern.id, inspectedDetailPattern);
    }
    return result;
  }, [displayItems, inspectedDetailPattern]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const inspectorPatterns = useMemo(
    () =>
      inspectorIds.flatMap((id) => {
        const pattern = patternsById.get(id);
        return pattern ? [pattern] : [];
      }),
    [inspectorIds, patternsById],
  );
  const previewPattern =
    displayItems.find((item) => item.id === previewId) ?? null;
  const inspectorKey = inspectorIds.join("|");
  const selectedKey = selectedIds.join("|");
  const inspectorCollapsed =
    inspectorIds.length > 0 && collapsedInspectorKey === inspectorKey;
  const watchedPatternUnavailable = Boolean(
    watchedPatternId &&
      ((inspectedPatternQuery.error instanceof ApiResponseError &&
        inspectedPatternQuery.error.status === 404) ||
        (inspectedPatternQuery.data &&
          !libraryStatuses.has(inspectedPatternQuery.data.status))),
  );

  useEffect(() => {
    clearSelection();
    closePreview();
    if (initialSelectedId) openInspector([initialSelectedId]);
  }, [clearSelection, closePreview, initialSelectedId, openInspector, querySignature]);

  useEffect(() => {
    if (!watchedPatternId || !watchedPatternUnavailable) return;
    queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
      queryKeys.patterns(ownerId, initialQuery),
      (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.filter(
                  (item) => item.id !== watchedPatternId,
                ),
              })),
            }
          : current,
    );
    if (selectedIds.includes(watchedPatternId)) clearSelection();
    if (inspectorIds.includes(watchedPatternId)) closeInspector();
    if (previewId === watchedPatternId) closePreview();
  }, [
    clearSelection,
    closeInspector,
    closePreview,
    initialQuery,
    inspectorIds,
    ownerId,
    previewId,
    queryClient,
    selectedIds,
    watchedPatternId,
    watchedPatternUnavailable,
  ]);

  useEffect(() => {
    reconcileSelection(availableIds);
  }, [availableIds, reconcileSelection]);

  useEffect(() => {
    if (inspectorIds.length <= 1 || inspectorKey === selectedKey) return;
    if (selectedIds.length > 0) openInspector(selectedIds);
    else closeInspector();
  }, [
    closeInspector,
    inspectorIds.length,
    inspectorKey,
    openInspector,
    selectedIds,
    selectedKey,
  ]);

  useEffect(() => {
    if (!inspectedDetailPattern) return;
    queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
      queryKeys.patterns(ownerId, initialQuery),
      (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === inspectedDetailPattern.id
                    ? inspectedDetailPattern
                    : item,
                ),
              })),
            }
          : current,
    );
  }, [initialQuery, inspectedDetailPattern, ownerId, queryClient]);

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
  }, [
    clearSelection,
    closePreview,
    previewId,
    selectedIds.length,
    togglePreview,
  ]);

  const updateQuery = (nextQuery: PatternQuery) => {
    const parsed = patternQuerySchema.parse(nextQuery);
    const next = serializeLibrarySearchParams(parsed).toString();
    router.replace(`${pathname}${next ? `?${next}` : ""}`);
  };

  const showInspector = inspectorPatterns.length > 0 && !inspectorCollapsed;

  return (
    <main
      className="library-layout"
      data-inspector={showInspector ? "open" : undefined}
    >
      <section className="library-center" aria-labelledby="library-title">
        <header className="library-heading">
          <div>
            <p>私人图案库</p>
            <h1 id="library-title" title={initialQuery.unfiled ? "未分类" : (activeFolder?.name ?? "全部图案")}>
              {initialQuery.unfiled
                ? "未分类"
                : (activeFolder?.name ?? "全部图案")}
            </h1>
          </div>
          {activeFolder && (
            <label className="folder-descendants-toggle">
              <input
                type="checkbox"
                aria-label="包含子文件夹内容"
                checked={initialQuery.includeDescendants !== false}
                onChange={(event) => {
                  clearSelection();
                  closePreview();
                  updateQuery({
                    ...initialQuery,
                    includeDescendants: event.target.checked,
                    cursor: undefined,
                    unfiled: undefined,
                  });
                }}
              />
              包含子文件夹内容
            </label>
          )}
        </header>
        <div className="library-controls">
          <LibraryToolbar
            key={querySignature}
            inspectorAvailable={inspectorPatterns.length > 0}
            inspectorHidden={inspectorCollapsed}
            onQueryChange={updateQuery}
            onShowInspector={() => setCollapsedInspectorKey(null)}
            onViewModeChange={setViewMode}
            query={initialQuery}
            resultCount={items.length}
            selectedCount={selectedIds.length}
            viewMode={viewMode}
          />
            <BulkActionBar
              activeQuery={initialQuery}
              loadedPatterns={displayItems}
            />
        </div>

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
          ) : displayItems.length === 0 ? (
          <div className="library-state">
            <strong>这里还没有图案</strong>
          </div>
        ) : (
          <PatternGrid
            hasNextPage={patternsQuery.hasNextPage}
            isFetchingNextPage={patternsQuery.isFetchingNextPage}
            items={displayItems}
            mode={viewMode}
            onFavorite={(item) =>
              isPatternEditable(item.status)
                ? mutation.mutatePattern({
                    patternId: item.id,
                    patch: {
                      version: item.version,
                      isFavorite: !item.isFavorite,
                    },
                  })
                : undefined
            }
            onLoadMore={() => void patternsQuery.fetchNextPage()}
            onInspect={(id) => {
              openInspector(
                selectedIds.length > 1 && selectedIds.includes(id)
                  ? selectedIds
                  : [id],
              );
              setCollapsedInspectorKey(null);
            }}
            onOpenPreview={openPreview}
            onSelect={(id, modifiers) => select(id, orderedIds, modifiers)}
            selectedIds={selectedSet}
          />
        )}
      </section>

      {showInspector && inspectorPatterns.length === 1 ? (
        <Inspector
          key={inspectorPatterns[0]!.id}
          activeQuery={initialQuery}
          onCollapse={() => setCollapsedInspectorKey(inspectorKey)}
          pattern={inspectorPatterns[0]!}
          statusCheck={
            isTransientPatternStatus(inspectorPatterns[0]!.status)
              ? {
                  isError: inspectedPatternQuery.isError,
                  isFetching: inspectedPatternQuery.isFetching,
                  refetch: () => void inspectedPatternQuery.refetch(),
                }
              : undefined
          }
        />
      ) : null}
      {showInspector && inspectorPatterns.length > 1 ? (
        <MultiSelectionInspector
          activeQuery={initialQuery}
          patterns={inspectorPatterns}
          onCollapse={() => setCollapsedInspectorKey(inspectorKey)}
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
              <PreviewStage pattern={previewPattern} />
              <footer className="preview-footer">
                {previewPattern.sourceAssetId ? (
                  <a
                    className="secondary-button"
                    href={`/api/assets/${previewPattern.sourceAssetId}/download`}
                  >
                    <Download aria-hidden="true" />
                    下载原文件
                  </a>
                ) : null}
              </footer>
            </Dialog.Content>
          ) : null}
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

function PreviewStage({ pattern }: { pattern: PatternPage["items"][number] }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="preview-stage">
      {pattern.previewAssetId && !failed ? (
        <img
          alt={`${pattern.name} 预览图`}
          src={`/api/assets/${pattern.previewAssetId}/view`}
          onError={() => setFailed(true)}
        />
      ) : (
        <FormatPlaceholder
          extension={pattern.extension}
          previewStatus={pattern.previewStatus}
        />
      )}
    </div>
  );
}
