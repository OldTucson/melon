import "server-only";

import { z, ZodError } from "zod";

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
  type FolderDeleteImpact,
  folderTrashMutationSchema,
} from "./contracts";
import { buildFolderDeleteImpact } from "./folder-delete-scope";
import {
  listPatternCommercialDeletionImpacts,
  sumCommercialDeletionImpacts,
} from "@/features/trash/commercial-impact";
import { estimateTrashPurgeOn } from "@/features/trash/retention";
import { lockFolderHierarchy } from "./folder-repository";
import {
  lockFolderTree,
  trashFolderRows,
  trashPatternRows,
} from "./folder-trash-repository";

export type TrashFolderTreeInput = {
  ownerId: string;
  folderId: string;
  operationId: string;
  version: number;
  expectedImpact: FolderDeleteImpact;
};

export type TrashFolderTreeResult = {
  state: "trashed";
  trashBatchId: string;
  rootFolderId: string;
  folderCount: number;
  patternCount: number;
};

const folderIdentitySchema = z.object({ folderId: normalizedUuidSchema });
const replayResultSchema = z
  .object({
    state: z.literal("trashed"),
    trashBatchId: normalizedUuidSchema,
    rootFolderId: normalizedUuidSchema,
    folderCount: z.number().int().positive(),
    patternCount: z.number().int().nonnegative(),
  })
  .strict();

function parseOrValidationError<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) throw validationError();
    throw error;
  }
}

function folderNotFound(): never {
  throw new AppError("FOLDER_NOT_FOUND", 404, "Folder not found");
}

function folderNotActive(): never {
  throw new AppError("FOLDER_NOT_ACTIVE", 409, "Folder is not active");
}

function folderStateChanged(): never {
  throw new AppError(
    "FOLDER_STATE_CHANGED",
    409,
    "Folder state changed",
  );
}

function folderDeleteScopeChanged(actualImpact: FolderDeleteImpact): never {
  throw new AppError(
    "FOLDER_DELETE_SCOPE_CHANGED",
    409,
    "Folder delete scope changed",
    actualImpact,
  );
}

function impactsMatch(
  expected: FolderDeleteImpact,
  actual: FolderDeleteImpact,
) {
  return (
    expected.folderCount === actual.folderCount &&
    expected.patternCount === actual.patternCount &&
    expected.alreadyTrashedFolderCount ===
      actual.alreadyTrashedFolderCount &&
    expected.alreadyTrashedPatternCount ===
      actual.alreadyTrashedPatternCount &&
    expected.hasDeletingEntities === actual.hasDeletingEntities &&
    expected.scopeFingerprint === actual.scopeFingerprint &&
    expected.activeAuthorizationCount === actual.activeAuthorizationCount &&
    expected.activeRevenueFen === actual.activeRevenueFen &&
    expected.totalAuthorizationCount === actual.totalAuthorizationCount &&
    expected.assetCount === actual.assetCount
  );
}

function trashPurgeInProgress(): never {
  throw new AppError(
    "TRASH_PURGE_IN_PROGRESS",
    409,
    "Trash purge is in progress",
  );
}

function operationIdReused(): never {
  throw new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used",
  );
}

function internalReplayError(): never {
  throw new AppError(
    "INTERNAL_ERROR",
    500,
    "Stored folder trash operation result is invalid",
  );
}

function normalizeReplayResult(
  result: unknown,
  rootFolderId: string,
  trashBatchId: string,
): TrashFolderTreeResult {
  const parsed = replayResultSchema.safeParse(result);
  if (
    !parsed.success ||
    parsed.data.rootFolderId !== rootFolderId ||
    parsed.data.trashBatchId !== trashBatchId
  ) {
    internalReplayError();
  }
  return parsed.data;
}

export async function trashFolderTree(
  input: TrashFolderTreeInput,
): Promise<TrashFolderTreeResult> {
  const identity = parseOrValidationError(() =>
    folderIdentitySchema.parse({ folderId: input.folderId }),
  );
  const mutation = parseOrValidationError(() =>
    folderTrashMutationSchema.parse({
      operationId: input.operationId,
      version: input.version,
      expectedImpact: input.expectedImpact,
    }),
  );
  const operationPayload = {
    folderId: identity.folderId,
    version: mutation.version,
    expectedImpact: mutation.expectedImpact,
  };
  const operationKey = createOperationKey("folder.trash", operationPayload);

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
        identity.folderId,
        mutation.operationId,
      );
    }

    await lockFolderHierarchy(input.ownerId, tx);
    const tree = await lockFolderTree(input.ownerId, tx, identity.folderId);
    const root = tree.folders.find((folder) => folder.id === identity.folderId);
    if (!root) folderNotFound();
    if (operation.state === "mismatch") operationIdReused();
    const now = new Date();
    const commercialImpact = sumCommercialDeletionImpacts(
      await listPatternCommercialDeletionImpacts(
        input.ownerId,
        tree.patterns.map((pattern) => pattern.id),
        tx,
      ),
    );
    const actualImpact: FolderDeleteImpact = {
      ...buildFolderDeleteImpact(tree.folders, tree.patterns),
      ...commercialImpact,
      purgeOn: estimateTrashPurgeOn(now),
    };
    if (!impactsMatch(mutation.expectedImpact, actualImpact))
      folderDeleteScopeChanged(actualImpact);
    if (actualImpact.hasDeletingEntities) trashPurgeInProgress();
    if (root.status !== "active") folderNotActive();
    if (root.version !== mutation.version) folderStateChanged();

    const folderIds = tree.folders.map((folder) => folder.id);
    const patternIds = tree.patterns.map((pattern) => pattern.id);
    const seq = await nextChangeSeq(tx, input.ownerId);
    const updatedFolders = await trashFolderRows(input.ownerId, tx, {
      ids: folderIds,
      trashBatchId: mutation.operationId,
      changeSeq: seq,
      now,
    });
    if (updatedFolders.length !== folderIds.length) folderStateChanged();
    if (patternIds.length > 0) {
      const updatedPatterns = await trashPatternRows(input.ownerId, tx, {
        ids: patternIds,
        trashBatchId: mutation.operationId,
        changeSeq: seq,
        now,
      });
      if (updatedPatterns.length !== patternIds.length) folderStateChanged();
    }

    const result: TrashFolderTreeResult = {
      state: "trashed",
      trashBatchId: mutation.operationId,
      rootFolderId: identity.folderId,
      folderCount: folderIds.length,
      patternCount: patternIds.length,
    };
    await tx.insert(changeLog).values({
      ownerId: input.ownerId,
      seq,
      operationId: mutation.operationId,
      entityType: "folder_tree",
      entityId: identity.folderId,
      operation: "folder_tree.trashed",
      payload: {
        rootFolderId: identity.folderId,
        folderIds,
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
}
