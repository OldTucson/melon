import "server-only";

import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import type { DbTransaction } from "@/lib/db/client";
import { assets, patterns } from "@/lib/db/schema";

export type PatternBatchRow = typeof patterns.$inferSelect;
export type PatternBatchRowWithAssets = PatternBatchRow & {
  previewAssetId: string | null;
  thumbnailAssetId: string | null;
  sourceAssetId: string | null;
};

type PatternBatchUpdate = {
  patternIds: readonly string[];
  changeSeq: bigint;
  updatedAt: Date;
} & (
  | { action: "move"; folderId: string | null }
  | { action: "favorite"; isFavorite: boolean }
  | { action: "trash"; trashBatchId: string; trashedAt: Date }
);

const previewAssets = alias(assets, "batch_preview_assets");
const thumbnailAssets = alias(assets, "batch_thumbnail_assets");
const sourceAssets = alias(assets, "batch_source_assets");

function assertSortedUniqueNormalizedPatternIds(
  patternIds: readonly string[],
) {
  if (patternIds.length === 0) {
    throw new Error("PATTERN_IDS_MUST_BE_SORTED_UNIQUE_NORMALIZED");
  }

  let previous: string | undefined;
  for (const patternId of patternIds) {
    const parsed = normalizedUuidSchema.safeParse(patternId);
    if (
      !parsed.success ||
      parsed.data !== patternId ||
      (previous !== undefined && previous >= patternId)
    ) {
      throw new Error("PATTERN_IDS_MUST_BE_SORTED_UNIQUE_NORMALIZED");
    }
    previous = patternId;
  }
}

export async function lockPatternRows(
  ownerId: string,
  tx: DbTransaction,
  patternIds: readonly string[],
) {
  assertSortedUniqueNormalizedPatternIds(patternIds);
  return tx
    .select()
    .from(patterns)
    .where(
      and(eq(patterns.ownerId, ownerId), inArray(patterns.id, patternIds)),
    )
    .orderBy(asc(patterns.id))
    .for("update");
}

export async function updatePatternRows(
  ownerId: string,
  tx: DbTransaction,
  input: PatternBatchUpdate,
) {
  assertSortedUniqueNormalizedPatternIds(input.patternIds);
  const actionPatch =
    input.action === "move"
      ? { folderId: input.folderId }
      : input.action === "favorite"
        ? { isFavorite: input.isFavorite }
        : {
            status: "trashed" as const,
            preTrashStatus: sql`${patterns.status}`,
            trashBatchId: input.trashBatchId,
            trashedAt: input.trashedAt,
          };

  const rows = await tx
    .update(patterns)
    .set({
      ...actionPatch,
      version: sql`${patterns.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.updatedAt,
    })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        inArray(patterns.id, input.patternIds),
      ),
    )
    .returning();

  return rows.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

export async function listPatternBatchRows(
  ownerId: string,
  tx: DbTransaction,
  patternIds: readonly string[],
): Promise<PatternBatchRowWithAssets[]> {
  assertSortedUniqueNormalizedPatternIds(patternIds);
  return tx
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
      and(eq(patterns.ownerId, ownerId), inArray(patterns.id, patternIds)),
    )
    .orderBy(asc(patterns.id));
}
