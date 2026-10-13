"use client";

import {
  type InfiniteData,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import type { PatternPatch, PatternQuery } from "@/features/patterns/contracts";
import { readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

import type { PatternItem, PatternPage } from "./library-types";
import { usePatternWriteQueue } from "./pattern-write-coordinator";

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

const applyPatch = (pattern: PatternItem, patch: PatternPatch) => ({
  ...pattern,
  ...(patch.name === undefined ? {} : { name: patch.name }),
  ...(patch.isFavorite === undefined ? {} : { isFavorite: patch.isFavorite }),
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
  const ownerId = useQueryOwnerId();
  const writeQueue = usePatternWriteQueue(queryClient, ownerId);
  const listKey = queryKeys.patterns(ownerId, activeQuery);
  const mutation = useMutation({
    mutationFn: sendPatternPatch,
    onMutate: async (intent: PatternPatchIntent) => {
      const detailKey = queryKeys.pattern(ownerId, intent.patternId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
        queryClient.cancelQueries({ queryKey: listKey, exact: true }),
      ]);
      const previousDetail = queryClient.getQueryData<PatternItem>(detailKey);
      const previousList =
        queryClient.getQueryData<InfiniteData<PatternPage, string | null>>(
          listKey,
        );
      const previousListItem = previousList?.pages
        .flatMap((page) => page.items)
        .find((item) => item.id === intent.patternId);

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
        previousListItem,
      };
    },
    onError: (_error, intent, context) => {
      if (!context) return;
      queryClient.setQueryData(context.detailKey, context.previousDetail);
      if (context.previousListItem) {
        queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
          listKey,
          (value) =>
            updatePatternInPages(
              value,
              intent.patternId,
              () => context.previousListItem!,
            ),
        );
      }
    },
    onSuccess: (updated, intent) => {
      queryClient.setQueryData(
        queryKeys.pattern(ownerId, intent.patternId),
        updated,
      );
      queryClient.setQueryData<InfiniteData<PatternPage, string | null>>(
        listKey,
        (value) => updatePatternInPages(value, intent.patternId, () => updated),
      );
    },
    onSettled: (_data, _error, intent) => {
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.pattern(ownerId, intent.patternId),
          exact: true,
        }),
        queryClient.invalidateQueries({ queryKey: listKey, exact: true }),
      ]);
    },
    retry: 0,
  });

  const enqueue = (input: { patternId: string; patch: PatternPatch }) => {
    const intent = createPatternPatchIntent(input);
    return writeQueue.enqueue([input.patternId], () => {
      const currentDetail = queryClient.getQueryData<PatternItem>(
        queryKeys.pattern(ownerId, input.patternId),
      );
      const currentList =
        queryClient.getQueryData<InfiniteData<PatternPage, string | null>>(
          listKey,
        );
      const currentListItem = currentList?.pages
        .flatMap((page) => page.items)
        .find((item) => item.id === input.patternId);
      return mutation.mutateAsync({
        ...intent,
        patch: {
          ...intent.patch,
          version: Math.max(
            currentDetail?.version ?? -1,
            currentListItem?.version ?? -1,
            intent.patch.version,
          ),
        },
      });
    });
  };

  return {
    ...mutation,
    isPending: writeQueue.isPending || mutation.isPending,
    mutatePattern: (input: { patternId: string; patch: PatternPatch }) => {
      void enqueue(input).catch(() => undefined);
    },
    mutatePatternAsync: enqueue,
  };
}
