import "server-only";

import { z, ZodError } from "zod";

import { lockFolderHierarchy } from "@/features/folders/folder-repository";
import type { OssAdapter } from "@/features/storage/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { patternObjectPrefix } from "@/features/storage/object-keys";
import { createAlibabaOssAdapter } from "@/features/storage/oss-adapter";
import { nextChangeSeq } from "@/lib/db/change-seq";
import { db } from "@/lib/db/client";
import {
  claimOperation,
  createOperationKey,
  storeOperationResult,
  type OperationRow,
} from "@/lib/db/operation";
import { changeLog } from "@/lib/db/schema";
import { getServerEnv } from "@/lib/env/server";
import { AppError, validationError } from "@/lib/http/app-error";

import {
  parseFolderBatchPurgeMutation,
  parsePatternPurgeMutation,
} from "./contracts";
import {
  abortPurgeUploadSessions,
  deletePurgeRelations,
  finalizeFolderTombstones,
  finalizePatternTombstones,
  listFolderCandidatesByBatchIds,
  listFolderBatchPurgePatternIds,
  listPurgePatternCandidates,
  lockFolderBatchPatterns,
  lockPatternsInTrashBatches,
  lockPurgeFolderRows,
  lockPurgeOperation,
  markFoldersDeleting,
  markPatternsDeleting,
  setPurgeError,
  setFolderBatchPurgeError,
  type PurgeFolderRow,
  type PurgePatternRow,
} from "./trash-purge-repository";
import { listLiveSubtreeFolderIds } from "./trash-repository";

const sortedPatternIdsSchema = z
  .array(normalizedUuidSchema)
  .min(1)
  .max(100)
  .superRefine((ids, context) => {
    for (let index = 1; index < ids.length; index += 1) {
      if (ids[index - 1]! >= ids[index]!) {
        context.addIssue({
          code: "custom",
          message: "Pattern IDs must be sorted and unique",
        });
        return;
      }
    }
  });

const purgeTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("patterns"), patternIds: sortedPatternIdsSchema })
    .strict(),
  z
    .object({
      kind: z.literal("folder_batch"),
      trashBatchId: normalizedUuidSchema,
    })
    .strict(),
]);
const pendingResultSchema = z
  .object({ state: z.literal("pending"), target: purgeTargetSchema })
  .strict();
const completeResultSchema = z
  .object({
    state: z.literal("complete"),
    deletedPatternCount: z.number().int().nonnegative(),
    deletedFolderCount: z.number().int().nonnegative(),
  })
  .strict();
const purgeOperationResultSchema = z.discriminatedUnion("state", [
  pendingResultSchema,
  completeResultSchema,
]);

export type PurgeTarget = z.output<typeof purgeTargetSchema>;
export type PurgeOperationResult = z.output<typeof purgeOperationResultSchema>;
export type PurgeCompleteResult = z.output<typeof completeResultSchema>;

type PurgeDatabase = typeof db;
type TrashPurgeServiceDependencies = {
  database: PurgeDatabase;
  oss: OssAdapter;
  now: () => Date;
};

type ClaimOutcome =
  | { state: "complete"; result: PurgeCompleteResult }
  | { state: "pending"; target: PurgeTarget; safeAfter: Date | null };

const compareIds = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameTarget(left: PurgeTarget, right: PurgeTarget) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "folder_batch" && right.kind === "folder_batch") {
    return left.trashBatchId === right.trashBatchId;
  }
  return (
    left.kind === "patterns" &&
    right.kind === "patterns" &&
    sameIds(left.patternIds, right.patternIds)
  );
}

function operationKey(target: PurgeTarget) {
  return target.kind === "patterns"
    ? createOperationKey("trash.patterns.purge", {
        patternIds: target.patternIds,
      })
    : createOperationKey("trash.folder-batch.purge", {
        trashBatchId: target.trashBatchId,
      });
}

function internalError(message: string): never {
  throw new AppError("INTERNAL_ERROR", 500, message);
}

function operationIdReused(): never {
  throw new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used",
  );
}

