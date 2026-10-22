"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ImageSearchFiltersInput } from "@/features/image-search/contracts";
import { ApiResponseError } from "@/lib/query/client";

import type { PaletteSearchResponse } from "./contracts";
import { searchPatternsByPalette } from "./palette-search-client";

export type PaletteSearchSessionInput<TSnapshot> = {
  ownerId: string;
  filters: ImageSearchFiltersInput;
  filterSignature: string;
  prepareEnter: () => TSnapshot;
  restoreSnapshot: (snapshot: TSnapshot) => void;
  search?: typeof searchPatternsByPalette;
};

export type PaletteSearchSession = {
  active: boolean;
  colors: readonly string[];
  response: PaletteSearchResponse | null;
  busy: boolean;
  error: string | null;
  retry: { colors: readonly string[]; message: string } | null;
  limitMessage: string | null;
  toggleColor: (hex: string) => void;
  removeColor: (hex: string) => void;
  clear: () => void;
  retryInitialFailure: () => void;
};

type PaletteSearchState = Omit<
  PaletteSearchSession,
  "toggleColor" | "removeColor" | "clear" | "retryInitialFailure"
> & {
  sessionOwnerId: string | null;
};

const debounceMs = 150;
const maxColors = 5;
const paletteHex = /^#[0-9A-F]{6}$/;

function emptyState(): PaletteSearchState {
  return {
    active: false,
    busy: false,
    colors: [],
    error: null,
    limitMessage: null,
    response: null,
    retry: null,
    sessionOwnerId: null,
  };
}

function sameColors(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((color, index) => color === right[index])
  );
}

function paletteSearchErrorMessage(error: unknown) {
  if (error instanceof ApiResponseError) {
    const messages: Record<string, string> = {
      PALETTE_SEARCH_INVALID_COLORS: "所选颜色无效，请重新选择",
      PALETTE_SEARCH_NO_INDEX: "当前范围还没有可搜索的色卡",
      PALETTE_SEARCH_TIMEOUT: "配色搜索超时，请重试",
      PALETTE_SEARCH_UNAVAILABLE: "配色搜索暂时不可用",
    };
    return messages[error.code] ?? "配色搜索失败，请检查网络后重试";
  }
  return "配色搜索失败，请检查网络后重试";
}

