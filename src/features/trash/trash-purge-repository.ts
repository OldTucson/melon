import "server-only";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { db, type DbTransaction } from "@/lib/db/client";
import {
  assets,
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
      status: "deleted",
      isFavorite: false,
      contentHash: null,
      lastErrorCode: null,
      trashBatchId: null,
      preTrashStatus: null,
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
  const [folderRows, patternRows] = await Promise.all([
    executor
      .select({
        ownerId: folders.ownerId,
        trashBatchId: folders.trashBatchId,
        trashedAt: folders.trashedAt,
      })
      .from(folders)
      .where(
        and(
          eq(folders.status, "trashed"),
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
      })
      .from(patterns)
      .where(
        and(
          eq(patterns.status, "trashed"),
          isNotNull(patterns.trashBatchId),
          isNotNull(patterns.trashedAt),
        ),
      )
      .orderBy(asc(patterns.ownerId), asc(patterns.trashBatchId), asc(patterns.id)),
  ]);

  const folderBatchKeys = new Map<string, Date>();
  for (const row of folderRows) {
    if (!row.trashBatchId || !row.trashedAt) continue;
    const key = `${row.ownerId}:${row.trashBatchId}`;
    const earliest = folderBatchKeys.get(key);
    if (!earliest || row.trashedAt < earliest) folderBatchKeys.set(key, row.trashedAt);
  }
  const patternBatches = new Map<
    string,
    { ownerId: string; trashBatchId: string; earliest: Date; patternIds: string[] }
  >();
  for (const row of patternRows) {
    if (!row.trashBatchId || !row.trashedAt) continue;
    const key = `${row.ownerId}:${row.trashBatchId}`;
    const existing = patternBatches.get(key);
    if (existing) {
      existing.patternIds.push(row.id);
      if (row.trashedAt < existing.earliest) existing.earliest = row.trashedAt;
    } else {
      patternBatches.set(key, {
        ownerId: row.ownerId,
        trashBatchId: row.trashBatchId,
        earliest: row.trashedAt,
        patternIds: [row.id],
      });
    }
  }

  const targets: ExpiredTrashTarget[] = [];
  for (const [key, earliest] of folderBatchKeys) {
    const patternEarliest = patternBatches.get(key)?.earliest;
    const batchEarliest =
      patternEarliest && patternEarliest < earliest ? patternEarliest : earliest;
    if (batchEarliest > cutoff) continue;
    const separator = key.indexOf(":");
    targets.push({
      kind: "folder_batch",
      ownerId: key.slice(0, separator),
      trashBatchId: key.slice(separator + 1),
    });
  }
  for (const [key, batch] of patternBatches) {
    if (folderBatchKeys.has(key) || batch.earliest > cutoff) continue;
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
