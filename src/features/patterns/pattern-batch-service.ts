import "server-only";

import { z } from "zod";

import { lockFolderRow } from "@/features/folders/folder-repository";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { nextChangeSeq } from "@/lib/db/change-seq";
import { db } from "@/lib/db/client";
import {
  changeLog,
  patternStatuses,
  previewStatuses,
} from "@/lib/db/schema";
import {
  claimOperation,
  createOperationKey,
  storeOperationResult,
} from "@/lib/db/operation";
import { AppError } from "@/lib/http/app-error";

import {
  parsePatternBatchMutation,
  type PatternBatchMutation,
  type PatternBatchMutationInput,
  type PatternRef,
} from "./batch-contracts";
import {
  listPatternBatchRows,
  lockPatternRows,
  updatePatternRows,
  type PatternBatchRowWithAssets,
} from "./pattern-batch-repository";

const editablePatternStatuses = new Set(["ready", "failed"] as const);
const optionalNullableUuidSchema = normalizedUuidSchema
  .nullish()
  .transform((value) => value ?? null);
const patternStatusSchema = z.enum(patternStatuses);
const replayPatternDtoSchema = z.object({
  id: normalizedUuidSchema,
  ownerId: normalizedUuidSchema,
  name: z.string(),
  originalFilename: z.string(),
  extension: z.string(),
  detectedMimeType: z.string().nullable(),
  sizeBytes: z.string().regex(/^(0|[1-9]\d*)$/),
  contentHash: z.string().nullable(),
  status: patternStatusSchema,
  folderId: optionalNullableUuidSchema,
  trashBatchId: optionalNullableUuidSchema,
  preTrashStatus: patternStatusSchema
    .nullish()
    .transform((value) => value ?? null),
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
});
const replayPatternBatchResultSchema = z.object({
  patterns: z.array(replayPatternDtoSchema).min(1).max(100),
});

function toPatternDto(row: PatternBatchRowWithAssets) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    originalFilename: row.originalFilename,
    extension: row.extension,
    detectedMimeType: row.detectedMimeType,
    sizeBytes: row.sizeBytes.toString(),
    contentHash: row.contentHash,
    status: row.status,
    folderId: row.folderId,
    trashBatchId: row.trashBatchId,
    preTrashStatus: row.preTrashStatus,
    previewStatus: row.previewStatus,
    previewAssetId: row.previewAssetId,
    thumbnailAssetId: row.thumbnailAssetId,
    sourceAssetId: row.sourceAssetId,
    isFavorite: row.isFavorite,
    version: row.version,
    commercialVersion: row.commercialVersion,
    lastErrorCode: row.lastErrorCode,
    trashedAt: row.trashedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    changeSeq: row.changeSeq.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type PatternBatchResult = {
  patterns: ReturnType<typeof toPatternDto>[];
};

function internalReplayError(): never {
  throw new AppError(
    "INTERNAL_ERROR",
    500,
    "Stored pattern batch operation result is invalid",
  );
}

function normalizeReplayResult(
  result: unknown,
  ownerId: string,
  sortedRefs: readonly PatternRef[],
): PatternBatchResult {
  const parsed = replayPatternBatchResultSchema.safeParse(result);
  if (!parsed.success || parsed.data.patterns.length !== sortedRefs.length) {
    internalReplayError();
  }

  for (let index = 0; index < sortedRefs.length; index += 1) {
    const pattern = parsed.data.patterns[index];
    const ref = sortedRefs[index];
    if (!pattern || !ref || pattern.ownerId !== ownerId || pattern.id !== ref.id) {
      internalReplayError();
    }
  }

  return parsed.data;
}

function patternNotFound(): never {
  throw new AppError("NOT_FOUND", 404, "Pattern not found");
}

function patternStateChanged(): never {
  throw new AppError("PATTERN_STATE_CHANGED", 409, "Pattern state changed");
}

function operationIdReused(): never {
  throw new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used",
  );
}

function folderNotFound(): never {
  throw new AppError("FOLDER_NOT_FOUND", 404, "Folder not found");
}

function folderNotActive(): never {
  throw new AppError("FOLDER_NOT_ACTIVE", 409, "Folder is not active");
}

