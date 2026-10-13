"use client";

import {
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  useMutation,
  useIsMutating,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

import type { PatternQuery } from "@/features/patterns/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { ApiResponseError, readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import type { PatternItem, PatternPage } from "./library-types";
import { useSelectionStore } from "./selection-store";
import { usePatternWriteQueue } from "./pattern-write-coordinator";

type PatternRef = Pick<PatternItem, "id" | "version">;
type PatternIntentRef = PatternRef & {
  sourceFolderId: PatternItem["folderId"];
};

const patternStatuses = [
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
  "trashed",
  "deleting",
  "deleted",
] as const;
const restorablePatternStatuses = [
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
] as const;
const previewStatuses = [
  "pending",
  "ready",
  "unsupported",
  "failed",
  "manual",
] as const;
const patternItemSchema = z
  .object({
    id: normalizedUuidSchema,
    ownerId: normalizedUuidSchema,
    name: z.string(),
    originalFilename: z.string(),
    extension: z.string(),
    detectedMimeType: z.string().nullable(),
    sizeBytes: z.string().regex(/^(0|[1-9]\d*)$/),
    contentHash: z.string().nullable(),
    status: z.enum(patternStatuses),
    folderId: normalizedUuidSchema.nullable(),
    trashBatchId: normalizedUuidSchema.nullable(),
    preTrashStatus: z.enum(patternStatuses).nullable(),
    previewStatus: z.enum(previewStatuses),
    previewAssetId: normalizedUuidSchema.nullable(),
    thumbnailAssetId: normalizedUuidSchema.nullable(),
    sourceAssetId: normalizedUuidSchema.nullable(),
    isFavorite: z.boolean(),
    version: z.number().int().nonnegative(),
    commercialVersion: z.number().int().nonnegative(),
    lastErrorCode: z.string().nullable(),
    trashedAt: z.string().datetime().nullable(),
    deletedAt: z.string().datetime().nullable(),
    changeSeq: z.string().regex(/^(0|[1-9]\d*)$/),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
const patternBatchResultSchema = z
  .object({ patterns: z.array(patternItemSchema).min(1).max(100) })
  .strict();
const restoredPatternSchema = z
  .object({
    id: normalizedUuidSchema,
    status: z.enum(restorablePatternStatuses),
    folderId: normalizedUuidSchema.nullable(),
    version: z.number().int().nonnegative(),
    changeSeq: z.string().regex(/^(0|[1-9]\d*)$/),
    updatedAt: z.string().datetime(),
  })
  .strict();
const restorePatternsResultSchema = z
  .object({
    state: z.literal("restored"),
    patterns: z.array(restoredPatternSchema).min(1).max(100),
  })
  .strict();

export type PatternBatchInput =
  | { action: "move"; folderId: string | null; patterns: PatternItem[] }
  | { action: "favorite"; isFavorite: boolean; patterns: PatternItem[] }
  | { action: "trash"; patterns: PatternItem[] };

export type PatternBatchIntent =
  | {
      action: "move";
      folderId: string | null;
      operationId: string;
      patterns: PatternIntentRef[];
    }
  | {
      action: "favorite";
      isFavorite: boolean;
      operationId: string;
      patterns: PatternIntentRef[];
    }
  | {
      action: "trash";
      operationId: string;
      patterns: PatternIntentRef[];
    };

type PatternBatchRequest =
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

export type PatternBatchResult = z.infer<typeof patternBatchResultSchema>;

type RestorePatternsResult = z.infer<typeof restorePatternsResultSchema>;

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

export class InvalidApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiResponseError";
  }
}

function hasExactIds(
  actualIds: readonly string[],
  expectedIds: readonly string[],
) {
  const actual = new Set(actualIds);
  return (
    actual.size === actualIds.length &&
    actualIds.length === expectedIds.length &&
    expectedIds.every((id) => actual.has(id))
  );
}

function parsePatternBatchResult(
  value: unknown,
  intent: PatternBatchIntent,
  ownerId: string,
): PatternBatchResult {
  const parsed = patternBatchResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidApiResponseError("Invalid pattern batch response");
  }
  const expectedIds = intent.patterns.map((pattern) => pattern.id);
  if (
    !hasExactIds(
      parsed.data.patterns.map((pattern) => pattern.id),
      expectedIds,
    ) ||
    parsed.data.patterns.some((pattern) => pattern.ownerId !== ownerId)
  ) {
    throw new InvalidApiResponseError(
      "Pattern batch response IDs do not match",
    );
  }
  const refs = new Map(
    intent.patterns.map((pattern) => [pattern.id, pattern] as const),
  );
  const invalidActionResult = parsed.data.patterns.some((pattern) => {
    const ref = refs.get(pattern.id);
    if (!ref) return true;
    const isLiveResult =
      (pattern.status === "ready" || pattern.status === "failed") &&
      pattern.preTrashStatus === null &&
      pattern.trashBatchId === null &&
      pattern.trashedAt === null &&
      pattern.deletedAt === null;
    if (intent.action === "move") {
      const expectedVersion =
        ref.sourceFolderId === intent.folderId ? ref.version : ref.version + 1;
      return (
        !isLiveResult ||
        pattern.folderId !== intent.folderId ||
        pattern.version !== expectedVersion
      );
    }
    if (intent.action === "favorite") {
      return (
        !isLiveResult ||
        pattern.isFavorite !== intent.isFavorite ||
        pattern.version !== ref.version + 1
      );
    }
    return (
      pattern.status !== "trashed" ||
      (pattern.preTrashStatus !== "ready" &&
        pattern.preTrashStatus !== "failed") ||
      pattern.trashBatchId !== intent.operationId ||
      pattern.trashedAt === null ||
      pattern.deletedAt !== null ||
      pattern.version !== ref.version + 1
    );
  });
  if (invalidActionResult) {
    throw new InvalidApiResponseError(
      "Pattern batch response action does not match",
    );
  }
  return parsed.data;
}

