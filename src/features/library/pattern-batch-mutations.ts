"use client";

import {
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import type { PatternQuery } from "@/features/patterns/contracts";
import { ApiResponseError, readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import type { PatternItem, PatternPage } from "./library-types";
import { useSelectionStore } from "./selection-store";

type PatternRef = Pick<PatternItem, "id" | "version">;

export type PatternBatchInput =
  | { action: "move"; folderId: string | null; patterns: PatternItem[] }
  | { action: "favorite"; isFavorite: boolean; patterns: PatternItem[] }
  | { action: "trash"; patterns: PatternItem[] };

export type PatternBatchIntent =
  | {
      action: "move";
      folderId: string | null;
      operationId: string;
      patterns: PatternRef[];
    }
  | {
      action: "favorite";
      isFavorite: boolean;
      operationId: string;
      patterns: PatternRef[];
    }
  | {
      action: "trash";
      operationId: string;
      patterns: PatternRef[];
    };

export type PatternBatchResult = { patterns: PatternItem[] };

type RestorePatternsResult = {
  state: "restored";
  patterns: Array<
    Pick<PatternItem, "id" | "folderId" | "status" | "version" | "changeSeq" | "updatedAt">
  >;
};

type PatternListSnapshot = [
  queryKey: QueryKey,
  data: InfiniteData<PatternPage, string | null> | undefined,
];

type PatternDetailSnapshot = [
  queryKey: QueryKey,
  data: PatternItem | undefined,
];

type OptimisticContext = {
  details: PatternDetailSnapshot[];
  lists: PatternListSnapshot[];
};

const patternListPrefix = (ownerId: string) =>
  ["owner", ownerId, "patterns"] as const;

export function createPatternBatchIntent(
  input: PatternBatchInput,
): PatternBatchIntent {
  const patterns = input.patterns.map(({ id, version }) => ({ id, version }));
  const operationId = crypto.randomUUID();
  if (input.action === "move") {
    return { action: input.action, folderId: input.folderId, operationId, patterns };
  }
  if (input.action === "favorite") {
    return {
      action: input.action,
      isFavorite: input.isFavorite,
      operationId,
      patterns,
    };
  }
  return { action: input.action, operationId, patterns };
}

export async function sendPatternBatch(intent: PatternBatchIntent) {
  return readApiResponse<PatternBatchResult>(
    await fetch("/api/patterns/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intent),
    }),
  );
}

const updatePages = (
  data: InfiniteData<PatternPage, string | null> | undefined,
  update: (item: PatternItem) => PatternItem | null,
) =>
  data
    ? {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.flatMap((item) => {
            const next = update(item);
            return next ? [next] : [];
          }),
        })),
      }
    : data;

function queryFromKey(key: QueryKey): PatternQuery | undefined {
  const query = key[3];
  return typeof query === "object" && query !== null
    ? (query as PatternQuery)
    : undefined;
}

function knownQueryExcludes(query: PatternQuery | undefined, item: PatternItem) {
  if (!query) return false;
  if (query.scope === "library" && item.status === "trashed") return true;
  if (query.favorite === true && !item.isFavorite) return true;
  if (query.unfiled === true && item.folderId !== null) return true;
  if (
    query.folderId !== undefined &&
    query.includeDescendants === false &&
    item.folderId !== query.folderId
  ) {
    return true;
  }
  return false;
}

function applyOptimisticIntent(
  item: PatternItem,
  intent: PatternBatchIntent,
): PatternItem {
  if (intent.action === "move") return { ...item, folderId: intent.folderId };
  if (intent.action === "favorite") {
    return { ...item, isFavorite: intent.isFavorite };
  }
  return item;
}

function applyIntentToLists(
  queryClient: QueryClient,
  ownerId: string,
  intent: PatternBatchIntent,
) {
  const selected = new Set(intent.patterns.map((pattern) => pattern.id));
  for (const [key] of queryClient.getQueriesData({
    queryKey: patternListPrefix(ownerId),
  })) {
    queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
      key,
      (data) =>
        updatePages(data, (item) => {
          if (!selected.has(item.id)) return item;
          return applyOptimisticIntent(item, intent);
        }),
    );
  }
}

function applyServerPatterns(
  queryClient: QueryClient,
  ownerId: string,
  patterns: readonly PatternItem[],
) {
  const updated = new Map(patterns.map((pattern) => [pattern.id, pattern]));
  for (const [key] of queryClient.getQueriesData({
    queryKey: patternListPrefix(ownerId),
  })) {
    const query = queryFromKey(key);
    queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
      key,
      (data) =>
        updatePages(data, (item) => {
          const next = updated.get(item.id);
          if (!next) return item;
          return knownQueryExcludes(query, next) ? null : next;
        }),
    );
  }
  for (const pattern of patterns) {
    queryClient.setQueryData(queryKeys.pattern(ownerId, pattern.id), pattern);
  }
}

