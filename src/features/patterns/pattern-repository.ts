import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  getTableColumns,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db, type DbTransaction } from "@/lib/db/client";
import { assets, folders, patterns, patternTags } from "@/lib/db/schema";

import type { PatternPatch, PatternQuery } from "./contracts";
import type { PatternCursor } from "./pattern-cursor";

export type PatternRow = typeof patterns.$inferSelect;
export type PatternRowWithAssets = PatternRow & {
  previewAssetId: string | null;
  thumbnailAssetId: string | null;
  sourceAssetId: string | null;
};

const previewAssets = alias(assets, "preview_assets");
const thumbnailAssets = alias(assets, "thumbnail_assets");
const sourceAssets = alias(assets, "source_assets");
const visiblePatternFolders = alias(folders, "visible_pattern_folders");
const recursiveFolders = alias(folders, "recursive_folders");
const libraryStatuses: PatternRow["status"][] = [
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
];
const trashStatuses: PatternRow["status"][] = ["trashed", "deleting"];
const libraryFolderStatuses = ["active"] as const;
const trashFolderStatuses = ["active", "trashed", "deleting"] as const;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

function cursorPredicate(cursor: PatternCursor): SQL {
  if (cursor.sort === "updated_desc") {
    return or(
      sql`${patterns.updatedAt} < ${cursor.value}::timestamptz`,
      and(
        sql`${patterns.updatedAt} = ${cursor.value}::timestamptz`,
        lt(patterns.id, cursor.id),
      ),
    )!;
  }
  if (cursor.sort === "created_desc") {
    return or(
      sql`${patterns.createdAt} < ${cursor.value}::timestamptz`,
      and(
        sql`${patterns.createdAt} = ${cursor.value}::timestamptz`,
        lt(patterns.id, cursor.id),
      ),
    )!;
  }
  if (cursor.sort === "name_asc") {
    return or(
      gt(patterns.name, cursor.value),
      and(eq(patterns.name, cursor.value), gt(patterns.id, cursor.id)),
    )!;
  }

  const value = BigInt(cursor.value);
  return or(
    lt(patterns.sizeBytes, value),
    and(eq(patterns.sizeBytes, value), lt(patterns.id, cursor.id)),
  )!;
}

function sortOrder(sort: PatternQuery["sort"]) {
  if (sort === "created_desc") {
    return [desc(patterns.createdAt), desc(patterns.id)] as const;
  }
  if (sort === "name_asc") {
    return [asc(patterns.name), asc(patterns.id)] as const;
  }
  if (sort === "size_desc") {
    return [desc(patterns.sizeBytes), desc(patterns.id)] as const;
  }
  return [desc(patterns.updatedAt), desc(patterns.id)] as const;
}