function patternNotFound(): never {
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

function purgeInProgress(): never {
  throw new AppError(
    "TRASH_PURGE_IN_PROGRESS",
    409,
    "Trash purge is in progress",
  );
}

function purgeDeferred(safeAfter: Date): never {
  throw new AppError(
    "TRASH_PURGE_DEFERRED",
    409,
    `Trash purge is deferred until ${safeAfter.toISOString()}`,
  );
}

function parseIdentity<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) throw validationError();
    throw error;
  }
}

export function parsePurgeOperationResult(result: unknown): PurgeOperationResult {
  const parsed = purgeOperationResultSchema.safeParse(result);
  if (!parsed.success) internalError("Stored purge operation result is invalid");
  return parsed.data;
}

export function parsePendingPurgeOperation(operation: OperationRow): PurgeTarget {
  const parsed = parsePurgeOperationResult(operation.result);
  if (parsed.state !== "pending") {
    internalError("Purge operation is not pending");
  }
  if (operation.kind !== operationKey(parsed.target)) {
    internalError("Stored purge operation target is invalid");
  }
  return parsed.target;
}

function validateOperationResult(
  row: Pick<OperationRow, "kind" | "result">,
  expectedTarget: PurgeTarget,
) {
  const parsed = parsePurgeOperationResult(row.result);
  if (row.kind !== operationKey(expectedTarget)) {
    internalError("Stored purge operation kind is invalid");
  }
  if (parsed.state === "pending" && !sameTarget(parsed.target, expectedTarget)) {
    internalError("Stored purge operation target is invalid");
  }
  if (
    parsed.state === "complete" &&
    expectedTarget.kind === "patterns" &&
    (parsed.deletedPatternCount !== expectedTarget.patternIds.length ||
      parsed.deletedFolderCount !== 0)
  ) {
    internalError("Stored pattern purge result is invalid");
  }
  if (
    parsed.state === "complete" &&
    expectedTarget.kind === "folder_batch" &&
    parsed.deletedFolderCount === 0
  ) {
    internalError("Stored folder purge result is invalid");
  }
  return parsed;
}

function requireExactRows<T extends { id: string }>(
  rows: readonly T[],
  ids: readonly string[],
  missing: () => never,
) {
  if (
    rows.length !== ids.length ||
    rows.some((row, index) => row.id !== ids[index])
  ) {
    missing();
  }
}

function folderTreeRoot(
  folders: readonly PurgeFolderRow[],
  invalid: () => never = trashBatchNotFound,
) {
  const ids = new Set(folders.map((folder) => folder.id));
  const roots = folders.filter(
    (folder) => folder.parentId === null || !ids.has(folder.parentId),
  );
  if (roots.length !== 1) invalid();
  return roots[0]!;
}

function validateFolderBatchPatterns(
  patternRows: readonly PurgePatternRow[],
  trashBatchId: string,
  folderIds: ReadonlySet<string>,
  invalid: () => never = trashBatchNotFound,
) {
  if (
    patternRows.some(
      (pattern) =>
        pattern.trashBatchId !== trashBatchId ||
        pattern.folderId === null ||
        !folderIds.has(pattern.folderId),
    )
  ) {
    invalid();
  }
}

