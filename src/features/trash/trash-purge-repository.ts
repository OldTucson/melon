import "server-only";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  like,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { removeVisualSearchRowsForPatterns } from "@/features/image-search/index-service";
import { UPLOAD_WRITE_DRAIN_GRACE_MS } from "@/features/storage/upload-timing";
import { db, type DbTransaction } from "@/lib/db/client";
import {
  assets,
  authorizations,
  changeLog,
  folders,
  operations,
  patterns,
  patternTags,
  uploadSessions,
} from "@/lib/db/schema";

export type PurgePatternRow = typeof patterns.$inferSelect;
export type PurgeFolderRow = typeof folders.$inferSelect;

export type ExpiredTrashTarget =
  | {
      kind: "patterns";
      ownerId: string;
      trashBatchId: string;
      patternIds: string[];
    }
  | {
      kind: "folder_batch";
      ownerId: string;
      trashBatchId: string;
    };

function requireSortedUniqueNormalizedIds(ids: readonly string[]) {
  if (ids.length === 0) throw new Error("PURGE_IDS_REQUIRED");
  let previous: string | undefined;
  for (const id of ids) {
    const parsed = normalizedUuidSchema.safeParse(id);
    if (
      !parsed.success ||
      parsed.data !== id ||
      (previous !== undefined && previous >= id)
    ) {
      throw new Error("PURGE_IDS_MUST_BE_SORTED_UNIQUE_NORMALIZED");
    }
    previous = id;
  }
}

export function listPurgePatternCandidates(
  ownerId: string,
  tx: DbTransaction,
  patternIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(patternIds);
  return tx
    .select()
    .from(patterns)
    .where(
      and(eq(patterns.ownerId, ownerId), inArray(patterns.id, patternIds)),
    )
    .orderBy(asc(patterns.id));
}

export function listFolderCandidatesByBatchIds(
  ownerId: string,
  tx: DbTransaction,
  trashBatchIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(trashBatchIds);
  return tx
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.ownerId, ownerId),
        inArray(folders.trashBatchId, trashBatchIds),
        ne(folders.status, "deleted"),
      ),
    )
    .orderBy(asc(folders.id));
}

export function lockPurgeFolderRows(
  ownerId: string,
  tx: DbTransaction,
  folderIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(folderIds);
  return tx
    .select()
    .from(folders)
    .where(
      and(eq(folders.ownerId, ownerId), inArray(folders.id, folderIds)),
    )
    .orderBy(asc(folders.id))
    .for("update");
}

export function lockPatternsInTrashBatches(
  ownerId: string,
  tx: DbTransaction,
  trashBatchIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(trashBatchIds);
  return tx
    .select()
    .from(patterns)
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        inArray(patterns.trashBatchId, trashBatchIds),
        ne(patterns.status, "deleted"),
      ),
    )
    .orderBy(asc(patterns.id))
    .for("update");
}

export function lockFolderBatchPatterns(
  ownerId: string,
  tx: DbTransaction,
  trashBatchId: string,
  folderIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(folderIds);
  return tx
    .select()
    .from(patterns)
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        ne(patterns.status, "deleted"),
        or(
          eq(patterns.trashBatchId, trashBatchId),
          inArray(patterns.folderId, folderIds),
        ),
      ),
    )
    .orderBy(asc(patterns.id))
    .for("update");
}