export async function listPatternRows(
  ownerId: string,
  query: PatternQuery,
  cursor: PatternCursor | undefined,
) {
  const folderStatuses =
    query.scope === "trash" ? trashFolderStatuses : libraryFolderStatuses;
  const predicates: SQL[] = [
    eq(patterns.ownerId, ownerId),
    inArray(
      patterns.status,
      query.scope === "trash" ? trashStatuses : libraryStatuses,
    ),
    or(
      isNull(patterns.folderId),
      exists(
        db
          .select({ value: sql`1` })
          .from(visiblePatternFolders)
          .where(
            and(
              eq(visiblePatternFolders.ownerId, ownerId),
              eq(visiblePatternFolders.id, patterns.folderId),
              inArray(visiblePatternFolders.status, folderStatuses),
            ),
          ),
      ),
    )!,
  ];

  if (query.unfiled) {
    predicates.push(isNull(patterns.folderId));
  } else if (query.folderId) {
    if (query.includeDescendants) {
      predicates.push(sql`${patterns.folderId} in (
        with recursive folder_scope(owner_id, id) as (
          select ${folders.ownerId}, ${folders.id}
          from ${folders}
          where ${folders.ownerId} = ${ownerId}
            and ${folders.id} = ${query.folderId}
            and ${inArray(folders.status, folderStatuses)}
          union
          select ${recursiveFolders.ownerId}, ${recursiveFolders.id}
          from ${folders} as recursive_folders
          inner join folder_scope as parent
            on ${recursiveFolders.ownerId} = parent.owner_id
           and ${recursiveFolders.parentId} = parent.id
          where ${recursiveFolders.ownerId} = ${ownerId}
            and parent.owner_id = ${ownerId}
            and ${inArray(recursiveFolders.status, folderStatuses)}
        )
        select id
        from folder_scope
        where owner_id = ${ownerId}
      )`);
    } else {
      predicates.push(eq(patterns.folderId, query.folderId));
    }
  }

  if (query.q) {
    const contains = `%${escapeLike(query.q)}%`;
    predicates.push(
      or(
        sql`${patterns.name} ilike ${contains} escape '\\'`,
        sql`${patterns.originalFilename} ilike ${contains} escape '\\'`,
      )!,
    );
  }
  if (query.formats.length > 0) {
    predicates.push(inArray(patterns.extension, query.formats));
  }
  if (query.favorite !== undefined) {
    predicates.push(eq(patterns.isFavorite, query.favorite));
  }
  if (query.previewStatus) {
    predicates.push(eq(patterns.previewStatus, query.previewStatus));
  }
  if (query.untagged) {
    predicates.push(
      notExists(
        db
          .select({ value: sql`1` })
          .from(patternTags)
          .where(
            and(
              eq(patternTags.ownerId, ownerId),
              eq(patternTags.patternId, patterns.id),
              eq(patternTags.isActive, true),
            ),
          ),
      ),
    );
  }
  if (query.tagIds.length > 0) {
    const ownedActiveRelations = and(
      eq(patternTags.ownerId, ownerId),
      eq(patternTags.patternId, patterns.id),
      eq(patternTags.isActive, true),
      inArray(patternTags.tagId, query.tagIds),
    );

    if (query.tagMode === "any") {
      predicates.push(
        exists(
          db
            .select({ value: sql`1` })
            .from(patternTags)
            .where(ownedActiveRelations),
        ),
      );
    } else {
      const allTags = db
        .select({ patternId: patternTags.patternId })
        .from(patternTags)
        .where(ownedActiveRelations)
        .groupBy(patternTags.patternId)
        .having(
          sql`count(distinct ${patternTags.tagId}) = ${query.tagIds.length}`,
        );
      predicates.push(inArray(patterns.id, allTags));
    }
  }
  if (cursor) predicates.push(cursorPredicate(cursor));

  return db
    .select({
      ...getTableColumns(patterns),
      previewAssetId: previewAssets.id,
      thumbnailAssetId: thumbnailAssets.id,
      sourceAssetId: sourceAssets.id,
      updatedCursorValue: sql<string>`to_char(${patterns.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      createdCursorValue: sql<string>`to_char(${patterns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
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
    .leftJoin(
      sourceAssets,
      and(
        eq(sourceAssets.ownerId, ownerId),
        eq(sourceAssets.patternId, patterns.id),
        eq(sourceAssets.role, "source"),
      ),
    )
    .where(and(...predicates))
    .orderBy(...sortOrder(query.sort))
    .limit(query.limit + 1);
}

export async function getPatternRow(
  ownerId: string,
  patternId: string,
  tx?: DbTransaction,
) {
  const executor = tx ?? db;
  const [row] = await executor
    .select({
      ...getTableColumns(patterns),
      previewAssetId: previewAssets.id,
      thumbnailAssetId: thumbnailAssets.id,
      sourceAssetId: sourceAssets.id,
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
    .leftJoin(
      sourceAssets,
      and(
        eq(sourceAssets.ownerId, ownerId),
        eq(sourceAssets.patternId, patterns.id),
        eq(sourceAssets.role, "source"),
      ),
    )
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.id, patternId),
        ne(patterns.status, "deleted"),
      ),
    )
    .limit(1);
  return row;
}

export async function lockPatternRow(
  ownerId: string,
  tx: DbTransaction,
  patternId: string,
) {
  const [row] = await tx
    .select()
    .from(patterns)
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.id, patternId),
        notInArray(patterns.status, ["deleting", "deleted"]),
      ),
    )
    .limit(1)
    .for("update");
  return row;
}

export async function updatePatternRow(
  ownerId: string,
  tx: DbTransaction,
  input: {
    patternId: string;
    patch: PatternPatch;
    changeSeq: bigint;
    updatedAt: Date;
  },
) {
  const [updated] = await tx
    .update(patterns)
    .set({
      ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
      ...(input.patch.isFavorite === undefined
        ? {}
        : { isFavorite: input.patch.isFavorite }),
      version: sql`${patterns.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.updatedAt,
    })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.id, input.patternId),
        eq(patterns.version, input.patch.version),
        notInArray(patterns.status, ["deleting", "deleted"]),
      ),
    )
    .returning();
  return updated;
}
