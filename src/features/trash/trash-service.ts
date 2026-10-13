import "server-only";

import { z, ZodError } from "zod";

import { lockFolderHierarchy } from "@/features/folders/folder-repository";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { nextChangeSeq } from "@/lib/db/change-seq";
import { db } from "@/lib/db/client";
import {
  claimOperation,
  createOperationKey,
  storeOperationResult,
} from "@/lib/db/operation";
import { changeLog } from "@/lib/db/schema";
import { AppError, validationError } from "@/lib/http/app-error";

import {
  parseFolderBatchRestoreMutation,
  parsePatternRestoreMutation,
} from "./contracts";
import {
  findNonDeletedFolderBatchIds,
  listFolderStatesById,
  listFolderBatchRows,
  listLiveSubtreeFolderIds,
  listTrashRows,
  lockFolderBatchPatternRows,
  lockFolderRowsById,
  lockTrashPatternRows,
  restoreFolderBatchPatternRows,
  restoreFolderRows,
  restorePatternRows,
  type TrashFolderRow,
  type TrashPatternFolderRow,
  type TrashPatternReadRow,
  type TrashPatternRow,
} from "./trash-repository";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const restorablePatternStatuses = [
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
] as const;
type RestorablePatternStatus = (typeof restorablePatternStatuses)[number];
const restorablePatternStatusSet = new Set<string>(restorablePatternStatuses);

export type TrashState = "trashed" | "deleting";

export type TrashPatternDto = {
  id: string;
  name: string;
  originalFilename: string;
  extension: string;
  sizeBytes: string;
  folderId: string | null;
  status: TrashState;
  previewStatus: TrashPatternReadRow["previewStatus"];
  previewAssetId: string | null;
  thumbnailAssetId: string | null;
  version: number;
  lastErrorCode: string | null;
  trashedAt: string;
};

export type TrashFolderBatchDto = {
  trashBatchId: string;
  rootFolderId: string;
  rootFolderName: string;
  folderCount: number;
  patternCount: number;
  state: TrashState;
  lastErrorCode: string | null;
  purgeOperationId: null;
  trashedAt: string;
  expiresAt: string;
};

export type TrashPatternBatchDto = {
  trashBatchId: string;
  state: TrashState;
  lastErrorCode: string | null;
  purgeOperationId: null;
  trashedAt: string;
  expiresAt: string;
  patterns: TrashPatternDto[];
};

export type TrashListDto = {
  folderBatches: TrashFolderBatchDto[];
  patternBatches: TrashPatternBatchDto[];
};

export type RestoredPatternDto = {
  id: string;
  status: RestorablePatternStatus;
  folderId: string | null;
  version: number;
  changeSeq: string;
  updatedAt: string;
};

export type RestorePatternsResult = {
  state: "restored";
  patterns: RestoredPatternDto[];
};

export type RestoreFolderBatchResult = {
  state: "restored";
  trashBatchId: string;
  rootFolderId: string;
  folderCount: number;
  patternCount: number;
};

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
const restorePatternsReplaySchema = z
  .object({
    state: z.literal("restored"),
    patterns: z.array(restoredPatternSchema).min(1).max(100),
  })
  .strict();
const restoreFolderBatchReplaySchema = z
  .object({
    state: z.literal("restored"),
    trashBatchId: normalizedUuidSchema,
    rootFolderId: normalizedUuidSchema,
    folderCount: z.number().int().positive(),
    patternCount: z.number().int().nonnegative(),
  })
  .strict();

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function internalError(message: string): never {
  throw new AppError("INTERNAL_ERROR", 500, message);
}

function notFound(): never {
  throw new AppError("NOT_FOUND", 404, "Pattern not found");
}

function patternStateChanged(): never {
  throw new AppError("PATTERN_STATE_CHANGED", 409, "Pattern state changed");
}

function folderBatchActionRequired(): never {
  throw new AppError(
    "FOLDER_BATCH_ACTION_REQUIRED",
    409,
    "Folder batch action required",
  );
}

function trashBatchNotFound(): never {
  throw new AppError("TRASH_BATCH_NOT_FOUND", 404, "Trash batch not found");
}

function trashPurgeInProgress(): never {
  throw new AppError(
    "TRASH_PURGE_IN_PROGRESS",
    409,
    "Trash purge is in progress",
  );
}

