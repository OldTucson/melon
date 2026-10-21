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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cropImage } from "@/features/image-search/crop-image";
import {
  ImageSearchDialog,
  type ImageSearchDialogPhase,
  type ImageSearchDialogSubmit,
} from "@/features/image-search/image-search-dialog";
import {
  ImageSearchFileError,
  searchPatternsByImage,
  type ImageSearchResponse,
} from "@/features/image-search/image-search-client";
import {
  flattenImageSearchGroups,
  ImageSearchResults,
} from "@/features/image-search/image-search-results";
import { useImageSearchStore } from "@/features/image-search/image-search-store";
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
import type { PatternItem, PatternPage } from "./library-types";
import { LibraryToolbar, type LibraryViewMode } from "./library-toolbar";
import { FormatPlaceholder } from "./pattern-card";
import { PatternGrid, type PatternGridHandle } from "./pattern-grid";
import { usePatternPatchMutation } from "./pattern-mutations";
import {
  isTransientPatternStatus,
  patternStatusRefreshInterval,
} from "./pattern-status-watch";
import { serializeLibrarySearchParams } from "./query-state";
import {
  useSelectionStore,
  type SelectionModifiers,
} from "./selection-store";
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

function toImageSearchFilters(query: PatternQuery) {
  return {
    q: query.q,
    formats: query.formats,
    tagIds: query.tagIds,
    tagMode: query.tagMode,
    untagged: query.untagged,
    favorite: query.favorite,
    previewStatus: query.previewStatus,
    commercialState: query.commercialState,
    authorizationField: query.authorizationField,
    folderId: query.folderId,
    unfiled: query.unfiled,
    includeDescendants: query.includeDescendants,
  };
}

function imageSearchErrorMessage(error: unknown) {
  if (error instanceof ImageSearchFileError) {
    return error.code === "too_large"
      ? "裁剪后的图片超过 20 MB，请缩小裁剪范围"
      : "无法处理这张图片，请重新选择";
  }
  if (error instanceof ApiResponseError) {
    const messages: Record<string, string> = {
      IMAGE_SEARCH_BUSY: "图像搜索正忙，请稍后重试",
      IMAGE_SEARCH_IMAGE_TOO_LARGE: "图片尺寸过大，请选择较小的图片",
      IMAGE_SEARCH_INVALID_FILE: "图片无法识别，请重新选择",
      IMAGE_SEARCH_NO_INDEX: "当前范围还没有可搜索的图像索引",
      IMAGE_SEARCH_SCOPE_TOO_LARGE: "当前筛选范围过大，请先缩小范围",
      IMAGE_SEARCH_TIMEOUT: "搜索超时，请重试",
      IMAGE_SEARCH_UNAVAILABLE: "图像搜索暂时不可用，其他图库功能不受影响",
    };
    return messages[error.code] ?? "图像搜索失败，请检查网络后重试";
  }
  return "图像搜索失败，请检查网络后重试";
}

type ImageSearchSelection = {
  anchorId: string | null;
  inspectorIds: string[];
  previewId: string | null;
  selectedIds: string[];
};

type ImageSearchWorkspaceSnapshot = {
  collapsedInspectorKey: string | null;
  query: PatternQuery;
  querySignature: string;
  scrollOffset: number;
  selection: ImageSearchSelection;
  url: string;
  viewMode: LibraryViewMode;
};

type ImageSearchSession = {
  file: File;
  filterSignature: string;
  response: ImageSearchResponse | null;
  selection: ImageSearchSelection;
  snapshot: ImageSearchWorkspaceSnapshot;
  thumbnailUrl: string;
};

const emptyImageSearchSelection = (): ImageSearchSelection => ({
  anchorId: null,
  inspectorIds: [],
  previewId: null,
  selectedIds: [],
});