export function createTrashPurgeService(
  dependencies: TrashPurgeServiceDependencies,
) {
  const { database, oss, now } = dependencies;

  async function claimPatternPurge(input: {
    ownerId: string;
    operationId: string;
    target: Extract<PurgeTarget, { kind: "patterns" }>;
  }): Promise<ClaimOutcome> {
    return database.transaction(async (tx) => {
      const operation = await claimOperation(
        input.ownerId,
        tx,
        input.operationId,
        operationKey(input.target),
      );
      if (operation.state === "replay") {
        const stored = await lockPurgeOperation(
          input.ownerId,
          tx,
          input.operationId,
        );
        if (!stored) internalError("Purge operation is missing");
        const replay = validateOperationResult(stored, input.target);
        if (replay.state === "complete") {
          return { state: "complete", result: replay };
        }
      }
      const isReplay = operation.state === "replay";
      const invalidPendingTarget = (message: string): never => {
        if (isReplay) internalError(message);
        patternStateChanged();
      };

      const candidates = await listPurgePatternCandidates(
        input.ownerId,
        tx,
        input.target.patternIds,
      );
      requireExactRows(candidates, input.target.patternIds, () => {
        if (isReplay) internalError("Pending purge target is missing");
        patternNotFound();
      });
      const trashBatchIds = [
        ...new Set(
          candidates.flatMap((row) =>
            row.trashBatchId === null ? [] : [row.trashBatchId],
          ),
        ),
      ].sort(compareIds);
      if (trashBatchIds.length === 0 || candidates.some((row) => !row.trashBatchId)) {
        invalidPendingTarget("Pending purge target batch identity is invalid");
      }

      await lockFolderHierarchy(input.ownerId, tx);
      const folderCandidates = await listFolderCandidatesByBatchIds(
        input.ownerId,
        tx,
        trashBatchIds,
      );
      if (folderCandidates.length > 0) {
        const folderIds = folderCandidates.map((row) => row.id).sort(compareIds);
        await lockPurgeFolderRows(input.ownerId, tx, folderIds);
      }
      const batchPatterns = await lockPatternsInTrashBatches(
        input.ownerId,
        tx,
        trashBatchIds,
      );
      const targetRows = batchPatterns.filter((row) =>
        input.target.patternIds.includes(row.id),
      );
      requireExactRows(targetRows, input.target.patternIds, () => {
        if (isReplay) internalError("Pending purge target is missing");
        patternNotFound();
      });
      if (operation.state === "mismatch") operationIdReused();
      if (folderCandidates.length > 0) {
        if (isReplay) internalError("Pending ordinary purge became a folder batch");
        folderBatchActionRequired();
      }

      if (
        targetRows.some((row) =>
          isReplay ? row.status !== "deleting" : row.status !== "trashed",
        )
      ) {
        if (isReplay) {
          internalError("Pending purge target state is invalid");
        }
        if (!isReplay && targetRows.some((row) => row.status === "deleting")) {
          purgeInProgress();
        }
        patternStateChanged();
      }
      const targetIds = new Set(input.target.patternIds);
      const outsideDeleting = batchPatterns.some(
        (row) => !targetIds.has(row.id) && row.status === "deleting",
      );
      if (outsideDeleting) {
        if (isReplay) internalError("Trash batch has multiple purge operations");
        purgeInProgress();
      }
      if (
        batchPatterns.some(
          (row) => row.status !== "trashed" && row.status !== "deleting",
        )
      ) {
        invalidPendingTarget("Pending purge batch state is invalid");
      }

      const updated = await markPatternsDeleting(
        input.ownerId,
        tx,
        input.target.patternIds,
      );
      requireExactRows(updated, input.target.patternIds, () =>
        invalidPendingTarget("Pending purge target changed while claiming"),
      );
      const safeAfter = await abortPurgeUploadSessions(
        input.ownerId,
        tx,
        input.target.patternIds,
        now(),
      );
      if (!isReplay) {
        await storeOperationResult(input.ownerId, tx, input.operationId, {
          state: "pending",
          target: input.target,
        });
      }
      return { state: "pending", target: input.target, safeAfter };
    });
  }

  async function claimFolderPurge(input: {
    ownerId: string;
    operationId: string;
    target: Extract<PurgeTarget, { kind: "folder_batch" }>;
  }): Promise<ClaimOutcome> {
    return database.transaction(async (tx) => {
      const operation = await claimOperation(
        input.ownerId,
        tx,
        input.operationId,
        operationKey(input.target),
      );
      if (operation.state === "replay") {
        const stored = await lockPurgeOperation(
          input.ownerId,
          tx,
          input.operationId,
        );
        if (!stored) internalError("Purge operation is missing");
        const replay = validateOperationResult(stored, input.target);
        if (replay.state === "complete") {
          return { state: "complete", result: replay };
        }
      }
      const isReplay = operation.state === "replay";
      const invalidFolderTarget = (message: string): never => {
        if (isReplay) internalError(message);
        trashBatchNotFound();
      };

      await lockFolderHierarchy(input.ownerId, tx);
      const candidates = await listFolderCandidatesByBatchIds(
        input.ownerId,
        tx,
        [input.target.trashBatchId],
      );
      if (candidates.length === 0) {
        invalidFolderTarget("Pending purge target folder batch is missing");
      }
      const folderIds = candidates.map((row) => row.id).sort(compareIds);
      const lockedFolders = await lockPurgeFolderRows(
        input.ownerId,
        tx,
        folderIds,
      );
      requireExactRows(lockedFolders, folderIds, () =>
        invalidFolderTarget("Pending purge target folders are missing"),
      );
      if (operation.state === "mismatch") operationIdReused();
      const root = folderTreeRoot(lockedFolders, () =>
        invalidFolderTarget("Pending purge target folder roots are invalid"),
      );
      const subtreeIds = await listLiveSubtreeFolderIds(
        input.ownerId,
        tx,
        root.id,
      );
      if (!sameIds(subtreeIds, folderIds)) {
        invalidFolderTarget("Pending purge target folder hierarchy is invalid");
      }

      const patternRows = await lockFolderBatchPatterns(
        input.ownerId,
        tx,
        input.target.trashBatchId,
        folderIds,
      );
      validateFolderBatchPatterns(
        patternRows,
        input.target.trashBatchId,
        new Set(folderIds),
        () =>
          invalidFolderTarget("Pending purge target folder patterns are invalid"),
      );
      const expectedStatus = isReplay ? "deleting" : "trashed";
      if (
        lockedFolders.some((row) => row.status !== expectedStatus) ||
        patternRows.some((row) => row.status !== expectedStatus)
      ) {
        if (
          !isReplay &&
          (lockedFolders.some((row) => row.status === "deleting") ||
            patternRows.some((row) => row.status === "deleting"))
        ) {
          purgeInProgress();
        }
        invalidFolderTarget("Pending purge target state is invalid");
      }

      const updatedFolders = await markFoldersDeleting(
        input.ownerId,
        tx,
        folderIds,
      );
      requireExactRows(updatedFolders, folderIds, () =>
        invalidFolderTarget("Pending purge target folders changed while claiming"),
      );
      const patternIds = patternRows.map((row) => row.id).sort(compareIds);
      if (patternIds.length > 0) {
        const updatedPatterns = await markPatternsDeleting(
          input.ownerId,
          tx,
          patternIds,
        );
        requireExactRows(updatedPatterns, patternIds, () =>
          invalidFolderTarget(
            "Pending purge target patterns changed while claiming",
          ),
        );
      }
      const safeAfter = await abortPurgeUploadSessions(
        input.ownerId,
        tx,
        patternIds,
        now(),
      );
      if (!isReplay) {
        await storeOperationResult(input.ownerId, tx, input.operationId, {
          state: "pending",
          target: input.target,
        });
      }
      return { state: "pending", target: input.target, safeAfter };
    });
  }

  async function handleOssFailure(input: {
    ownerId: string;
    operationId: string;
    target: PurgeTarget;
  }): Promise<PurgeCompleteResult | undefined> {
    return database.transaction(async (tx) => {
      const operation = await lockPurgeOperation(
        input.ownerId,
        tx,
        input.operationId,
      );
      if (!operation) internalError("Purge operation is missing");
      const result = validateOperationResult(operation, input.target);
      if (result.state === "complete") return result;
      if (input.target.kind === "patterns") {
        await setPurgeError(
          input.ownerId,
          tx,
          input.target.patternIds,
        );
      } else {
        await setFolderBatchPurgeError(
          input.ownerId,
          tx,
          input.target.trashBatchId,
        );
      }
      return undefined;
    });
  }

  async function finalizePurge(input: {
    ownerId: string;
    operationId: string;
    target: PurgeTarget;
  }): Promise<PurgeCompleteResult> {
    return database.transaction(async (tx) => {
      const operation = await lockPurgeOperation(
        input.ownerId,
        tx,
        input.operationId,
      );
      if (!operation) internalError("Purge operation is missing");
      const stored = validateOperationResult(operation, input.target);
      if (stored.state === "complete") return stored;

      await lockFolderHierarchy(input.ownerId, tx);
      let folderRows: PurgeFolderRow[] = [];
      let patternRows: PurgePatternRow[];
      let rootFolderId: string | undefined;

      if (input.target.kind === "patterns") {
        const candidates = await listPurgePatternCandidates(
          input.ownerId,
          tx,
          input.target.patternIds,
        );
        requireExactRows(candidates, input.target.patternIds, () =>
          internalError("Purge target patterns are missing"),
        );
        const trashBatchIds = [
          ...new Set(
            candidates.flatMap((row) =>
              row.trashBatchId === null ? [] : [row.trashBatchId],
            ),
          ),
        ].sort(compareIds);
        if (trashBatchIds.length === 0) {
          internalError("Purge target batch identity is invalid");
        }
        const folderCandidates = await listFolderCandidatesByBatchIds(
          input.ownerId,
          tx,
          trashBatchIds,
        );
        if (folderCandidates.length > 0) {
          internalError("Ordinary purge became a folder batch");
        }
        const batchPatterns = await lockPatternsInTrashBatches(
          input.ownerId,
          tx,
          trashBatchIds,
        );
        patternRows = batchPatterns.filter((row) =>
          input.target.kind === "patterns"
            ? input.target.patternIds.includes(row.id)
            : false,
        );
        requireExactRows(patternRows, input.target.patternIds, () =>
          internalError("Purge target patterns are missing"),
        );
      } else {
        const candidates = await listFolderCandidatesByBatchIds(
          input.ownerId,
          tx,
          [input.target.trashBatchId],
        );
        if (candidates.length === 0) {
          internalError("Purge target folder batch is missing");
        }
        const folderIds = candidates.map((row) => row.id).sort(compareIds);
        folderRows = await lockPurgeFolderRows(input.ownerId, tx, folderIds);
        requireExactRows(folderRows, folderIds, () =>
          internalError("Purge target folders are missing"),
        );
        const root = folderTreeRoot(folderRows, () =>
          internalError("Purge target folder roots are invalid"),
        );
        rootFolderId = root.id;
        const subtreeIds = await listLiveSubtreeFolderIds(
          input.ownerId,
          tx,
          root.id,
        );
        if (!sameIds(subtreeIds, folderIds)) {
          internalError("Purge target folder hierarchy is invalid");
        }
        patternRows = await lockFolderBatchPatterns(
          input.ownerId,
          tx,
          input.target.trashBatchId,
          folderIds,
        );
        validateFolderBatchPatterns(
          patternRows,
          input.target.trashBatchId,
          new Set(folderIds),
          () => internalError("Purge target folder patterns are invalid"),
        );
      }

      if (
        folderRows.some((row) => row.status !== "deleting") ||
        patternRows.some((row) => row.status !== "deleting")
      ) {
        internalError("Purge target state is invalid");
      }
      const patternIds = patternRows.map((row) => row.id).sort(compareIds);
      const folderIds = folderRows.map((row) => row.id).sort(compareIds);
      const seq = await nextChangeSeq(tx, input.ownerId);
      const timestamp = now();
      if (patternIds.length > 0) {
        await deletePurgeRelations(input.ownerId, tx, patternIds);
        const patternsUpdated = await finalizePatternTombstones(
          input.ownerId,
          tx,
          { patternIds, changeSeq: seq, now: timestamp },
        );
        requireExactRows(patternsUpdated, patternIds, () =>
          internalError("Purge target patterns changed"),
        );
      }
      if (folderIds.length > 0) {
        const foldersUpdated = await finalizeFolderTombstones(
          input.ownerId,
          tx,
          { folderIds, changeSeq: seq, now: timestamp },
        );
        requireExactRows(foldersUpdated, folderIds, () =>
          internalError("Purge target folders changed"),
        );
      }

      const result: PurgeCompleteResult = {
        state: "complete",
        deletedPatternCount: patternIds.length,
        deletedFolderCount: folderIds.length,
      };
      await tx.insert(changeLog).values({
        ownerId: input.ownerId,
        seq,
        operationId: input.operationId,
        entityType:
          input.target.kind === "patterns" ? "pattern_batch" : "folder_tree",
        entityId:
          input.target.kind === "patterns"
            ? input.operationId
            : rootFolderId!,
        operation:
          input.target.kind === "patterns"
            ? "patterns.deleted"
            : "folder_tree.deleted",
        payload: {
          patternIds,
          ...(input.target.kind === "folder_batch"
            ? {
                trashBatchId: input.target.trashBatchId,
                rootFolderId,
                folderIds,
              }
            : {}),
        },
        createdAt: timestamp,
      });
      await storeOperationResult(
        input.ownerId,
        tx,
        input.operationId,
        result,
      );
      return result;
    });
  }

  async function continuePurge(input: {
    ownerId: string;
    operationId: string;
    target: PurgeTarget;
    safeAfter: Date | null;
  }) {
    let patternIds: string[];
    if (input.target.kind === "patterns") {
      patternIds = input.target.patternIds;
    } else {
      patternIds = (
        await listFolderBatchPurgePatternIds(
          input.ownerId,
          input.target.trashBatchId,
          database,
        )
      ).map((row) => row.id);
    }

    if (input.safeAfter && now() < input.safeAfter) {
      purgeDeferred(input.safeAfter);
    }
    try {
      for (const patternId of patternIds) {
        const prefix = patternObjectPrefix({
          ownerId: input.ownerId,
          patternId,
        });
        const keys = await oss.listObjectKeys(prefix);
        await oss.deleteObjectsUnderPrefix(prefix, keys);
      }
    } catch {
      const completed = await handleOssFailure(input);
      if (completed) return completed;
      throw new AppError(
        "OSS_DELETE_FAILED",
        502,
        "OSS object deletion failed",
      );
    }
    return finalizePurge(input);
  }

  async function purgePatterns(input: {
    ownerId: string;
    operationId: string;
    patternIds: string[];
  }): Promise<PurgeCompleteResult> {
    const mutation = parsePatternPurgeMutation({
      operationId: input.operationId,
      patternIds: input.patternIds,
    });
    const target: Extract<PurgeTarget, { kind: "patterns" }> = {
      kind: "patterns",
      patternIds: [...mutation.patternIds].sort(compareIds),
    };
    const claimed = await claimPatternPurge({
      ownerId: input.ownerId,
      operationId: mutation.operationId,
      target,
    });
    if (claimed.state === "complete") return claimed.result;
    return continuePurge({
      ownerId: input.ownerId,
      operationId: mutation.operationId,
      target,
      safeAfter: claimed.safeAfter,
    });
  }

  async function purgeFolderBatch(input: {
    ownerId: string;
    operationId: string;
    trashBatchId: string;
  }): Promise<PurgeCompleteResult> {
    const mutation = parseFolderBatchPurgeMutation({
      operationId: input.operationId,
    });
    const trashBatchId = parseIdentity(() =>
      normalizedUuidSchema.parse(input.trashBatchId),
    );
    const target: Extract<PurgeTarget, { kind: "folder_batch" }> = {
      kind: "folder_batch",
      trashBatchId,
    };
    const claimed = await claimFolderPurge({
      ownerId: input.ownerId,
      operationId: mutation.operationId,
      target,
    });
    if (claimed.state === "complete") return claimed.result;
    return continuePurge({
      ownerId: input.ownerId,
      operationId: mutation.operationId,
      target,
      safeAfter: claimed.safeAfter,
    });
  }

  return { purgePatterns, purgeFolderBatch };
}

let defaultService: ReturnType<typeof createTrashPurgeService> | undefined;

function getDefaultService() {
  if (defaultService) return defaultService;
  const env = getServerEnv();
  defaultService = createTrashPurgeService({
    database: db,
    oss: createAlibabaOssAdapter({
      region: env.ALIYUN_OSS_REGION,
      bucket: env.ALIYUN_OSS_BUCKET,
      endpoint: env.ALIYUN_OSS_ENDPOINT,
      cname: env.ALIYUN_OSS_CNAME,
    }),
    now: () => new Date(),
  });
  return defaultService;
}

export const purgePatterns = (
  input: Parameters<ReturnType<typeof createTrashPurgeService>["purgePatterns"]>[0],
) => getDefaultService().purgePatterns(input);

export const purgeFolderBatch = (
  input: Parameters<
    ReturnType<typeof createTrashPurgeService>["purgeFolderBatch"]
  >[0],
) => getDefaultService().purgeFolderBatch(input);