export async function markPatternsDeleting(
  ownerId: string,
  tx: DbTransaction,
  patternIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(patternIds);
  const rows = await tx
    .update(patterns)
    .set({ status: "deleting", lastErrorCode: null })
    .where(
      and(eq(patterns.ownerId, ownerId), inArray(patterns.id, patternIds)),
    )
    .returning({ id: patterns.id });
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function markFoldersDeleting(
  ownerId: string,
  tx: DbTransaction,
  folderIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(folderIds);
  const rows = await tx
    .update(folders)
    .set({ status: "deleting" })
    .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, folderIds)))
    .returning({ id: folders.id });
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function abortPurgeUploadSessions(
  ownerId: string,
  tx: DbTransaction,
  patternIds: readonly string[],
  now: Date,
) {
  if (patternIds.length === 0) return null;
  requireSortedUniqueNormalizedIds(patternIds);
  const sessions = await tx
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.ownerId, ownerId),
        inArray(uploadSessions.patternId, patternIds),
      ),
    )
    .orderBy(asc(uploadSessions.id))
    .for("update");

  if (sessions.length > 0) {
    await tx
      .update(uploadSessions)
      .set({
        status: "aborted",
        lastErrorCode: "UPLOAD_ABORTED_BY_PURGE",
        updatedAt: now,
      })
      .where(
        and(
          eq(uploadSessions.ownerId, ownerId),
          inArray(
            uploadSessions.id,
            sessions.map((session) => session.id),
          ),
        ),
      );
  }

  let safeAfter: Date | null = null;
  for (const session of sessions) {
    for (const candidate of [
      session.credentialIssueFenceAt,
      session.credentialsExpireAt
        ? new Date(
            session.credentialsExpireAt.getTime() +
              UPLOAD_WRITE_DRAIN_GRACE_MS,
          )
        : null,
    ]) {
      if (candidate && (!safeAfter || candidate > safeAfter)) {
        safeAfter = candidate;
      }
    }
  }
  return safeAfter;
}

export function listPurgeObjectKeys(
  ownerId: string,
  patternIds: readonly string[],
  executor: Pick<DbTransaction, "select"> = db,
) {
  requireSortedUniqueNormalizedIds(patternIds);
  return executor
    .select({ objectKey: assets.objectKey })
    .from(assets)
    .where(
      and(eq(assets.ownerId, ownerId), inArray(assets.patternId, patternIds)),
    )
    .orderBy(asc(assets.objectKey));
}

export function listFolderBatchPurgePatternIds(
  ownerId: string,
  trashBatchId: string,
  executor: Pick<DbTransaction, "select"> = db,
) {
  return executor
    .select({ id: patterns.id })
    .from(patterns)
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.trashBatchId, trashBatchId),
        eq(patterns.status, "deleting"),
      ),
    )
    .orderBy(asc(patterns.id));
}

export async function setPurgeError(
  ownerId: string,
  tx: DbTransaction,
  patternIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(patternIds);
  await tx
    .update(patterns)
    .set({ lastErrorCode: "OSS_DELETE_FAILED" })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        inArray(patterns.id, patternIds),
        eq(patterns.status, "deleting"),
      ),
    );
}

export async function setFolderBatchPurgeError(
  ownerId: string,
  tx: DbTransaction,
  trashBatchId: string,
) {
  await tx
    .update(patterns)
    .set({ lastErrorCode: "OSS_DELETE_FAILED" })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.trashBatchId, trashBatchId),
        eq(patterns.status, "deleting"),
      ),
    );
}

export async function lockPurgeOperation(
  ownerId: string,
  tx: DbTransaction,
  operationId: string,
) {
  const [operation] = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.ownerId, ownerId),
        eq(operations.operationId, operationId),
      ),
    )
    .limit(1)
    .for("update");
  return operation;
}

export async function deletePurgeRelations(
  ownerId: string,
  tx: DbTransaction,
  patternIds: readonly string[],
) {
  requireSortedUniqueNormalizedIds(patternIds);
  const authorizationRows = await tx
    .select({ id: authorizations.id })
    .from(authorizations)
    .where(
      and(
        eq(authorizations.ownerId, ownerId),
        inArray(authorizations.patternId, patternIds),
      ),
    );
  const authorizationIds = authorizationRows.map((row) => row.id).sort();
  if (authorizationIds.length > 0) {
    await tx
      .delete(changeLog)
      .where(
        and(
          eq(changeLog.ownerId, ownerId),
          eq(changeLog.entityType, "authorization"),
          inArray(changeLog.entityId, authorizationIds),
        ),
      );
  }
  await tx
    .delete(operations)
    .where(
      and(
        eq(operations.ownerId, ownerId),
        like(operations.kind, "authorization.%"),
        sql`${operations.result} ->> 'patternId' in (${sql.join(
          patternIds.map((patternId) => sql`${patternId}`),
          sql`, `,
        )})`,
      ),
    );
  await tx
    .delete(authorizations)
    .where(
      and(
        eq(authorizations.ownerId, ownerId),
        inArray(authorizations.patternId, patternIds),
      ),
    );
  const wherePattern = (ownerColumn: typeof patternTags.ownerId, patternColumn: typeof patternTags.patternId) =>
    and(eq(ownerColumn, ownerId), inArray(patternColumn, patternIds));
  await tx.delete(patternTags).where(wherePattern(patternTags.ownerId, patternTags.patternId));
  await tx
    .delete(uploadSessions)
    .where(
      and(
        eq(uploadSessions.ownerId, ownerId),
        inArray(uploadSessions.patternId, patternIds),
      ),
    );
  await removeVisualSearchRowsForPatterns(tx, { ownerId, patternIds });
  await tx
    .delete(assets)
    .where(
      and(eq(assets.ownerId, ownerId), inArray(assets.patternId, patternIds)),
    );
}