function stablePatternRefs(patterns: readonly PatternRef[]) {
  return [...patterns].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function eventName(action: PatternBatchMutation["action"]) {
  if (action === "move") return "patterns.moved";
  if (action === "trash") return "patterns.trashed";
  return "patterns.favorited";
}

export async function batchPatterns(input: {
  ownerId: string;
  mutation: PatternBatchMutationInput;
}) {
  const mutation = parsePatternBatchMutation(input.mutation);
  const sortedRefs = stablePatternRefs(mutation.patterns);
  const patternIds = sortedRefs.map((pattern) => pattern.id);
  const operationPayload =
    mutation.action === "move"
      ? { action: mutation.action, patterns: sortedRefs, folderId: mutation.folderId }
      : mutation.action === "favorite"
        ? {
            action: mutation.action,
            patterns: sortedRefs,
            isFavorite: mutation.isFavorite,
          }
        : { action: mutation.action, patterns: sortedRefs };
  const operationKey = createOperationKey("pattern.batch", operationPayload);

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      mutation.operationId,
      operationKey,
    );
    if (operation.state === "replay") {
      return normalizeReplayResult(
        operation.result,
        input.ownerId,
        sortedRefs,
      );
    }

    const targetFolder =
      mutation.action === "move" && mutation.folderId !== null
        ? await lockFolderRow(input.ownerId, tx, mutation.folderId)
        : undefined;
    const rows = await lockPatternRows(input.ownerId, tx, patternIds);
    if (rows.length !== sortedRefs.length) patternNotFound();
    if (operation.state === "mismatch") operationIdReused();

    for (let index = 0; index < sortedRefs.length; index += 1) {
      const ref = sortedRefs[index];
      const row = rows[index];
      if (!ref || !row || ref.id !== row.id) patternNotFound();
      if (
        row.version !== ref.version ||
        !editablePatternStatuses.has(row.status as "ready" | "failed")
      ) {
        patternStateChanged();
      }
    }

    if (mutation.action === "move" && mutation.folderId !== null) {
      if (!targetFolder) folderNotFound();
      if (targetFolder.status !== "active") folderNotActive();
    }

    const affectedPatternIds =
      mutation.action === "move"
        ? rows
            .filter((row) => row.folderId !== mutation.folderId)
            .map((row) => row.id)
        : patternIds;
    let seq: bigint | undefined;
    let now: Date | undefined;

    if (affectedPatternIds.length > 0) {
      seq = await nextChangeSeq(tx, input.ownerId);
      now = new Date();
      const updated =
        mutation.action === "move"
          ? await updatePatternRows(input.ownerId, tx, {
              action: "move",
              patternIds: affectedPatternIds,
              folderId: mutation.folderId,
              changeSeq: seq,
              updatedAt: now,
            })
          : mutation.action === "favorite"
            ? await updatePatternRows(input.ownerId, tx, {
                action: "favorite",
                patternIds: affectedPatternIds,
                isFavorite: mutation.isFavorite,
                changeSeq: seq,
                updatedAt: now,
              })
            : await updatePatternRows(input.ownerId, tx, {
                action: "trash",
                patternIds: affectedPatternIds,
                trashBatchId: mutation.operationId,
                trashedAt: now,
                changeSeq: seq,
                updatedAt: now,
              });
      if (updated.length !== affectedPatternIds.length) patternStateChanged();
    }

    const freshRows = await listPatternBatchRows(input.ownerId, tx, patternIds);
    if (freshRows.length !== patternIds.length) {
      throw new Error("PATTERN_BATCH_RESULT_MISSING");
    }
    const result: PatternBatchResult = {
      patterns: freshRows.map(toPatternDto),
    };

    if (seq !== undefined && now !== undefined) {
      await tx.insert(changeLog).values({
        ownerId: input.ownerId,
        seq,
        operationId: mutation.operationId,
        entityType: "pattern_batch",
        entityId: mutation.operationId,
        operation: eventName(mutation.action),
        payload: { patternIds: affectedPatternIds },
        createdAt: now,
      });
    }
    await storeOperationResult(
      input.ownerId,
      tx,
      mutation.operationId,
      result,
    );
    return result;
  });
}
