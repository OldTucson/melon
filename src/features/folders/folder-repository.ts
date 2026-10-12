import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/lib/db/client";
import { folders, patternStatuses } from "@/lib/db/schema";

const libraryPatternStatuses = [
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
] as const satisfies readonly (typeof patternStatuses)[number][];

const libraryPatternStatusesSql = sql.join(
  libraryPatternStatuses.map((status) => sql`${status}::pattern_status`),
  sql`, `,
);

export type FolderRow = typeof folders.$inferSelect;
export type FolderCountRow = FolderRow & {
  directPatternCount: number;
  recursivePatternCount: number;
};

export type InsertFolderInput = {
  id: string;
  parentId: string | null;
  name: string;
  normalizedName: string;
  changeSeq: bigint;
  now: Date;
};

export type RenameFolderInput = {
  folderId: string;
  name: string;
  normalizedName: string;
  version: number;
  changeSeq: bigint;
  now: Date;
};

type RawFolderCountRow = {
  id: string;
  ownerId: string;
  parentId: string | null;
  name: string;
  normalizedName: string;
  status: FolderRow["status"];
  version: number;
  trashBatchId: string | null;
  trashedAt: Date | string | null;
  deletedAt: Date | string | null;
  changeSeq: bigint | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  directPatternCount: bigint | number | string;
  recursivePatternCount: bigint | number | string;
};

type FolderQueryExecutor = Pick<DbTransaction, "execute">;

const toDate = (value: Date | string) =>
  value instanceof Date ? value : new Date(value);

const toNullableDate = (value: Date | string | null) =>
  value === null ? null : toDate(value);

function toFolderCountRow(row: RawFolderCountRow): FolderCountRow {
  return {
    id: row.id,
    ownerId: row.ownerId,
    parentId: row.parentId,
    name: row.name,
    normalizedName: row.normalizedName,
    status: row.status,
    version: row.version,
    trashBatchId: row.trashBatchId,
    trashedAt: toNullableDate(row.trashedAt),
    deletedAt: toNullableDate(row.deletedAt),
    changeSeq: BigInt(row.changeSeq),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    directPatternCount: Number(row.directPatternCount),
    recursivePatternCount: Number(row.recursivePatternCount),
  };
}

async function queryActiveFolderRows(
  executor: FolderQueryExecutor,
  ownerId: string,
) {
  const rows = await executor.execute<RawFolderCountRow>(sql`
    with recursive descendants (owner_id, ancestor_id, descendant_id) as (
      select root.owner_id, root.id, root.id
      from folders root
      where root.owner_id = ${ownerId}
        and root.status = 'active'::folder_status

      union all

      select child.owner_id, descendants.ancestor_id, child.id
      from descendants
      join folders child
        on child.owner_id = ${ownerId}
       and child.owner_id = descendants.owner_id
       and child.parent_id = descendants.descendant_id
       and child.status = 'active'::folder_status
      where descendants.owner_id = ${ownerId}
    ), direct_counts as (
      select pattern.owner_id, pattern.folder_id, count(*) as pattern_count
      from patterns pattern
      where pattern.owner_id = ${ownerId}
        and pattern.status in (${libraryPatternStatusesSql})
      group by pattern.owner_id, pattern.folder_id
    ), recursive_counts as (
      select
        descendants.owner_id,
        descendants.ancestor_id,
        count(pattern.id) as pattern_count
      from descendants
      left join patterns pattern
        on pattern.owner_id = ${ownerId}
       and pattern.owner_id = descendants.owner_id
       and pattern.folder_id = descendants.descendant_id
       and pattern.status in (${libraryPatternStatusesSql})
      where descendants.owner_id = ${ownerId}
      group by descendants.owner_id, descendants.ancestor_id
    )
    select
      folder.id,
      folder.owner_id as "ownerId",
      folder.parent_id as "parentId",
      folder.name,
      folder.normalized_name as "normalizedName",
      folder.status,
      folder.version,
      folder.trash_batch_id as "trashBatchId",
      folder.trashed_at as "trashedAt",
      folder.deleted_at as "deletedAt",
      folder.change_seq as "changeSeq",
      folder.created_at as "createdAt",
      folder.updated_at as "updatedAt",
      coalesce(direct_counts.pattern_count, 0) as "directPatternCount",
      coalesce(recursive_counts.pattern_count, 0) as "recursivePatternCount"
    from folders folder
    join descendants self
      on self.owner_id = ${ownerId}
     and self.owner_id = folder.owner_id
     and self.ancestor_id = folder.id
     and self.descendant_id = folder.id
    left join direct_counts
      on direct_counts.owner_id = ${ownerId}
     and direct_counts.owner_id = folder.owner_id
     and direct_counts.folder_id = folder.id
    left join recursive_counts
      on recursive_counts.owner_id = ${ownerId}
     and recursive_counts.owner_id = folder.owner_id
     and recursive_counts.ancestor_id = folder.id
    where folder.owner_id = ${ownerId}
      and folder.status = 'active'::folder_status
    -- Canonical comparison name plus UUID gives clients a stable flat order.
    order by folder.normalized_name collate "C" asc, folder.id asc
  `);

  return rows.map(toFolderCountRow);
}

export function listActiveFolderRows(
  ownerId: string,
  tx?: DbTransaction,
) {
  return queryActiveFolderRows(tx ?? db, ownerId);
}

export async function lockFolderRow(
  ownerId: string,
  tx: DbTransaction,
  folderId: string,
) {
  const [row] = await tx
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, ownerId), eq(folders.id, folderId)))
    .limit(1)
    .for("update");
  return row;
}

export async function insertFolderRow(
  ownerId: string,
  tx: DbTransaction,
  input: InsertFolderInput,
) {
  const [created] = await tx
    .insert(folders)
    .values({
      id: input.id,
      ownerId,
      parentId: input.parentId,
      name: input.name,
      normalizedName: input.normalizedName,
      changeSeq: input.changeSeq,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return created;
}

export async function renameFolderRow(
  ownerId: string,
  tx: DbTransaction,
  input: RenameFolderInput,
) {
  const [updated] = await tx
    .update(folders)
    .set({
      name: input.name,
      normalizedName: input.normalizedName,
      version: sql`${folders.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(folders.ownerId, ownerId),
        eq(folders.id, input.folderId),
        eq(folders.status, "active"),
        eq(folders.version, input.version),
      ),
    )
    .returning();
  return updated;
}