export async function finalizePatternTombstones(
  ownerId: string,
  tx: DbTransaction,
  input: {
    patternIds: readonly string[];
    changeSeq: bigint;
    now: Date;
  },
) {
  requireSortedUniqueNormalizedIds(input.patternIds);
  const rows = await tx
    .update(patterns)
    .set({
      folderId: null,
      name: "",
      originalFilename: "",
      extension: "",
      detectedMimeType: null,
      sizeBytes: 0n,
      status: "deleted",
      previewStatus: "unsupported",
      isFavorite: false,
      contentHash: null,
      commercialVersion: 0,
      lastErrorCode: null,
      trashBatchId: null,
      preTrashStatus: null,
      trashedAt: null,
      deletedAt: input.now,
      version: sql`${patterns.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        inArray(patterns.id, input.patternIds),
        eq(patterns.status, "deleting"),
      ),
    )
    .returning({ id: patterns.id });
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function finalizeFolderTombstones(
  ownerId: string,
  tx: DbTransaction,
  input: {
    folderIds: readonly string[];
    changeSeq: bigint;
    now: Date;
  },
) {
  requireSortedUniqueNormalizedIds(input.folderIds);
  const rows = await tx
    .update(folders)
    .set({
      parentId: null,
      status: "deleted",
      trashBatchId: null,
      deletedAt: input.now,
      version: sql`${folders.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(folders.ownerId, ownerId),
        inArray(folders.id, input.folderIds),
        eq(folders.status, "deleting"),
      ),
    )
    .returning({ id: folders.id });
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function listExpiredTrashTargets(
  cutoff: Date,
  executor: Pick<DbTransaction, "select"> = db,
): Promise<ExpiredTrashTarget[]> {
  const [folderRows, patternRows, pendingOperations] = await Promise.all([
    executor
      .select({
        ownerId: folders.ownerId,
        trashBatchId: folders.trashBatchId,
        trashedAt: folders.trashedAt,
        status: folders.status,
      })
      .from(folders)
      .where(
        and(
          inArray(folders.status, ["trashed", "deleting"]),
          isNotNull(folders.trashBatchId),
          isNotNull(folders.trashedAt),
        ),
      )
      .orderBy(asc(folders.ownerId), asc(folders.trashBatchId)),
    executor
      .select({
        id: patterns.id,
        ownerId: patterns.ownerId,
        trashBatchId: patterns.trashBatchId,
        trashedAt: patterns.trashedAt,
        status: patterns.status,
      })
      .from(patterns)
      .where(
        and(
          inArray(patterns.status, ["trashed", "deleting"]),
          isNotNull(patterns.trashBatchId),
          isNotNull(patterns.trashedAt),
        ),
      )
      .orderBy(asc(patterns.ownerId), asc(patterns.trashBatchId), asc(patterns.id)),
    executor
      .select({ ownerId: operations.ownerId, result: operations.result })
      .from(operations)
      .where(
        and(
          or(
            like(operations.kind, "trash.patterns.purge:%"),
            like(operations.kind, "trash.folder-batch.purge:%"),
          ),
          sql`${operations.result} ->> 'state' = 'pending'`,
        ),
      ),
  ]);

  const pendingPatternKeys = new Set<string>();
  const pendingFolderBatchKeys = new Set<string>();
  const ownersWithCorruptPendingOperations = new Set<string>();
  for (const operation of pendingOperations) {
    const result = operation.result;
    if (typeof result !== "object" || result === null) {
      ownersWithCorruptPendingOperations.add(operation.ownerId);
      continue;
    }
    const target = result.target;
    if (typeof target !== "object" || target === null) {
      ownersWithCorruptPendingOperations.add(operation.ownerId);
      continue;
    }
    if (
      "kind" in target &&
      target.kind === "patterns" &&
      "patternIds" in target &&
      Array.isArray(target.patternIds) &&
      target.patternIds.length > 0 &&
      target.patternIds.every(
        (patternId) =>
          typeof patternId === "string" &&
          normalizedUuidSchema.safeParse(patternId).success,
      ) &&
      new Set(target.patternIds).size === target.patternIds.length
    ) {
      for (const patternId of target.patternIds) {
        pendingPatternKeys.add(`${operation.ownerId}:${patternId}`);
      }
    } else if (
      "kind" in target &&
      target.kind === "folder_batch" &&
      "trashBatchId" in target &&
      typeof target.trashBatchId === "string" &&
      normalizedUuidSchema.safeParse(target.trashBatchId).success
    ) {
      pendingFolderBatchKeys.add(
        `${operation.ownerId}:${target.trashBatchId}`,
      );
    } else {
      ownersWithCorruptPendingOperations.add(operation.ownerId);
    }
  }

  const folderBatchKeys = new Map<
    string,
    { earliest: Date; blocked: boolean }
  >();
  for (const row of folderRows) {
    if (!row.trashBatchId || !row.trashedAt) continue;
    const key = `${row.ownerId}:${row.trashBatchId}`;
    const existing = folderBatchKeys.get(key);
    if (existing) {
      if (row.trashedAt < existing.earliest) existing.earliest = row.trashedAt;
      if (row.status === "deleting") existing.blocked = true;
    } else {
      folderBatchKeys.set(key, {
        earliest: row.trashedAt,
        blocked:
          row.status === "deleting" || pendingFolderBatchKeys.has(key),
      });
    }
  }
  const patternBatches = new Map<
    string,
    {
      ownerId: string;
      trashBatchId: string;
      earliest: Date;
      patternIds: string[];
      blocked: boolean;
    }
  >();
  for (const row of patternRows) {
    if (!row.trashBatchId || !row.trashedAt) continue;
    const key = `${row.ownerId}:${row.trashBatchId}`;
    const existing = patternBatches.get(key);
    if (existing) {
      existing.patternIds.push(row.id);
      if (row.trashedAt < existing.earliest) existing.earliest = row.trashedAt;
      if (
        row.status === "deleting" ||
        pendingPatternKeys.has(`${row.ownerId}:${row.id}`)
      ) {
        existing.blocked = true;
      }
    } else {
      patternBatches.set(key, {
        ownerId: row.ownerId,
        trashBatchId: row.trashBatchId,
        earliest: row.trashedAt,
        patternIds: [row.id],
        blocked:
          row.status === "deleting" ||
          pendingPatternKeys.has(`${row.ownerId}:${row.id}`) ||
          pendingFolderBatchKeys.has(key),
      });
    }
  }

  const targets: ExpiredTrashTarget[] = [];
  for (const [key, folderBatch] of folderBatchKeys) {
    const separator = key.indexOf(":");
    const ownerId = key.slice(0, separator);
    const patternBatch = patternBatches.get(key);
    if (
      ownersWithCorruptPendingOperations.has(ownerId) ||
      folderBatch.blocked ||
      patternBatch?.blocked
    ) {
      continue;
    }
    const patternEarliest = patternBatch?.earliest;
    const batchEarliest =
      patternEarliest && patternEarliest < folderBatch.earliest
        ? patternEarliest
        : folderBatch.earliest;
    if (batchEarliest > cutoff) continue;
    targets.push({
      kind: "folder_batch",
      ownerId,
      trashBatchId: key.slice(separator + 1),
    });
  }
  for (const [key, batch] of patternBatches) {
    if (
      folderBatchKeys.has(key) ||
      batch.blocked ||
      ownersWithCorruptPendingOperations.has(batch.ownerId) ||
      batch.earliest > cutoff
    ) {
      continue;
    }
    targets.push({
      kind: "patterns",
      ownerId: batch.ownerId,
      trashBatchId: batch.trashBatchId,
      patternIds: batch.patternIds.sort(),
    });
  }
  return targets.sort((left, right) => {
    const ownerOrder = left.ownerId.localeCompare(right.ownerId);
    if (ownerOrder !== 0) return ownerOrder;
    return left.trashBatchId.localeCompare(right.trashBatchId);
  });
}
