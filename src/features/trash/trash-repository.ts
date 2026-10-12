import "server-only";

import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { db, type DbTransaction } from "@/lib/db/client";
import { assets, folders, patterns } from "@/lib/db/schema";

export type TrashFolderRow = typeof folders.$inferSelect;
export type TrashPatternRow = typeof patterns.$inferSelect;
export type TrashPatternReadRow = TrashPatternRow & {
  previewAssetId: string | null;
  thumbnailAssetId: string | null;
};

type RestoreRowsInput = {
  ids: readonly string[];
  changeSeq: bigint;
  now: Date;
};

const previewAssets = alias(assets, "trash_preview_assets");
const thumbnailAssets = alias(assets, "trash_thumbnail_assets");

function requireSortedUniqueNormalizedIds(ids: readonly string[]) {
  if (ids.length === 0) throw new Error("TRASH_IDS_REQUIRED");

  let previous: string | undefined;
  for (const id of ids) {
    const parsed = normalizedUuidSchema.safeParse(id);
    if (
      !parsed.success ||
      parsed.data !== id ||
      (previous !== undefined && previous >= id)
    ) {
      throw new Error("TRASH_IDS_MUST_BE_SORTED_UNIQUE_NORMALIZED");
    }
    previous = id;
  }
}

export async function listTrashRows(
  ownerId: string,
  executor: Pick<DbTransaction, "select"> = db,
) {
  const folderRows = await executor
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.ownerId, ownerId),
        ne(folders.status, "deleted"),
        isNotNull(folders.trashBatchId),
      ),
    )
    .orderBy(asc(folders.trashBatchId), asc(folders.id));
  const patternRows = await executor
    .select({
      ...getTableColumns(patterns),
      previewAssetId: previewAssets.id,
      thumbnailAssetId: thumbnailAssets.id,
    })
    .from(patterns)
    .leftJoin(
      previewAssets,
      and(
        eq(previewAssets.ownerId, ownerId),
        eq(previewAssets.patternId, patterns.id),
        eq(previewAssets.role, "preview"),
      ),
    )
    .leftJoin(
      thumbnailAssets,
      and(
        eq(thumbnailAssets.ownerId, ownerId),
        eq(thumbnailAssets.patternId, patterns.id),
        eq(thumbnailAssets.role, "thumbnail"),
      ),
    )
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        inArray(patterns.status, ["trashed", "deleting"]),
        isNotNull(patterns.trashBatchId),
      ),
    )
    .orderBy(asc(patterns.trashBatchId), asc(patterns.id));

  return { folders: folderRows, patterns: patternRows };
}

export async function lockTrashPatternRows(
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
    .orderBy(asc(patterns.id))
    .for("update");
}

export async function findNonDeletedFolderBatchIds(
  ownerId: string,
  tx: DbTransaction,
  trashBatchIds: readonly string[],
) {
  const ids = [...new Set(trashBatchIds)].sort();
  if (ids.length === 0) return [];
  requireSortedUniqueNormalizedIds(ids);
  const rows = await tx
    .selectDistinct({ trashBatchId: folders.trashBatchId })
    .from(folders)
    .where(
      and(
        eq(folders.ownerId, ownerId),
        inArray(folders.trashBatchId, ids),
        ne(folders.status, "deleted"),
      ),
    )
    .orderBy(asc(folders.trashBatchId));
  return rows.flatMap((row) =>
    row.trashBatchId === null ? [] : [row.trashBatchId],
  );
}

export async function restorePatternRows(
  ownerId: string,
  tx: DbTransaction,
  input: RestoreRowsInput,
) {
  requireSortedUniqueNormalizedIds(input.ids);
  const rows = await tx
    .update(patterns)
    .set({
      status: sql`${patterns.preTrashStatus}`,
      preTrashStatus: null,
      trashBatchId: null,
      trashedAt: null,
      lastErrorCode: null,
      version: sql`${patterns.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        inArray(patterns.id, input.ids),
        eq(patterns.status, "trashed"),
      ),
    )
    .returning();
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function listFolderBatchRows(
  ownerId: string,
  tx: DbTransaction,
  trashBatchId: string,
) {
  return tx
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.ownerId, ownerId),
        eq(folders.trashBatchId, trashBatchId),
      ),
    )
    .orderBy(asc(folders.id));
}

export async function lockFolderRowsById(
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

export async function listLiveSubtreeFolderIds(
  ownerId: string,
  tx: DbTransaction,
  rootFolderId: string,
) {
  const rows = await tx.execute<{ id: string }>(sql`
    with recursive subtree (owner_id, id) as (
      select root.owner_id, root.id
      from folders root
      where root.owner_id = ${ownerId}
        and root.id = ${rootFolderId}
        and root.status <> 'deleted'::folder_status

      union

      select child.owner_id, child.id
      from subtree parent
      join folders child
        on child.owner_id = ${ownerId}
       and child.owner_id = parent.owner_id
       and child.parent_id = parent.id
       and child.status <> 'deleted'::folder_status
      where parent.owner_id = ${ownerId}
    )
    select id
    from subtree
    where owner_id = ${ownerId}
    order by id asc
  `);
  return rows.map((row) => row.id);
}

export async function lockFolderBatchPatternRows(
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
        or(
          eq(patterns.trashBatchId, trashBatchId),
          inArray(patterns.folderId, folderIds),
        ),
      ),
    )
    .orderBy(asc(patterns.id))
    .for("update");
}

export async function restoreFolderRows(
  ownerId: string,
  tx: DbTransaction,
  input: RestoreRowsInput & { trashBatchId: string },
) {
  requireSortedUniqueNormalizedIds(input.ids);
  const rows = await tx
    .update(folders)
    .set({
      status: "active",
      trashBatchId: null,
      trashedAt: null,
      version: sql`${folders.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(folders.ownerId, ownerId),
        eq(folders.trashBatchId, input.trashBatchId),
        inArray(folders.id, input.ids),
        eq(folders.status, "trashed"),
      ),
    )
    .returning({ id: folders.id });
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function restoreFolderBatchPatternRows(
  ownerId: string,
  tx: DbTransaction,
  input: RestoreRowsInput & { trashBatchId: string },
) {
  requireSortedUniqueNormalizedIds(input.ids);
  const rows = await tx
    .update(patterns)
    .set({
      status: sql`${patterns.preTrashStatus}`,
      preTrashStatus: null,
      trashBatchId: null,
      trashedAt: null,
      lastErrorCode: null,
      version: sql`${patterns.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.trashBatchId, input.trashBatchId),
        inArray(patterns.id, input.ids),
        eq(patterns.status, "trashed"),
      ),
    )
    .returning({ id: patterns.id });
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}
