import "server-only";

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import type { DbTransaction } from "@/lib/db/client";
import { folders, patterns } from "@/lib/db/schema";

import type { FolderRow } from "./folder-repository";

export type FolderTreePatternRow = typeof patterns.$inferSelect;

export type LockedFolderTree = {
  folders: FolderRow[];
  patterns: FolderTreePatternRow[];
};

type TrashTreeUpdate = {
  ids: readonly string[];
  trashBatchId: string;
  changeSeq: bigint;
  now: Date;
};

function requireSortedUniqueIds(ids: readonly string[]) {
  if (ids.length === 0) throw new Error("FOLDER_TREE_IDS_REQUIRED");
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]! >= ids[index]!) {
      throw new Error("FOLDER_TREE_IDS_MUST_BE_SORTED_UNIQUE");
    }
  }
}

export async function lockFolderTree(
  ownerId: string,
  tx: DbTransaction,
  rootFolderId: string,
): Promise<LockedFolderTree> {
  const subtree = await tx.execute<{ id: string }>(sql`
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
    select subtree.id
    from subtree
    where subtree.owner_id = ${ownerId}
    order by subtree.id asc
  `);
  const folderIds = subtree.map((row) => row.id);
  if (folderIds.length === 0) return { folders: [], patterns: [] };

  const lockedFolders = await tx
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.ownerId, ownerId),
        inArray(folders.id, folderIds),
        ne(folders.status, "deleted"),
      ),
    )
    .orderBy(asc(folders.id))
    .for("update");
  if (lockedFolders.length !== folderIds.length) {
    throw new Error("FOLDER_TREE_CHANGED_WHILE_LOCKING");
  }

  const lockedPatterns = await tx
    .select()
    .from(patterns)
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        inArray(patterns.folderId, folderIds),
        ne(patterns.status, "deleted"),
      ),
    )
    .orderBy(asc(patterns.id))
    .for("update");

  return { folders: lockedFolders, patterns: lockedPatterns };
}

export async function trashFolderRows(
  ownerId: string,
  tx: DbTransaction,
  input: TrashTreeUpdate,
) {
  requireSortedUniqueIds(input.ids);
  return tx
    .update(folders)
    .set({
      status: "trashed",
      trashBatchId: input.trashBatchId,
      trashedAt: input.now,
      changeSeq: input.changeSeq,
      version: sql`${folders.version} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(folders.ownerId, ownerId),
        inArray(folders.id, [...input.ids]),
        ne(folders.status, "deleted"),
      ),
    )
    .returning({ id: folders.id });
}

export async function trashPatternRows(
  ownerId: string,
  tx: DbTransaction,
  input: TrashTreeUpdate,
) {
  requireSortedUniqueIds(input.ids);
  return tx
    .update(patterns)
    .set({
      preTrashStatus: sql`case
        when ${patterns.status} = 'trashed'::pattern_status
          then ${patterns.preTrashStatus}
        else ${patterns.status}
      end`,
      status: "trashed",
      trashBatchId: input.trashBatchId,
      trashedAt: input.now,
      changeSeq: input.changeSeq,
      version: sql`${patterns.version} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        inArray(patterns.id, [...input.ids]),
        ne(patterns.status, "deleted"),
      ),
    )
    .returning({ id: patterns.id });
}
