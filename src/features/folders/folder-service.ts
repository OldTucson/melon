import "server-only";

import { randomUUID } from "node:crypto";

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
  folderCreateMutationSchema,
  folderRenameMutationSchema,
  parseFolderName,
} from "./contracts";
import {
  insertFolderRow,
  listActiveFolderRows,
  lockFolderRow,
  renameFolderRow,
  type FolderCountRow,
} from "./folder-repository";

export type CreateFolderInput = {
  ownerId: string;
  operationId: string;
  name: string;
  parentId: string | null;
};

export type RenameFolderInput = {
  ownerId: string;
  folderId: string;
  operationId: string;
  name: string;
  version: number;
};

const renameIdentitySchema = z.object({
  folderId: normalizedUuidSchema,
});

export type FolderDto = ReturnType<typeof toFolderDto>;

function toFolderDto(row: FolderCountRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    parentId: row.parentId,
    name: row.name,
    normalizedName: row.normalizedName,
    status: row.status,
    version: row.version,
    trashBatchId: row.trashBatchId,
    trashedAt: row.trashedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    changeSeq: row.changeSeq.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    directPatternCount: row.directPatternCount,
    recursivePatternCount: row.recursivePatternCount,
  };
}

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

function operationIdReused(): never {
  throw new AppError(
    "OPERATION_ID_REUSED",
    409,
    "Operation ID was already used",
  );
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

async function requireFolderDto(
  ownerId: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  folderId: string,
) {
  const [row] = await listActiveFolderRows(ownerId, {
    rootId: folderId,
    tx,
  });
  if (!row) throw new Error("ACTIVE_FOLDER_RESULT_MISSING");
  return toFolderDto(row);
}

export async function listFolders(input: { ownerId: string }) {
  return (await listActiveFolderRows(input.ownerId)).map(toFolderDto);
}

export async function createFolder(input: CreateFolderInput) {
  const mutation = parseOrValidationError(() =>
    folderCreateMutationSchema.parse({
      operationId: input.operationId,
      input: { name: input.name, parentId: input.parentId },
    }),
  );
  const name = parseOrValidationError(() =>
    parseFolderName(mutation.input.name),
  );
  const create = { ...name, parentId: mutation.input.parentId };
  const operationKey = createOperationKey("folder.create", create);

  try {
    return await db.transaction(async (tx) => {
      const operation = await claimOperation(
        input.ownerId,
        tx,
        mutation.operationId,
        operationKey,
      );
      if (operation.state === "replay") {
        return operation.result as FolderDto;
      }
      if (operation.state === "mismatch") operationIdReused();

      if (create.parentId !== null) {
        const parent = await lockFolderRow(input.ownerId, tx, create.parentId);
        if (!parent) folderNotFound();
        if (parent.status !== "active") folderNotActive();
      }

      const seq = await nextChangeSeq(tx, input.ownerId);
      const now = new Date();
      const created = await insertFolderRow(input.ownerId, tx, {
        id: randomUUID(),
        parentId: create.parentId,
        name: create.name,
        normalizedName: create.normalizedName,
        changeSeq: seq,
        now,
      });
      if (!created) throw new Error("FOLDER_CREATE_FAILED");

      const result = await requireFolderDto(input.ownerId, tx, created.id);
      await tx.insert(changeLog).values({
        ownerId: input.ownerId,
        seq,
        operationId: mutation.operationId,
        entityType: "folder",
        entityId: created.id,
        operation: "folder.created",
        payload: { folder: result },
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

export async function renameFolder(input: RenameFolderInput) {
  const identity = parseOrValidationError(() =>
    renameIdentitySchema.parse({ folderId: input.folderId }),
  );
  const mutation = parseOrValidationError(() =>
    folderRenameMutationSchema.parse({
      operationId: input.operationId,
      patch: { name: input.name, version: input.version },
    }),
  );
  const name = parseOrValidationError(() =>
    parseFolderName(mutation.patch.name),
  );
  const patch = { ...name, version: mutation.patch.version };
  const operationKey = createOperationKey("folder.rename", {
    folderId: identity.folderId,
    patch,
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
        return operation.result as FolderDto;
      }

      const existing = await lockFolderRow(
        input.ownerId,
        tx,
        identity.folderId,
      );
      if (!existing) folderNotFound();
      if (operation.state === "mismatch") operationIdReused();
      if (existing.status !== "active") folderNotActive();
      if (existing.version !== patch.version) folderStateChanged();

      const seq = await nextChangeSeq(tx, input.ownerId);
      const now = new Date();
      const updated = await renameFolderRow(input.ownerId, tx, {
        folderId: identity.folderId,
        name: patch.name,
        normalizedName: patch.normalizedName,
        version: patch.version,
        changeSeq: seq,
        now,
      });
      if (!updated) folderStateChanged();

      const result = await requireFolderDto(input.ownerId, tx, updated.id);
      await tx.insert(changeLog).values({
        ownerId: input.ownerId,
        seq,
        operationId: mutation.operationId,
        entityType: "folder",
        entityId: updated.id,
        operation: "folder.updated",
        payload: { folder: result },
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