export function usePaletteSearchSession<TSnapshot>({
  ownerId,
  filters,
  filterSignature,
  prepareEnter,
  restoreSnapshot,
  search = searchPatternsByPalette,
}: PaletteSearchSessionInput<TSnapshot>): PaletteSearchSession {
  const [state, setState] = useState<PaletteSearchState>(emptyState);
  const stateRef = useRef(state);
  const snapshotRef = useRef<TSnapshot | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const ownerRef = useRef(ownerId);
  const requestSignatureRef = useRef<string | null>(null);
  const dependenciesRef = useRef({
    filters,
    prepareEnter,
    restoreSnapshot,
    search,
  });

  useEffect(() => {
    dependenciesRef.current = {
      filters,
      prepareEnter,
      restoreSnapshot,
      search,
    };
  }, [filters, prepareEnter, restoreSnapshot, search]);

  const commit = useCallback(
    (
      update:
        | PaletteSearchState
        | ((current: PaletteSearchState) => PaletteSearchState),
    ) => {
      const next =
        typeof update === "function" ? update(stateRef.current) : update;
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  const cancelPending = useCallback((message: string) => {
    runRef.current += 1;
    requestSignatureRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    controllerRef.current?.abort(new DOMException(message, "AbortError"));
    controllerRef.current = null;
  }, []);

  const restoreAndDeactivate = useCallback(
    (retry: PaletteSearchState["retry"] = null) => {
      cancelPending("Palette search exited");
      const snapshot = snapshotRef.current;
      snapshotRef.current = null;
      commit({ ...emptyState(), retry });
      if (snapshot !== null) {
        dependenciesRef.current.restoreSnapshot(snapshot);
      }
    },
    [cancelPending, commit],
  );

  const enter = useCallback(
    (colors: readonly string[]) => {
      snapshotRef.current = dependenciesRef.current.prepareEnter();
      commit({
        ...emptyState(),
        active: true,
        colors: [...colors],
        sessionOwnerId: ownerRef.current,
      });
    },
    [commit],
  );

  const removeColor = useCallback(
    (rawHex: string) => {
      const hex = rawHex.toUpperCase();
      const current = stateRef.current;
      if (!current.active || !current.colors.includes(hex)) return;
      const colors = current.colors.filter((color) => color !== hex);
      if (colors.length === 0) {
        restoreAndDeactivate();
        return;
      }
      commit({
        ...current,
        colors,
        error: null,
        limitMessage: null,
      });
    },
    [commit, restoreAndDeactivate],
  );

  const toggleColor = useCallback(
    (rawHex: string) => {
      const hex = rawHex.toUpperCase();
      if (!paletteHex.test(hex)) return;
      const current = stateRef.current;
      if (current.active && current.colors.includes(hex)) {
        removeColor(hex);
        return;
      }
      if (current.active && current.colors.length >= maxColors) {
        commit({
          ...current,
          limitMessage: "最多选择 5 个颜色",
        });
        return;
      }
      if (!current.active) {
        enter([hex]);
        return;
      }
      commit({
        ...current,
        colors: [...current.colors, hex],
        error: null,
        limitMessage: null,
      });
    },
    [commit, enter, removeColor],
  );

  const clear = useCallback(() => {
    if (stateRef.current.active) {
      restoreAndDeactivate();
      return;
    }
    cancelPending("Palette search cleared");
    snapshotRef.current = null;
    commit(emptyState());
  }, [cancelPending, commit, restoreAndDeactivate]);

  const retryInitialFailure = useCallback(() => {
    const retry = stateRef.current.retry;
    if (!retry) return;
    enter(retry.colors);
  }, [enter]);

  useEffect(() => {
    if (ownerRef.current === ownerId) return;
    ownerRef.current = ownerId;
    cancelPending("Palette search owner changed");
    snapshotRef.current = null;
    commit(emptyState());
  }, [cancelPending, commit, ownerId]);

  const colorSignature = state.colors.join(",");
  useEffect(() => {
    if (
      !state.active ||
      state.colors.length === 0 ||
      state.sessionOwnerId !== ownerId
    ) {
      return;
    }

    cancelPending("Palette search replaced");
    const run = runRef.current;
    const requestColors = [...state.colors];
    const requestFilters = dependenciesRef.current.filters;
    const requestSignature = `${filterSignature}\u0000${requestColors.join("\u0000")}`;
    requestSignatureRef.current = requestSignature;
    commit((current) => ({
      ...current,
      busy: true,
      error: null,
      limitMessage: null,
    }));

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const controller = new AbortController();
      controllerRef.current = controller;
      void dependenciesRef.current
        .search({
          colors: requestColors,
          filters: requestFilters,
          requestId: crypto.randomUUID(),
          signal: controller.signal,
        })
        .then((response) => {
          if (
            controller.signal.aborted ||
            runRef.current !== run ||
            requestSignatureRef.current !== requestSignature
          ) {
            return;
          }
          if (!sameColors(response.query.colors, requestColors)) {
            throw new Error("Palette search response did not echo the request");
          }
          commit((current) => ({
            ...current,
            busy: false,
            error: null,
            response,
            retry: null,
          }));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || runRef.current !== run) return;
          const message = paletteSearchErrorMessage(error);
          if (stateRef.current.response) {
            commit((current) => ({
              ...current,
              busy: false,
              error: message,
            }));
            return;
          }
          const snapshot = snapshotRef.current;
          snapshotRef.current = null;
          runRef.current += 1;
          requestSignatureRef.current = null;
          controllerRef.current = null;
          commit({
            ...emptyState(),
            retry: { colors: requestColors, message },
          });
          if (snapshot !== null) {
            dependenciesRef.current.restoreSnapshot(snapshot);
          }
        })
        .finally(() => {
          if (controllerRef.current === controller) {
            controllerRef.current = null;
          }
        });
    }, debounceMs);

    return () => cancelPending("Palette search changed");
  }, [
    cancelPending,
    colorSignature,
    commit,
    filterSignature,
    ownerId,
    state.active,
    state.colors,
    state.sessionOwnerId,
  ]);

  useEffect(
    () => () => {
      cancelPending("Palette search closed");
      snapshotRef.current = null;
    },
    [cancelPending],
  );

  return useMemo(
    () => ({
      active: state.active,
      busy: state.busy,
      clear,
      colors: state.colors,
      error: state.error,
      limitMessage: state.limitMessage,
      removeColor,
      response: state.response,
      retry: state.retry,
      retryInitialFailure,
      toggleColor,
    }),
    [clear, removeColor, retryInitialFailure, state, toggleColor],
  );
}