function selectImageSearchResult(
  current: ImageSearchSelection,
  id: string,
  orderedIds: readonly string[],
  modifiers: SelectionModifiers,
): ImageSearchSelection {
  if (modifiers.shiftKey && current.anchorId) {
    const anchorIndex = orderedIds.indexOf(current.anchorId);
    const targetIndex = orderedIds.indexOf(id);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      return { ...current, selectedIds: orderedIds.slice(start, end + 1) };
    }
  }
  if (modifiers.metaKey || modifiers.ctrlKey) {
    const selectedIds = current.selectedIds.includes(id)
      ? current.selectedIds.filter((selectedId) => selectedId !== id)
      : [...current.selectedIds, id];
    return { ...current, anchorId: id, selectedIds };
  }
  return { ...current, anchorId: id, selectedIds: [id] };
}

function reconcileImageSearchSelection(
  current: ImageSearchSelection,
  orderedIds: readonly string[],
): ImageSearchSelection {
  const available = new Set(orderedIds);
  const selectedIds = current.selectedIds.filter((id) => available.has(id));
  return {
    anchorId:
      current.anchorId && available.has(current.anchorId)
        ? current.anchorId
        : (selectedIds[0] ?? null),
    inspectorIds: current.inspectorIds.filter((id) => available.has(id)),
    previewId:
      current.previewId && available.has(current.previewId)
        ? current.previewId
        : null,
    selectedIds,
  };
}

function mergeImageSearchPattern(
  response: ImageSearchResponse,
  updated: PatternPage["items"][number],
): ImageSearchResponse {
  return {
    ...response,
    groups: response.groups.map((group) => ({
      ...group,
      items: group.items.map((item) =>
        item.id === updated.id
          ? {
              ...updated,
              commercialSummary:
                updated.commercialSummary ?? item.commercialSummary,
              matchKind: item.matchKind,
            }
          : item,
      ),
    })),
  };
}

function removeImageSearchPattern(
  response: ImageSearchResponse,
  patternId: string,
): ImageSearchResponse {
  return {
    ...response,
    groups: response.groups.flatMap((group) => {
      const items = group.items.filter((item) => item.id !== patternId);
      return items.length > 0 ? [{ ...group, items }] : [];
    }),
  };
}

