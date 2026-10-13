"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ZodError } from "zod";
import { ApiResponseError, readApiResponse } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";
import {
  patternRestoreMutationSchema,
  folderBatchRestoreMutationSchema,
} from "./contracts";
import {
  purgeResultSchema,
  restoredFolderSchema,
  restoredPatternsSchema,
  trashListSchema,
} from "./trash-types";

class InvalidTrashResponse extends Error {}
class InvalidTrashInput extends Error {}
function validateInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new InvalidTrashInput("请求参数无效", { cause });
  }
}
const post = async (path: string, body: unknown) =>
  readApiResponse<unknown>(
    await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const exactIds = (actual: string[], expected: string[]) =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  expected.every((id) => actual.includes(id));
export async function restorePatterns(
  operationId: string,
  patternIds: string[],
) {
  const body = validateInput(() =>
    patternRestoreMutationSchema.parse({ operationId, patternIds }),
  );
  const result = restoredPatternsSchema.parse(
    await post("/api/trash/patterns/restore", body),
  );
  if (
    !exactIds(
      result.patterns.map((p) => p.id),
      body.patternIds,
    )
  )
    throw new InvalidTrashResponse("恢复结果无效");
  return result;
}
export async function purgePatterns(operationId: string, patternIds: string[]) {
  const body = validateInput(() =>
    patternRestoreMutationSchema.parse({ operationId, patternIds }),
  );
  const result = purgeResultSchema.parse(
    await post("/api/trash/patterns/purge", body),
  );
  if (
    result.deletedPatternCount !== body.patternIds.length ||
    result.deletedFolderCount !== 0
  )
    throw new InvalidTrashResponse("删除结果无效");
  return result;
}
export async function restoreFolderBatch(
  operationId: string,
  trashBatchId: string,
) {
  const batchId = validateInput(() =>
    trashListSchema.shape.folderBatches.element.shape.trashBatchId.parse(
      trashBatchId,
    ),
  );
  const body = validateInput(() =>
    folderBatchRestoreMutationSchema.parse({ operationId }),
  );
  const result = restoredFolderSchema.parse(
    await post(`/api/trash/folder-batches/${batchId}/restore`, body),
  );
  if (result.trashBatchId !== batchId)
    throw new InvalidTrashResponse("恢复批次无效");
  return result;
}
export async function purgeFolderBatch(
  operationId: string,
  trashBatchId: string,
) {
  const batchId = validateInput(() =>
    trashListSchema.shape.folderBatches.element.shape.trashBatchId.parse(
      trashBatchId,
    ),
  );
  const body = validateInput(() =>
    folderBatchRestoreMutationSchema.parse({ operationId }),
  );
  const result = purgeResultSchema.parse(
    await post(`/api/trash/folder-batches/${batchId}/purge`, body),
  );
  if (result.deletedFolderCount < 1)
    throw new InvalidTrashResponse("删除批次无效");
  return result;
}
export function useTrashQuery() {
  const ownerId = useQueryOwnerId();
  return useQuery({
    queryKey: queryKeys.trash(ownerId),
    queryFn: async () =>
      trashListSchema.parse(await readApiResponse(await fetch("/api/trash"))),
    refetchInterval: (query) =>
      query.state.data &&
      [
        ...query.state.data.folderBatches,
        ...query.state.data.patternBatches,
      ].some(
        (batch) =>
          batch.state === "deleting" &&
          batch.lastErrorCode !== "OSS_DELETE_FAILED",
      )
        ? 3000
        : false,
  });
}
export type TrashIntent = {
  action: "restore" | "purge";
  operationId: string;
} & (
  | { kind: "patterns"; patternIds: string[] }
  | {
      kind: "folder";
      trashBatchId: string;
      rootFolderId: string;
      folderCount: number;
      patternCount: number;
    }
);
export function useTrashMutation() {
  const ownerId = useQueryOwnerId();
  const client = useQueryClient();
  const invalidate = (intent: TrashIntent) =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.trash(ownerId) }),
      client.invalidateQueries({ queryKey: queryKeys.folders(ownerId) }),
      client.invalidateQueries({ queryKey: ["owner", ownerId, "patterns"] }),
      ...(intent.kind === "patterns"
        ? intent.patternIds.map((id) =>
            client.invalidateQueries({
              queryKey: queryKeys.pattern(ownerId, id),
            }),
          )
        : [
            client.invalidateQueries({
              queryKey: ["owner", ownerId, "pattern"],
            }),
          ]),
    ]);
  return useMutation({
    mutationFn: async (intent: TrashIntent) => {
      if (intent.kind === "patterns")
        return intent.action === "restore"
          ? restorePatterns(intent.operationId, intent.patternIds)
          : purgePatterns(intent.operationId, intent.patternIds);
      if (intent.action === "restore") {
        const result = await restoreFolderBatch(
          intent.operationId,
          intent.trashBatchId,
        );
        if (
          result.rootFolderId !== intent.rootFolderId ||
          result.folderCount !== intent.folderCount ||
          result.patternCount !== intent.patternCount
        )
          throw new InvalidTrashResponse("恢复数量无效");
        return result;
      }
      const result = await purgeFolderBatch(
        intent.operationId,
        intent.trashBatchId,
      );
      if (
        result.deletedFolderCount !== intent.folderCount ||
        result.deletedPatternCount !== intent.patternCount
      )
        throw new InvalidTrashResponse("删除数量无效");
      return result;
    },
    onSuccess: async (_data, intent) => {
      await invalidate(intent);
    },
    onError: async (error, intent) => {
      if (!(error instanceof InvalidTrashInput)) await invalidate(intent);
    },
    retry: (count, error) =>
      count < 1 &&
      !(error instanceof InvalidTrashInput) &&
      !(error instanceof ZodError) &&
      !(error instanceof InvalidTrashResponse) &&
      !(error instanceof ApiResponseError),
    retryDelay: 0,
  });
}