function folderNotActive(): never {
  throw new AppError("FOLDER_NOT_ACTIVE", 409, "Folder is not active");
}

function operationIdReused(): never {
  throw new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used",
  );
}

function parseOrValidationError<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) throw validationError();
    throw error;
  }
}

function stableErrorCode(rows: readonly TrashPatternRow[]) {
  return rows
    .flatMap((row) => (row.lastErrorCode === null ? [] : [row.lastErrorCode]))
    .sort(compareIds)[0] ?? null;
}

function batchDates(
  rows: readonly { trashedAt: Date | null }[],
): { trashedAt: string; expiresAt: string } {
  if (rows.length === 0 || rows.some((row) => row.trashedAt === null)) {
    internalError("Trash batch timestamps are invalid");
  }
  const timestamps = rows.map((row) => row.trashedAt!.getTime());
  const earliest = Math.min(...timestamps);
  const latest = Math.max(...timestamps);
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) {
    internalError("Trash batch timestamps are invalid");
  }
  return {
    trashedAt: new Date(latest).toISOString(),
    expiresAt: new Date(earliest + RETENTION_MS).toISOString(),
  };
}

function toTrashPatternDto(row: TrashPatternReadRow): TrashPatternDto {
  if (row.trashedAt === null) internalError("Trash pattern timestamp is invalid");
  if (row.status !== "trashed" && row.status !== "deleting") {
    internalError("Trash pattern state is invalid");
  }
  return {
    id: row.id,
    name: row.name,
    originalFilename: row.originalFilename,
    extension: row.extension,
    sizeBytes: row.sizeBytes.toString(),
    folderId: row.folderId,
    status: row.status,
    previewStatus: row.previewStatus,
    previewAssetId: row.previewAssetId,
    thumbnailAssetId: row.thumbnailAssetId,
    version: row.version,
    lastErrorCode: row.lastErrorCode,
    trashedAt: row.trashedAt.toISOString(),
  };
}

function sortBatches<T extends { trashedAt: string; trashBatchId: string }>(
  batches: T[],
) {
  return batches.sort((left, right) => {
    const timestampOrder = right.trashedAt.localeCompare(left.trashedAt);
    return timestampOrder === 0
      ? compareIds(left.trashBatchId, right.trashBatchId)
      : timestampOrder;
  });
}

