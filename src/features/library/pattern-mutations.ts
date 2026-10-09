"use client";

import {
  type InfiniteData,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import type { PatternPatch, PatternQuery } from "@/features/patterns/contracts";
import { readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";

import type { PatternItem, PatternPage } from "./library-types";

export type PatternPatchIntent = {
  operationId: string;
  patch: PatternPatch;
  patternId: string;
};

export function createPatternPatchIntent(input: {
  patch: PatternPatch;
  patternId: string;
}): PatternPatchIntent {
  return { ...input, operationId: crypto.randomUUID() };
}

export async function sendPatternPatch(intent: PatternPatchIntent) {
  const response = await fetch(`/api/patterns/${intent.patternId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: intent.operationId,
      patch: intent.patch,
    }),
  });
  return readApiResponse<PatternItem>(response);
}

const mutationQueues = new WeakMap<
  QueryClient,
  Map<string, Promise<void>>
>();

function enqueuePatternMutation<T>(
  queryClient: QueryClient,
  patternId: string,
  task: () => Promise<T>,
) {
  const queues = mutationQueues.get(queryClient) ?? new Map<string, Promise<void>>();
  mutationQueues.set(queryClient, queues);
  const previous = queues.get(patternId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(patternId, tail);
  void tail.finally(() => {
    if (queues.get(patternId) === tail) queues.delete(patternId);
  });
  return result;
}

const applyPatch = (pattern: PatternItem, patch: PatternPatch) => ({
  ...pattern,
  ...(patch.name === undefined ? {} : { name: patch.name }),
  ...(patch.isFavorite === undefined
    ? {}
    : { isFavorite: patch.isFavorite }),
});

const updatePatternInPages = (
  data: InfiniteData<PatternPage, string | null> | undefined,
  patternId: string,
  update: (pattern: PatternItem) => PatternItem,
) =>
  data
    ? {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) =>
            item.id === patternId ? update(item) : item,
          ),
        })),
      }
    : data;

export function usePatternPatchMutation(activeQuery: PatternQuery) {
  const queryClient = useQueryClient();
  const listKey = queryKeys.patterns(activeQuery);
  const mutation = useMutation({
    mutationFn: sendPatternPatch,
    onMutate: async (intent: PatternPatchIntent) => {
      const detailKey = queryKeys.pattern(intent.patternId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
        queryClient.cancelQueries({ queryKey: listKey, exact: true }),
      ]);
      const previousDetail = queryClient.getQueryData<PatternItem>(detailKey);
      const previousList = queryClient.getQueryData<
        InfiniteData<PatternPage, string | null>
      >(listKey);

      queryClient.setQueryData<PatternItem>(detailKey, (value) =>
        value ? applyPatch(value, intent.patch) : value,
      );
      queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
        listKey,
        (value) =>
          updatePatternInPages(value, intent.patternId, (pattern) =>
            applyPatch(pattern, intent.patch),
          ),
      );
      return {
        detailKey,
        previousDetail,
        previousList,
      };
    },
    onError: (_error, _intent, context) => {
      if (!context) return;
      queryClient.setQueryData(context.detailKey, context.previousDetail);
      queryClient.setQueryData(listKey, context.previousList);
    },
    onSuccess: (updated, intent) => {
      queryClient.setQueryData(queryKeys.pattern(intent.patternId), updated);
      queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
        listKey,
        (value) =>
          updatePatternInPages(value, intent.patternId, () => updated),
      );
    },
    onSettled: (_data, _error, intent) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pattern(intent.patternId),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
    },
    retry: 0,
  });

  const enqueue = (input: { patternId: string; patch: PatternPatch }) => {
    const intent = createPatternPatchIntent(input);
    return enqueuePatternMutation(queryClient, input.patternId, () => {
      const currentDetail = queryClient.getQueryData<PatternItem>(
        queryKeys.pattern(input.patternId),
      );
      const currentList = queryClient.getQueryData<
        InfiniteData<PatternPage, string | null>
      >(listKey);
      const currentListItem = currentList?.pages
        .flatMap((page) => page.items)
        .find((item) => item.id === input.patternId);
      return mutation.mutateAsync({
        ...intent,
        patch: {
          ...intent.patch,
          version:
            currentDetail?.version ??
            currentListItem?.version ??
            intent.patch.version,
        },
      });
    });
  };

  return {
    ...mutation,
    mutatePattern: (input: { patternId: string; patch: PatternPatch }) => {
      void enqueue(input).catch(() => undefined);
    },
    mutatePatternAsync: enqueue,
  };
}