async function invalidateBatchCaches(
  queryClient: QueryClient,
  ownerId: string,
  patternIds: readonly string[],
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: patternListPrefix(ownerId) }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.folders(ownerId),
      exact: true,
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.trash(ownerId),
      exact: true,
    }),
    ...patternIds.map((patternId) =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.pattern(ownerId, patternId),
        exact: true,
      }),
    ),
  ]);
}

const shouldRetryMutation = (failureCount: number, error: Error) => {
  if (
    error instanceof ApiResponseError &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return false;
  }
  return failureCount < 1;
};

export function usePatternBatchMutation(activeQuery: PatternQuery) {
  const ownerId = useQueryOwnerId();
  const queryClient = useQueryClient();
  const activeListKey = queryKeys.patterns(ownerId, activeQuery);

  const batchMutation = useMutation({
    mutationFn: sendPatternBatch,
    onMutate: async (intent: PatternBatchIntent): Promise<OptimisticContext | undefined> => {
      if (intent.action === "trash") return undefined;
      await Promise.all([
        queryClient.cancelQueries({ queryKey: patternListPrefix(ownerId) }),
        queryClient.cancelQueries({ queryKey: activeListKey, exact: true }),
        ...intent.patterns.map(({ id }) =>
          queryClient.cancelQueries({
            queryKey: queryKeys.pattern(ownerId, id),
            exact: true,
          }),
        ),
      ]);
      const lists = queryClient.getQueriesData<
        InfiniteData<PatternPage, string | null>
      >({ queryKey: patternListPrefix(ownerId) });
      const details = intent.patterns.map(({ id }): PatternDetailSnapshot => {
        const key = queryKeys.pattern(ownerId, id);
        return [key, queryClient.getQueryData<PatternItem>(key)];
      });

      applyIntentToLists(queryClient, ownerId, intent);
      for (const { id } of intent.patterns) {
        queryClient.setQueryData<PatternItem>(
          queryKeys.pattern(ownerId, id),
          (item) => (item ? applyOptimisticIntent(item, intent) : item),
        );
      }
      return { details, lists };
    },
    onError: (_error, _intent, context) => {
      for (const [key, data] of context?.lists ?? []) {
        queryClient.setQueryData(key, data);
      }
      for (const [key, data] of context?.details ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSuccess: async (result) => {
      applyServerPatterns(queryClient, ownerId, result.patterns);
      const succeededIds = result.patterns.map((pattern) => pattern.id);
      useSelectionStore.getState().removeSelected(succeededIds);
      await invalidateBatchCaches(queryClient, ownerId, succeededIds);
    },
    retry: shouldRetryMutation,
    retryDelay: 0,
  });

  const restoreMutation = useMutation({
    mutationFn: async (input: { operationId: string; patternIds: string[] }) =>
      readApiResponse<RestorePatternsResult>(
        await fetch("/api/trash/patterns/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      ),
    onSuccess: async (result) => {
      await invalidateBatchCaches(
        queryClient,
        ownerId,
        result.patterns.map((pattern) => pattern.id),
      );
    },
    retry: shouldRetryMutation,
    retryDelay: 0,
  });

  const mutateBatchAsync = (input: PatternBatchInput) => {
    const activeList = queryClient.getQueryData<
      InfiniteData<PatternPage, string | null>
    >(activeListKey);
    const activeVersions = new Map(
      activeList?.pages.flatMap((page) =>
        page.items.map((item) => [item.id, item.version] as const),
      ) ?? [],
    );
    const patterns = input.patterns.map((pattern) => {
      const detailVersion = queryClient.getQueryData<PatternItem>(
        queryKeys.pattern(ownerId, pattern.id),
      )?.version;
      return {
        ...pattern,
        version: Math.max(
          pattern.version,
          activeVersions.get(pattern.id) ?? pattern.version,
          detailVersion ?? pattern.version,
        ),
      };
    });
    const currentInput: PatternBatchInput = { ...input, patterns };
    return batchMutation.mutateAsync(createPatternBatchIntent(currentInput));
  };

  return {
    error: batchMutation.error ?? restoreMutation.error,
    isPending: batchMutation.isPending || restoreMutation.isPending,
    mutateBatch: (input: PatternBatchInput) => {
      void mutateBatchAsync(input).catch(() => undefined);
    },
    mutateBatchAsync,
    restorePatternsAsync: (patternIds: string[]) =>
      restoreMutation.mutateAsync({
        operationId: crypto.randomUUID(),
        patternIds,
      }),
    reset: () => {
      batchMutation.reset();
      restoreMutation.reset();
    },
  };
}