export async function listTrash(input: { ownerId: string }): Promise<TrashListDto> {
  const rows = await db.transaction(
    (tx) => listTrashRows(input.ownerId, tx),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const foldersByBatch = new Map<string, TrashFolderRow[]>();
  const patternsByBatch = new Map<string, TrashPatternReadRow[]>();

  for (const folder of rows.folders) {
    if (folder.trashBatchId === null) {
      internalError("Trash folder batch identity is invalid");
    }
    const batch = foldersByBatch.get(folder.trashBatchId) ?? [];
    batch.push(folder);
    foldersByBatch.set(folder.trashBatchId, batch);
  }
  const expectedPatternFolderIds = [
    ...new Set(
      rows.patterns.flatMap((pattern) =>
        pattern.folderId === null ? [] : [pattern.folderId],
      ),
    ),
  ].sort(compareIds);
  const patternFoldersById = new Map<string, TrashPatternFolderRow>(
    rows.patternFolders.map((folder) => [folder.id, folder]),
  );
  if (
    rows.patternFolders.length !== expectedPatternFolderIds.length ||
    rows.patternFolders.some(
      (folder, index) => folder.id !== expectedPatternFolderIds[index],
    )
  ) {
    internalError("Trash pattern folder identity is invalid");
  }
  for (const pattern of rows.patterns) {
    if (pattern.trashBatchId === null) {
      internalError("Trash pattern batch identity is invalid");
    }
    if (pattern.folderId !== null) {
      const folder = patternFoldersById.get(pattern.folderId);
      if (!folder) internalError("Trash pattern folder identity is invalid");
      if (
        folder.status !== "active" &&
        (folder.status === "deleted" ||
          folder.trashBatchId === null ||
          folder.trashBatchId !== pattern.trashBatchId ||
          !foldersByBatch
            .get(folder.trashBatchId)
            ?.some((batchFolder) => batchFolder.id === folder.id))
      ) {
        internalError("Trash pattern folder batch is invalid");
      }
    }
    const batch = patternsByBatch.get(pattern.trashBatchId) ?? [];
    batch.push(pattern);
    patternsByBatch.set(pattern.trashBatchId, batch);
  }

  const folderBatches: TrashFolderBatchDto[] = [];
  for (const [trashBatchId, folderRows] of foldersByBatch) {
    if (
      folderRows.some(
        (folder) =>
          folder.status !== "trashed" && folder.status !== "deleting",
      )
    ) {
      internalError("Trash folder batch state is invalid");
    }
    const folderIds = new Set(folderRows.map((folder) => folder.id));
    const roots = folderRows.filter(
      (folder) => folder.parentId === null || !folderIds.has(folder.parentId),
    );
    if (roots.length !== 1) {
      internalError("Trash folder batch hierarchy is invalid");
    }
    const patternRows = patternsByBatch.get(trashBatchId) ?? [];
    const allRows = [...folderRows, ...patternRows];
    folderBatches.push({
      trashBatchId,
      rootFolderId: roots[0]!.id,
      rootFolderName: roots[0]!.name,
      folderCount: folderRows.length,
      patternCount: patternRows.length,
      state: allRows.some((row) => row.status === "deleting")
        ? "deleting"
        : "trashed",
      lastErrorCode: stableErrorCode(patternRows),
      purgeOperationId: null,
      ...batchDates(allRows),
    });
  }

  const patternBatches: TrashPatternBatchDto[] = [];
  for (const [trashBatchId, patternRows] of patternsByBatch) {
    if (foldersByBatch.has(trashBatchId)) continue;
    const orderedPatterns = [...patternRows].sort((left, right) => {
      const leftTime = left.trashedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightTime = right.trashedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      return rightTime === leftTime
        ? compareIds(left.id, right.id)
        : rightTime - leftTime;
    });
    patternBatches.push({
      trashBatchId,
      state: patternRows.some((row) => row.status === "deleting")
        ? "deleting"
        : "trashed",
      lastErrorCode: stableErrorCode(patternRows),
      purgeOperationId: null,
      ...batchDates(patternRows),
      patterns: orderedPatterns.map(toTrashPatternDto),
    });
  }

  return {
    folderBatches: sortBatches(folderBatches),
    patternBatches: sortBatches(patternBatches),
  };
}

function toRestoredPatternDto(row: TrashPatternRow): RestoredPatternDto {
  if (!restorablePatternStatusSet.has(row.status)) {
    internalError("Restored pattern result is invalid");
  }
  return {
    id: row.id,
    status: row.status as RestorablePatternStatus,
    folderId: row.folderId,
    version: row.version,
    changeSeq: row.changeSeq.toString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizePatternReplayResult(
  result: unknown,
  sortedPatternIds: readonly string[],
): RestorePatternsResult {
  const parsed = restorePatternsReplaySchema.safeParse(result);
  if (
    !parsed.success ||
    parsed.data.patterns.length !== sortedPatternIds.length ||
    parsed.data.patterns.some(
      (pattern, index) => pattern.id !== sortedPatternIds[index],
    )
  ) {
    internalError("Stored trash pattern restore result is invalid");
  }
  return parsed.data;
}

function normalizeFolderReplayResult(
  result: unknown,
  trashBatchId: string,
): RestoreFolderBatchResult {
  const parsed = restoreFolderBatchReplaySchema.safeParse(result);
  if (!parsed.success || parsed.data.trashBatchId !== trashBatchId) {
    internalError("Stored folder batch restore result is invalid");
  }
  return parsed.data;
}

function postgresUniqueConstraint(error: unknown) {
  let candidate = error;
  const seen = new Set<unknown>();
  while (
    typeof candidate === "object" &&
    candidate !== null &&
    !seen.has(candidate)
  ) {
    seen.add(candidate);
    if (
      "code" in candidate &&
      candidate.code === "23505" &&
      "constraint_name" in candidate &&
      typeof candidate.constraint_name === "string"
    ) {
      return candidate.constraint_name;
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

function isFolderNameConflict(error: unknown) {
  return [
    "folders_owner_root_name_live_unique",
    "folders_owner_parent_name_live_unique",
  ].includes(postgresUniqueConstraint(error) ?? "");
}

export async function restorePatterns(input: {
  ownerId: string;
  operationId: string;
  patternIds: string[];
}): Promise<RestorePatternsResult> {
  const mutation = parsePatternRestoreMutation({
    operationId: input.operationId,
    patternIds: input.patternIds,
  });
  const patternIds = [...mutation.patternIds].sort(compareIds);
  const operationKey = createOperationKey("trash.patterns.restore", {
    patternIds,
  });

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      mutation.operationId,
      operationKey,
    );
    if (operation.state === "replay") {
      return normalizePatternReplayResult(operation.result, patternIds);
    }

    const rows = await lockTrashPatternRows(input.ownerId, tx, patternIds);
    if (rows.length !== patternIds.length) notFound();
    if (rows.some((row, index) => row.id !== patternIds[index])) notFound();
    if (operation.state === "mismatch") operationIdReused();
    if (rows.some((row) => row.status === "deleting")) {
      trashPurgeInProgress();
    }
    if (rows.some((row) => row.status !== "trashed")) patternStateChanged();
    if (
      rows.some(
        (row) =>
          row.preTrashStatus === null ||
          !restorablePatternStatusSet.has(row.preTrashStatus),
      )
    ) {
      patternStateChanged();
    }
    const batchIds = rows.flatMap((row) =>
      row.trashBatchId === null ? [] : [row.trashBatchId],
    );
    if (batchIds.length !== rows.length) patternStateChanged();
    if (
      (await findNonDeletedFolderBatchIds(input.ownerId, tx, batchIds)).length >
      0
    ) {
      folderBatchActionRequired();
    }
    const folderIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.folderId === null ? [] : [row.folderId],
        ),
      ),
    ].sort(compareIds);
    const folderRows = await listFolderStatesById(input.ownerId, tx, folderIds);
    if (
      folderRows.length !== folderIds.length ||
      folderRows.some(
        (folder, index) =>
          folder.id !== folderIds[index] || folder.status !== "active",
      )
    ) {
      patternStateChanged();
    }

    const seq = await nextChangeSeq(tx, input.ownerId);
    const now = new Date();
    const updated = await restorePatternRows(input.ownerId, tx, {
      ids: patternIds,
      changeSeq: seq,
      now,
    });
    if (updated.length !== patternIds.length) patternStateChanged();
    const result: RestorePatternsResult = {
      state: "restored",
      patterns: updated.map(toRestoredPatternDto),
    };
    await tx.insert(changeLog).values({
      ownerId: input.ownerId,
      seq,
      operationId: mutation.operationId,
      entityType: "pattern_batch",
      entityId: mutation.operationId,
      operation: "patterns.restored",
      payload: { patternIds },
      createdAt: now,
    });
    await storeOperationResult(
      input.ownerId,
      tx,
      mutation.operationId,
      result,
    );
    return result;
  });
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export async function restoreFolderBatch(input: {
  ownerId: string;
  operationId: string;
  trashBatchId: string;
}): Promise<RestoreFolderBatchResult> {
  const mutation = parseFolderBatchRestoreMutation({
    operationId: input.operationId,
  });
  const trashBatchId = parseOrValidationError(() =>
    normalizedUuidSchema.parse(input.trashBatchId),
  );
  const operationKey = createOperationKey("trash.folder-batch.restore", {
    trashBatchId,
  });

  try {
    return await db.transaction(async (tx) => {
      const operation = await claimOperation(
        input.ownerId,
        tx,
        mutation.operationId,
        operationKey,
      );
      if (operation.state === "replay") {
        return normalizeFolderReplayResult(operation.result, trashBatchId);
      }

      await lockFolderHierarchy(input.ownerId, tx);
      const candidates = await listFolderBatchRows(
        input.ownerId,
        tx,
        trashBatchId,
      );
      if (candidates.length === 0) trashBatchNotFound();
      const candidateIds = candidates.map((folder) => folder.id).sort(compareIds);
      const candidateIdSet = new Set(candidateIds);
      const candidateRoots = candidates.filter(
        (folder) =>
          folder.parentId === null || !candidateIdSet.has(folder.parentId),
      );
      if (candidateRoots.length !== 1) trashBatchNotFound();
      const outsideParentId = candidateRoots[0]!.parentId;
      const lockIds = [
        ...new Set(
          outsideParentId === null
            ? candidateIds
            : [...candidateIds, outsideParentId],
        ),
      ].sort(compareIds);
      const lockedFolders = await lockFolderRowsById(
        input.ownerId,
        tx,
        lockIds,
      );
      if (lockedFolders.length !== lockIds.length) folderNotActive();
      const batchFolders = lockedFolders.filter(
        (folder) => folder.trashBatchId === trashBatchId,
      );
      const batchFolderIds = batchFolders
        .map((folder) => folder.id)
        .sort(compareIds);
      if (!sameIds(batchFolderIds, candidateIds)) trashBatchNotFound();
      if (operation.state === "mismatch") operationIdReused();
      if (batchFolders.some((folder) => folder.status === "deleting")) {
        trashPurgeInProgress();
      }
      if (batchFolders.some((folder) => folder.status !== "trashed")) {
        trashBatchNotFound();
      }

      const rootCandidates = batchFolders.filter(
        (folder) =>
          folder.parentId === null || !candidateIdSet.has(folder.parentId),
      );
      if (rootCandidates.length !== 1) trashBatchNotFound();
      const root = rootCandidates[0]!;
      if (outsideParentId !== null) {
        const outsideParent = lockedFolders.find(
          (folder) => folder.id === outsideParentId,
        );
        if (!outsideParent || outsideParent.status !== "active") {
          folderNotActive();
        }
      }

      const subtreeIds = await listLiveSubtreeFolderIds(
        input.ownerId,
        tx,
        root.id,
      );
      if (!sameIds(subtreeIds, batchFolderIds)) trashBatchNotFound();

      const patternRows = await lockFolderBatchPatternRows(
        input.ownerId,
        tx,
        trashBatchId,
        batchFolderIds,
      );
      if (patternRows.some((pattern) => pattern.status === "deleting")) {
        trashPurgeInProgress();
      }
      if (
        patternRows.some(
          (pattern) =>
            pattern.status !== "trashed" ||
            pattern.trashBatchId !== trashBatchId ||
            pattern.folderId === null ||
            !candidateIdSet.has(pattern.folderId),
        )
      ) {
        trashBatchNotFound();
      }
      if (
        patternRows.some(
          (pattern) =>
            pattern.preTrashStatus === null ||
            !restorablePatternStatusSet.has(pattern.preTrashStatus),
        )
      ) {
        patternStateChanged();
      }

      const patternIds = patternRows.map((pattern) => pattern.id);
      const seq = await nextChangeSeq(tx, input.ownerId);
      const now = new Date();
      const updatedFolders = await restoreFolderRows(input.ownerId, tx, {
        ids: batchFolderIds,
        trashBatchId,
        changeSeq: seq,
        now,
      });
      if (updatedFolders.length !== batchFolderIds.length) {
        trashBatchNotFound();
      }
      if (patternIds.length > 0) {
        const updatedPatterns = await restoreFolderBatchPatternRows(
          input.ownerId,
          tx,
          {
            ids: patternIds,
            trashBatchId,
            changeSeq: seq,
            now,
          },
        );
        if (updatedPatterns.length !== patternIds.length) {
          trashBatchNotFound();
        }
      }

      const result: RestoreFolderBatchResult = {
        state: "restored",
        trashBatchId,
        rootFolderId: root.id,
        folderCount: batchFolderIds.length,
        patternCount: patternIds.length,
      };
      await tx.insert(changeLog).values({
        ownerId: input.ownerId,
        seq,
        operationId: mutation.operationId,
        entityType: "folder_tree",
        entityId: root.id,
        operation: "folder_tree.restored",
        payload: {
          rootFolderId: root.id,
          folderIds: batchFolderIds,
          patternIds,
        },
        createdAt: now,
      });
      await storeOperationResult(
        input.ownerId,
        tx,
        mutation.operationId,
        result,
      );
      return result;
    });
  } catch (error) {
    if (isFolderNameConflict(error)) {
      throw new AppError(
        "FOLDER_NAME_CONFLICT",
        409,
        "Folder name already exists",
      );
    }
    throw error;
  }
}