function parseRestorePatternsResult(
  value: unknown,
  patternIds: readonly string[],
): RestorePatternsResult {
  const parsed = restorePatternsResultSchema.safeParse(value);
  if (
    !parsed.success ||
    !hasExactIds(
      parsed.data.patterns.map((pattern) => pattern.id),
      patternIds,
    )
  ) {
    throw new InvalidApiResponseError("Invalid pattern restore response");
  }
  return parsed.data;
}

export function createPatternBatchIntent(
  input: PatternBatchInput,
): PatternBatchIntent {
  const patterns = input.patterns.map(({ id, version, folderId }) => ({
    id,
    version,
    sourceFolderId: folderId,
  }));
  const operationId = crypto.randomUUID();
  if (input.action === "move") {
    return {
      action: input.action,
      folderId: input.folderId,
      operationId,
      patterns,
    };
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

function toPatternBatchRequest(
  intent: PatternBatchIntent,
): PatternBatchRequest {
  const patterns = intent.patterns.map(({ id, version }) => ({ id, version }));
  if (intent.action === "move") {
    return {
      action: intent.action,
      folderId: intent.folderId,
      operationId: intent.operationId,
      patterns,
    };
  }
  if (intent.action === "favorite") {
    return {
      action: intent.action,
      isFavorite: intent.isFavorite,
      operationId: intent.operationId,
      patterns,
    };
  }
  return {
    action: intent.action,
    operationId: intent.operationId,
    patterns,
  };
}

export async function sendPatternBatch(
  intent: PatternBatchIntent,
  ownerId: string,
) {
  const response = await readApiResponse<unknown>(
    await fetch("/api/patterns/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toPatternBatchRequest(intent)),
    }),
  );
  return parsePatternBatchResult(response, intent, ownerId);
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

function knownQueryExcludes(
  query: PatternQuery | undefined,
  item: PatternItem,
) {
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

function rollbackOptimisticItem(
  current: PatternItem,
  before: PatternItem | undefined,
  intent: PatternBatchIntent,
) {
  if (!before || current.version !== before.version) return current;
  if (intent.action === "move") {
    return current.folderId === intent.folderId
      ? { ...current, folderId: before.folderId }
      : current;
  }
  if (intent.action === "favorite") {
    return current.isFavorite === intent.isFavorite
      ? { ...current, isFavorite: before.isFavorite }
      : current;
  }
  return current;
}

function rollbackOptimisticIntent(
  queryClient: QueryClient,
  intent: PatternBatchIntent,
  context: OptimisticContext | undefined,
) {
  if (!context || intent.action === "trash") return;
  const selected = new Set(intent.patterns.map((pattern) => pattern.id));
  for (const [key, beforeData] of context.lists) {
    const currentData =
      queryClient.getQueryData<InfiniteData<PatternPage, string | null>>(key);
    if (!beforeData || !currentData) continue;
    const beforeById = new Map(
      beforeData.pages.flatMap((page) =>
        page.items.map((item) => [item.id, item] as const),
      ),
    );
    queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
      key,
      updatePages(currentData, (item) =>
        selected.has(item.id)
          ? rollbackOptimisticItem(item, beforeById.get(item.id), intent)
          : item,
      ),
    );
  }
  for (const [key, before] of context.details) {
    const current = queryClient.getQueryData<PatternItem>(key);
    if (!current) continue;
    queryClient.setQueryData(
      key,
      rollbackOptimisticItem(current, before, intent),
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

function selectCurrentPattern(
  input: PatternItem,
  active: PatternItem | undefined,
  detail: PatternItem | undefined,
) {
  let current = input;
  if (active && active.version >= current.version) current = active;
  if (detail && detail.version >= current.version) current = detail;
  return current;
}

export function usePatternBatchMutation(activeQuery: PatternQuery) {
  const ownerId = useQueryOwnerId();
  const queryClient = useQueryClient();
  const writeQueue = usePatternWriteQueue(queryClient, ownerId);
  const activeListKey = queryKeys.patterns(ownerId, activeQuery);
  const mutationKey = ["owner", ownerId, "pattern-batch"] as const;
  const sharedPending = useIsMutating({ mutationKey }) > 0;

  const batchMutation = useMutation({
    mutationKey,
    mutationFn: (intent: PatternBatchIntent) =>
      sendPatternBatch(intent, ownerId),
    onMutate: async (
      intent: PatternBatchIntent,
    ): Promise<OptimisticContext | undefined> => {
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
    onError: async (_error, intent, context) => {
      rollbackOptimisticIntent(queryClient, intent, context);
      await invalidateBatchCaches(
        queryClient,
        ownerId,
        intent.patterns.map((pattern) => pattern.id),
      );
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
    mutationFn: async (input: {
      operationId: string;
      patternIds: string[];
    }) => {
      const response = await readApiResponse<unknown>(
        await fetch("/api/trash/patterns/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      return parseRestorePatternsResult(response, input.patternIds);
    },
    onSuccess: async (_result, input) => {
      await invalidateBatchCaches(queryClient, ownerId, input.patternIds);
    },
    onError: async (_error, input) => {
      await invalidateBatchCaches(queryClient, ownerId, input.patternIds);
    },
    retry: shouldRetryMutation,
    retryDelay: 0,
  });

  const mutateBatchAsync = (input: PatternBatchInput) => {
    const intent = createPatternBatchIntent(input);
    return writeQueue.enqueue(
      input.patterns.map((pattern) => pattern.id),
      () => {
        const activeList =
          queryClient.getQueryData<InfiniteData<PatternPage, string | null>>(
            activeListKey,
          );
        const activePatterns = new Map(
          activeList?.pages.flatMap((page) =>
            page.items.map((item) => [item.id, item] as const),
          ) ?? [],
        );
        const patterns = input.patterns.map((pattern) =>
          selectCurrentPattern(
            pattern,
            activePatterns.get(pattern.id),
            queryClient.getQueryData<PatternItem>(
              queryKeys.pattern(ownerId, pattern.id),
            ),
          ),
        );
        if (
          patterns.length === 0 ||
          patterns.length > 100 ||
          new Set(patterns.map((pattern) => pattern.id)).size !==
            patterns.length ||
          patterns.some(
            (pattern) =>
              pattern.ownerId !== ownerId ||
              (pattern.status !== "ready" && pattern.status !== "failed"),
          )
        ) {
          return Promise.reject(new Error("选择已变化，请刷新后重新选择"));
        }
        return batchMutation.mutateAsync({
          ...intent,
          patterns: patterns.map(({ id, version, folderId }) => ({
            id,
            version,
            sourceFolderId: folderId,
          })),
        });
      },
    );
  };

  return {
    error: batchMutation.error ?? restoreMutation.error,
    isPending:
      writeQueue.isPending ||
      sharedPending ||
      batchMutation.isPending ||
      restoreMutation.isPending,
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