function imageSearchMembershipMayChange(
  previous: PatternItem,
  updated: PatternItem,
  query: PatternQuery,
) {
  if (previous.status !== updated.status) return true;
  if (
    (query.folderId !== undefined || query.unfiled !== undefined) &&
    previous.folderId !== updated.folderId
  ) {
    return true;
  }
  if (
    query.favorite !== undefined &&
    previous.isFavorite !== updated.isFavorite
  ) {
    return true;
  }
  if (
    query.q &&
    (previous.name !== updated.name ||
      previous.originalFilename !== updated.originalFilename)
  ) {
    return true;
  }
  if (
    query.previewStatus &&
    previous.previewStatus !== updated.previewStatus
  ) {
    return true;
  }
  return Boolean(
    (query.commercialState || query.authorizationField) &&
      previous.commercialSummary !== updated.commercialSummary,
  );
}

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
  const patternGridRef = useRef<PatternGridHandle>(null);
  const imageSearchDialogOpen = useImageSearchStore(
    (state) => state.dialogOpen,
  );
  const imageSearchOpenRequest = useImageSearchStore(
    (state) => state.openRequest,
  );
  const resetImageSearchForOwner = useImageSearchStore(
    (state) => state.resetForOwner,
  );
  const setImageSearchDialogOpen = useImageSearchStore(
    (state) => state.setDialogOpen,
  );
  const [imageSearchPhase, setImageSearchPhase] =
    useState<ImageSearchDialogPhase>("idle");
  const [imageSearchError, setImageSearchError] = useState<string | null>(null);
  const imageSearchAbort = useRef<AbortController | null>(null);
  const imageSearchRun = useRef(0);
  const imageSearchSessionRef = useRef<ImageSearchSession | null>(null);
  const [imageSearchSession, setImageSearchSession] =
    useState<ImageSearchSession | null>(null);
  const restoringQuerySignature = useRef<string | null>(null);
  const updateImageSearchSession = useCallback(
    (
      update: (current: ImageSearchSession) => ImageSearchSession,
    ) => {
      const current = imageSearchSessionRef.current;
      if (!current) return;
      const next = update(current);
      imageSearchSessionRef.current = next;
      setImageSearchSession(next);
    },
    [],
  );
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
  const activeImageSearchSession =
    imageSearchSession && imageSearchSession.response
      ? { ...imageSearchSession, response: imageSearchSession.response }
      : null;
  const imageSearchResponse = activeImageSearchSession?.response;
  const imageSearchGroups = useMemo(
    () =>
      imageSearchResponse
        ? flattenImageSearchGroups(imageSearchResponse.groups)
        : [],
    [imageSearchResponse],
  );
  const imageSearchItems = useMemo(
    () => imageSearchGroups.flatMap((group) => group.items),
    [imageSearchGroups],
  );
  const imageSearchActive = activeImageSearchSession !== null;
  const visibleInspectorIds = activeImageSearchSession
    ? activeImageSearchSession.selection.inspectorIds
    : inspectorIds;
  const visibleSelectedIds = activeImageSearchSession
    ? activeImageSearchSession.selection.selectedIds
    : selectedIds;
  const visiblePreviewId = activeImageSearchSession
    ? activeImageSearchSession.selection.previewId
    : previewId;
  const soleInspectorId =
    visibleInspectorIds.length === 1 ? visibleInspectorIds[0] : undefined;
  const soleInspectorPattern = soleInspectorId
    ? (imageSearchActive ? imageSearchItems : items).find(
        (pattern) => pattern.id === soleInspectorId,
      )
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
    !imageSearchActive &&
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
  const normalDisplayItems = useMemo(
    () =>
      inspectedDetailPattern
        ? items.map((item) =>
            item.id === inspectedDetailPattern.id ? inspectedDetailPattern : item,
          )
        : items,
    [items, inspectedDetailPattern],
  );
  const displayItems = imageSearchActive
    ? imageSearchItems
    : normalDisplayItems;
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
    if (!imageSearchActive && inspectedDetailPattern) {
      result.set(inspectedDetailPattern.id, inspectedDetailPattern);
    }
    return result;
  }, [displayItems, imageSearchActive, inspectedDetailPattern]);
  const selectedSet = useMemo(
    () => new Set(visibleSelectedIds),
    [visibleSelectedIds],
  );
  const inspectorPatterns = useMemo(
    () =>
      visibleInspectorIds.flatMap((id) => {
        const pattern = patternsById.get(id);
        return pattern ? [pattern] : [];
      }),
    [patternsById, visibleInspectorIds],
  );
  const previewPattern =
    displayItems.find((item) => item.id === visiblePreviewId) ?? null;
  const inspectorKey = visibleInspectorIds.join("|");
  const selectedKey = visibleSelectedIds.join("|");
  const inspectorCollapsed =
    visibleInspectorIds.length > 0 && collapsedInspectorKey === inspectorKey;
  const watchedPatternUnavailable = Boolean(
    watchedPatternId &&
      ((inspectedPatternQuery.error instanceof ApiResponseError &&
        inspectedPatternQuery.error.status === 404) ||
        (inspectedPatternQuery.data &&
          !libraryStatuses.has(inspectedPatternQuery.data.status))),
  );

  const releaseImageSearchSession = useCallback(() => {
    const session = imageSearchSessionRef.current;
    if (!session) return;
    URL.revokeObjectURL(session.thumbnailUrl);
    imageSearchSessionRef.current = null;
    setImageSearchSession(null);
  }, []);

  const cancelImageSearch = useCallback(() => {
    imageSearchRun.current += 1;
    imageSearchAbort.current?.abort(
      new DOMException("Image search cancelled", "AbortError"),
    );
    imageSearchAbort.current = null;
    releaseImageSearchSession();
    setImageSearchPhase("idle");
    setImageSearchError(null);
  }, [releaseImageSearchSession]);

  useEffect(() => {
    resetImageSearchForOwner(ownerId);
    return () => {
      imageSearchRun.current += 1;
      imageSearchAbort.current?.abort(
        new DOMException("Library closed", "AbortError"),
      );
      imageSearchAbort.current = null;
      const session = imageSearchSessionRef.current;
      if (session) URL.revokeObjectURL(session.thumbnailUrl);
      imageSearchSessionRef.current = null;
    };
  }, [ownerId, resetImageSearchForOwner]);

  useEffect(() => {
    if (restoringQuerySignature.current === querySignature) {
      restoringQuerySignature.current = null;
      return;
    }
    if (imageSearchSessionRef.current?.response) return;
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
    if (imageSearchActive) return;
    reconcileSelection(availableIds);
  }, [availableIds, imageSearchActive, reconcileSelection]);

  useEffect(() => {
    if (imageSearchActive) return;
    if (inspectorIds.length <= 1 || inspectorKey === selectedKey) return;
    if (selectedIds.length > 0) openInspector(selectedIds);
    else closeInspector();
  }, [
    closeInspector,
    imageSearchActive,
    inspectorIds.length,
    inspectorKey,
    openInspector,
    selectedIds,
    selectedKey,
  ]);

  useEffect(() => {
    if (imageSearchActive || !inspectedDetailPattern) return;
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
  }, [imageSearchActive, initialQuery, inspectedDetailPattern, ownerId, queryClient]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === " ") {
        if (blocksLibraryShortcut(event.target)) return;
        if (visibleSelectedIds.length === 0) return;
        event.preventDefault();
        if (imageSearchActive) {
          updateImageSearchSession((session) => ({
            ...session,
            selection: {
              ...session.selection,
              previewId:
                session.selection.previewId === session.selection.selectedIds[0]
                  ? null
                  : (session.selection.selectedIds[0] ?? null),
            },
          }));
        } else {
          togglePreview();
        }
      } else if (event.key === "Escape") {
        if (visiblePreviewId) {
          if (imageSearchActive) {
            updateImageSearchSession((session) => ({
              ...session,
              selection: { ...session.selection, previewId: null },
            }));
          } else {
            closePreview();
          }
          return;
        }
        if (blocksLibraryShortcut(event.target)) return;
        if (imageSearchActive) {
          updateImageSearchSession((session) => ({
            ...session,
            selection: {
              ...session.selection,
              anchorId: null,
              selectedIds: [],
            },
          }));
        } else {
          clearSelection();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    clearSelection,
    closePreview,
    imageSearchActive,
    togglePreview,
    updateImageSearchSession,
    visiblePreviewId,
    visibleSelectedIds,
  ]);

  const updateQuery = (nextQuery: PatternQuery) => {
    const parsed = patternQuerySchema.parse(nextQuery);
    const next = serializeLibrarySearchParams(parsed).toString();
    router.replace(`${pathname}${next ? `?${next}` : ""}`);
  };

  const rerunImageSearch = useCallback(
    async (nextQuery: PatternQuery, nextSignature: string) => {
      const current = imageSearchSessionRef.current;
      if (!current?.response) return;
      const run = imageSearchRun.current + 1;
      imageSearchRun.current = run;
      imageSearchAbort.current?.abort(
        new DOMException("Image search filters changed", "AbortError"),
      );
      const controller = new AbortController();
      imageSearchAbort.current = controller;
      setImageSearchError(null);
      setImageSearchPhase("processing");
      updateImageSearchSession((session) => ({
        ...session,
        filterSignature: nextSignature,
      }));
      try {
        const response = await searchPatternsByImage({
          file: current.file,
          filters: toImageSearchFilters(nextQuery),
          requestId: crypto.randomUUID(),
          signal: controller.signal,
        });
        if (controller.signal.aborted || imageSearchRun.current !== run) return;
        const ids = flattenImageSearchGroups(response.groups)
          .flatMap((group) => group.items)
          .map((item) => item.id);
        updateImageSearchSession((session) => ({
          ...session,
          response,
          selection: reconcileImageSearchSelection(session.selection, ids),
        }));
      } catch (cause) {
        if (controller.signal.aborted || imageSearchRun.current !== run) return;
        setImageSearchError(imageSearchErrorMessage(cause));
      } finally {
        if (imageSearchRun.current === run) {
          imageSearchAbort.current = null;
          setImageSearchPhase("idle");
        }
      }
    },
    [updateImageSearchSession],
  );

  const runImageSearch = async (input: ImageSearchDialogSubmit) => {
    const run = imageSearchRun.current + 1;
    imageSearchRun.current = run;
    const previousSnapshot = imageSearchSessionRef.current?.snapshot;
    imageSearchAbort.current?.abort(
      new DOMException("Image search replaced", "AbortError"),
    );
    releaseImageSearchSession();
    setImageSearchError(null);
    setImageSearchPhase("analyzing");
    const controller = new AbortController();
    imageSearchAbort.current = controller;

    try {
      let submittedFile = input.file;
      if (input.crop) {
        const { displayHeight, displayWidth, ...selectedCrop } = input.crop;
        submittedFile = await cropImage({
          crop: selectedCrop,
          displayHeight,
          displayWidth,
          file: input.file,
        });
      }
      if (controller.signal.aborted || imageSearchRun.current !== run) return;

      const searchParams = serializeLibrarySearchParams(initialQuery);
      if (initialSelectedId) searchParams.set("selected", initialSelectedId);
      const selection = useSelectionStore.getState();
      const session: ImageSearchSession = {
        file: submittedFile,
        filterSignature: querySignature,
        response: null,
        selection: emptyImageSearchSelection(),
        snapshot:
          previousSnapshot ?? {
            collapsedInspectorKey,
            query: initialQuery,
            querySignature,
            scrollOffset: patternGridRef.current?.getScrollOffset() ?? 0,
            selection: {
              anchorId: selection.anchorId,
              inspectorIds: [...selection.inspectorIds],
              previewId: selection.previewId,
              selectedIds: [...selection.selectedIds],
            },
            url: `${pathname}${searchParams.size > 0 ? `?${searchParams}` : ""}`,
            viewMode,
          },
        thumbnailUrl: URL.createObjectURL(submittedFile),
      };
      imageSearchSessionRef.current = session;
      setImageSearchSession(session);
      setImageSearchPhase("processing");
      const response = await searchPatternsByImage({
        file: submittedFile,
        filters: toImageSearchFilters(initialQuery),
        requestId: crypto.randomUUID(),
        signal: controller.signal,
      });
      if (controller.signal.aborted || imageSearchRun.current !== run) return;
      updateImageSearchSession((current) => ({
        ...current,
        response,
        selection: emptyImageSearchSelection(),
      }));
      setImageSearchDialogOpen(false);
    } catch (cause) {
      if (controller.signal.aborted || imageSearchRun.current !== run) return;
      releaseImageSearchSession();
      setImageSearchError(imageSearchErrorMessage(cause));
    } finally {
      if (imageSearchRun.current === run) {
        imageSearchAbort.current = null;
        setImageSearchPhase("idle");
      }
    }
  };

  useEffect(() => {
    const session = imageSearchSessionRef.current;
    if (
      !session?.response ||
      session.filterSignature === querySignature ||
      restoringQuerySignature.current === querySignature
    ) {
      return;
    }
    void rerunImageSearch(initialQuery, querySignature);
  }, [initialQuery, querySignature, rerunImageSearch]);

  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        const key = event.query.queryKey;
        if (
          key.length !== 4 ||
          key[0] !== "owner" ||
          key[1] !== ownerId ||
          key[2] !== "pattern" ||
          typeof key[3] !== "string"
        ) {
          return;
        }
        const session = imageSearchSessionRef.current;
        if (!session?.response) return;
        const previous = session.response.groups
          .flatMap((group) => group.items)
          .find((item) => item.id === key[3]);
        const cached = event.query.state.data;
        if (!previous || !cached || typeof cached !== "object") return;
        const updated = cached as PatternItem;
        if (updated.id !== previous.id || updated.ownerId !== ownerId) return;
        const merged = {
          ...updated,
          commercialSummary:
            updated.commercialSummary ?? previous.commercialSummary,
        };
        if (
          merged.version <= previous.version &&
          merged.commercialVersion <= previous.commercialVersion
        ) {
          return;
        }
        if (
          merged.name === previous.name &&
          merged.folderId === previous.folderId &&
          merged.isFavorite === previous.isFavorite &&
          merged.previewStatus === previous.previewStatus &&
          merged.status === previous.status &&
          merged.commercialSummary === previous.commercialSummary
        ) {
          return;
        }
        if (
          merged.status === "trashed" ||
          merged.status === "deleting" ||
          merged.status === "deleted"
        ) {
          updateImageSearchSession((current) => {
            if (!current.response) return current;
            const response = removeImageSearchPattern(
              current.response,
              merged.id,
            );
            const ids = flattenImageSearchGroups(response.groups)
              .flatMap((group) => group.items)
              .map((item) => item.id);
            return {
              ...current,
              response,
              selection: reconcileImageSearchSelection(
                current.selection,
                ids,
              ),
            };
          });
          return;
        }
        updateImageSearchSession((current) => ({
          ...current,
          response: current.response
            ? mergeImageSearchPattern(current.response, merged)
            : null,
        }));
        if (imageSearchMembershipMayChange(previous, merged, initialQuery)) {
          void rerunImageSearch(initialQuery, querySignature);
        }
      }),
    [
      initialQuery,
      ownerId,
      queryClient,
      querySignature,
      rerunImageSearch,
      updateImageSearchSession,
    ],
  );

  const exitImageSearch = useCallback(() => {
    const session = imageSearchSessionRef.current;
    if (!session) return;
    imageSearchRun.current += 1;
    imageSearchAbort.current?.abort(
      new DOMException("Image search exited", "AbortError"),
    );
    imageSearchAbort.current = null;

    const snapshot = session.snapshot;
    const cached = queryClient.getQueryData<
      InfiniteData<PatternPage, string | null>
    >(queryKeys.patterns(ownerId, snapshot.query));
    const available = new Set(
      cached?.pages.flatMap((page) => page.items.map((item) => item.id)) ??
        snapshot.selection.selectedIds,
    );
    for (const id of snapshot.selection.inspectorIds) {
      const detail = queryClient.getQueryData<PatternPage["items"][number]>(
        queryKeys.pattern(ownerId, id),
      );
      if (detail && libraryStatuses.has(detail.status)) available.add(id);
    }
    const restoredSelection = reconcileImageSearchSelection(
      snapshot.selection,
      [...available],
    );
    useSelectionStore.setState(restoredSelection);
    setCollapsedInspectorKey(
      restoredSelection.inspectorIds.length > 0
        ? snapshot.collapsedInspectorKey
        : null,
    );
    setViewMode(snapshot.viewMode);
    restoringQuerySignature.current =
      querySignature === snapshot.querySignature
        ? null
        : snapshot.querySignature;
    releaseImageSearchSession();
    setImageSearchError(null);
    setImageSearchPhase("idle");
    router.replace(snapshot.url);
    requestAnimationFrame(() => {
      patternGridRef.current?.restoreScrollOffset(snapshot.scrollOffset);
    });
  }, [ownerId, queryClient, querySignature, releaseImageSearchSession, router]);

  const selectVisiblePattern = (
    id: string,
    modifiers: SelectionModifiers,
  ) => {
    if (!imageSearchActive) {
      select(id, orderedIds, modifiers);
      return;
    }
    updateImageSearchSession((session) => ({
      ...session,
      selection: selectImageSearchResult(
        session.selection,
        id,
        orderedIds,
        modifiers,
      ),
    }));
  };

  const inspectVisiblePattern = (id: string) => {
    if (!imageSearchActive) {
      openInspector(
        visibleSelectedIds.length > 1 && visibleSelectedIds.includes(id)
          ? visibleSelectedIds
          : [id],
      );
    } else {
      updateImageSearchSession((session) => ({
        ...session,
        selection: {
          ...session.selection,
          inspectorIds:
            session.selection.selectedIds.length > 1 &&
            session.selection.selectedIds.includes(id)
              ? session.selection.selectedIds
              : [id],
        },
      }));
    }
    setCollapsedInspectorKey(null);
  };

  const openVisiblePreview = (id: string) => {
    if (!imageSearchActive) {
      openPreview(id);
      return;
    }
    updateImageSearchSession((session) => ({
      ...session,
      selection: { ...session.selection, previewId: id },
    }));
  };

  const closeVisiblePreview = () => {
    if (!imageSearchActive) {
      closePreview();
      return;
    }
    updateImageSearchSession((session) => ({
      ...session,
      selection: { ...session.selection, previewId: null },
    }));
  };

  const favoriteVisiblePattern = (item: PatternPage["items"][number]) => {
    if (!isPatternEditable(item.status)) return;
    const input = {
      patternId: item.id,
      patch: { version: item.version, isFavorite: !item.isFavorite },
    };
    if (!imageSearchActive) {
      mutation.mutatePattern(input);
      return;
    }
    void mutation.mutatePatternAsync(input).catch(() => undefined);
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
                  if (!imageSearchActive) {
                    clearSelection();
                    closePreview();
                  }
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
            imageSearchActive={imageSearchActive}
            inspectorAvailable={inspectorPatterns.length > 0}
            inspectorHidden={inspectorCollapsed}
            onQueryChange={updateQuery}
            onShowInspector={() => setCollapsedInspectorKey(null)}
            onViewModeChange={setViewMode}
            query={initialQuery}
            resultCount={displayItems.length}
            selectedCount={visibleSelectedIds.length}
            viewMode={viewMode}
          />
          {!imageSearchActive ? (
            <BulkActionBar
              activeQuery={initialQuery}
              loadedPatterns={displayItems}
            />
          ) : null}
        </div>

        {activeImageSearchSession ? (
          <ImageSearchResults
            busy={imageSearchPhase === "processing"}
            error={imageSearchError}
            mode={viewMode}
            onExit={exitImageSearch}
            onFavorite={favoriteVisiblePattern}
            onInspect={inspectVisiblePattern}
            onOpenPreview={openVisiblePreview}
            onSelect={selectVisiblePattern}
            response={activeImageSearchSession.response}
            selectedIds={selectedSet}
            thumbnailUrl={activeImageSearchSession.thumbnailUrl}
          />
        ) : patternsQuery.isPending ? (
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
            ref={patternGridRef}
            hasNextPage={patternsQuery.hasNextPage}
            isFetchingNextPage={patternsQuery.isFetchingNextPage}
            items={displayItems}
            mode={viewMode}
            onFavorite={favoriteVisiblePattern}
            onLoadMore={() => void patternsQuery.fetchNextPage()}
            onInspect={inspectVisiblePattern}
            onOpenPreview={openVisiblePreview}
            onSelect={selectVisiblePattern}
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
            !imageSearchActive &&
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

      {imageSearchDialogOpen ? (
        <ImageSearchDialog
          key={`${ownerId}:${imageSearchOpenRequest}`}
          error={imageSearchError}
          onCancel={cancelImageSearch}
          onOpenChange={(open) => {
            if (!open && imageSearchPhase !== "idle") cancelImageSearch();
            if (!open) setImageSearchError(null);
            setImageSearchDialogOpen(open);
          }}
          onSearch={(input) => void runImageSearch(input)}
          open
          phase={imageSearchPhase}
        />
      ) : null}

      <Dialog.Root
        open={previewPattern !== null}
        onOpenChange={(open) => {
          if (!open) closeVisiblePreview();
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
