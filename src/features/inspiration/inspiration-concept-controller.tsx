"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createConceptSetRequest,
  deleteConceptSetRequest,
  fetchConceptSets,
  regenerateConceptSetRequest,
  retryConceptOutputRequest,
} from "@/features/inspiration-concepts/api";
import type {
  ConceptSetCreateMutation,
  ConceptSetDto,
} from "@/features/inspiration-concepts/contracts";
import { inspirationConceptKeys } from "@/features/inspiration-concepts/query-keys";
import { inspirationVisualKeys } from "@/features/inspiration-visuals/query-keys";
import { useQueryOwnerId } from "@/lib/query/provider";
import { hasActiveConceptTask } from "./inspiration-concept-section";

export type InspirationConceptControls = {
  sets: ConceptSetDto[];
  available: boolean;
  pending: boolean;
  error: string | null;
  onCreate: (input: ConceptSetCreateMutation) => Promise<void>;
  onRetry: (setId: string, kind: "effect" | "flat") => void;
  onRegenerate: (setId: string) => void;
  onDelete: (setId: string) => void;
  onReload: () => void;
};
type Operation =
  | { type: "create"; input: ConceptSetCreateMutation }
  | {
      type: "retry";
      setId: string;
      kind: "effect" | "flat";
      operationId: string;
    }
  | { type: "regenerate"; setId: string; operationId: string }
  | { type: "delete"; setId: string };

export function InspirationConceptController({
  analysisId,
  available,
  initialSets,
  children,
}: {
  analysisId: string;
  available: boolean;
  initialSets: ConceptSetDto[];
  children: (controls: InspirationConceptControls) => ReactNode;
}) {
  const ownerId = useQueryOwnerId();
  const client = useQueryClient();
  const key = inspirationConceptKeys.analysis(ownerId, analysisId);
  const mutationKey = [...key, "mutation"];
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchConceptSets(analysisId, signal),
    enabled: available || initialSets.length > 0,
    refetchInterval: ({ state }) =>
      hasActiveConceptTask(state.data) ? 3_000 : false,
  });
  useEffect(
    () => () => {
      void client.cancelQueries({
        queryKey: inspirationConceptKeys.analysis(ownerId, analysisId),
        exact: true,
      });
    },
    [client, ownerId, analysisId],
  );
  const mutation = useMutation({
    mutationKey,
    mutationFn: async (operation: Operation) => {
      switch (operation.type) {
        case "create":
          return createConceptSetRequest(analysisId, operation.input);
        case "retry":
          return retryConceptOutputRequest(
            analysisId,
            operation.setId,
            operation.kind,
            { operationId: operation.operationId },
          );
        case "regenerate":
          return regenerateConceptSetRequest(analysisId, operation.setId, {
            operationId: operation.operationId,
          });
        case "delete":
          return deleteConceptSetRequest(analysisId, operation.setId);
      }
    },
    onMutate: async (operation) => {
      setError(null);
      if (operation.type !== "delete") return;
      await client.cancelQueries({ queryKey: key, exact: true });
      const previous = client.getQueryData<ConceptSetDto[]>(key) ?? initialSets;
      client.setQueryData(
        key,
        previous.filter(({ id }) => id !== operation.setId),
      );
      return { deleted: previous.find(({ id }) => id === operation.setId) };
    },
    onSuccess: (set) => {
      if (set)
        client.setQueryData<ConceptSetDto[]>(key, (current) => [
          set,
          ...(current ?? initialSets).filter(({ id }) => id !== set.id),
        ]);
    },
    onError: (_failure, _operation, context) => {
      if (context?.deleted) {
        const deleted = context.deleted;
        client.setQueryData<ConceptSetDto[]>(key, (current) => [
          deleted,
          ...(current ?? []).filter(({ id }) => id !== deleted.id),
        ]);
      }
      setError("成图操作失败，请重试");
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({
          queryKey: inspirationVisualKeys.detail(ownerId, analysisId),
        }),
      ]);
    },
  });
  async function run(operation: Operation) {
    // Synchronous guard covers double clicks before React commits disabled controls.
    if (client.isMutating({ mutationKey }) > 0) return;
    await mutation.mutateAsync(operation);
  }
  function runAction(operation: Operation) {
    void run(operation).catch(() => {});
  }
  return children({
    sets: query.data ?? initialSets,
    available,
    pending: mutation.isPending,
    error: error ?? (query.isError ? "成图加载失败，请稍后重试" : null),
    onCreate: (input) => run({ type: "create", input }),
    onRetry: (setId, kind) =>
      runAction({
        type: "retry",
        setId,
        kind,
        operationId: crypto.randomUUID(),
      }),
    onRegenerate: (setId) =>
      runAction({
        type: "regenerate",
        setId,
        operationId: crypto.randomUUID(),
      }),
    onDelete: (setId) => runAction({ type: "delete", setId }),
    onReload: () => {
      setError(null);
      void query.refetch();
    },
  });
}
