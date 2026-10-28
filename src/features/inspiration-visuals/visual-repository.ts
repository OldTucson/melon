import "server-only";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  isNotNull,
  lt,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getActiveVisualSearchIndexVersion } from "@/features/image-search/index-service";
import { loadPatternPaletteStates } from "@/features/patterns/pattern-palette-repository";
import { db } from "@/lib/db/client";
import {
  assets as storageAssets,
  inspirationVisualAssets as visualAssets,
  inspirationVisualJobs as visualJobs,
  patterns,
} from "@/lib/db/schema";

import type { VisualJobErrorCode, VisualWarning } from "./contracts";

export type VisualJobRow = typeof visualJobs.$inferSelect;
export type VisualAssetRow = typeof visualAssets.$inferSelect;
export type NewVisualAsset = Omit<
  typeof visualAssets.$inferInsert,
  "id" | "ownerId" | "analysisId" | "jobId" | "createdAt"
>;

export type VisibleVisualAssetRow = VisualAssetRow & {
  imageAssetId: string | null;
  palette: string[];
};

const thumbnailAssets = alias(storageAssets, "inspiration_thumbnail_assets");
const previewAssets = alias(storageAssets, "inspiration_preview_assets");

const ownedJob = (ownerId: string, jobId: string) =>
  and(eq(visualJobs.ownerId, ownerId), eq(visualJobs.id, jobId));

export async function createPendingResearchJob(input: {
  id: string;
  ownerId: string;
  analysisId: string;
  operationId: string;
  now: Date;
}) {
  const [row] = await db
    .insert(visualJobs)
    .values({
      id: input.id,
      ownerId: input.ownerId,
      analysisId: input.analysisId,
      operationId: input.operationId,
      kind: "research_visuals",
      directionIndex: null,
      status: "pending",
      warnings: [],
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return row;
}

export async function findJobByOperation(
  ownerId: string,
  operationId: string,
) {
  const [row] = await db
    .select()
    .from(visualJobs)
    .where(
      and(
        eq(visualJobs.ownerId, ownerId),
        eq(visualJobs.operationId, operationId),
      ),
    )
    .limit(1);
  return row;
}

export async function findLatestCompletedResearchJob(
  ownerId: string,
  analysisId: string,
) {
  const [row] = await db
    .select()
    .from(visualJobs)
    .where(
      and(
        eq(visualJobs.ownerId, ownerId),
        eq(visualJobs.analysisId, analysisId),
        eq(visualJobs.kind, "research_visuals"),
        eq(visualJobs.status, "completed"),
      ),
    )
    .orderBy(desc(visualJobs.createdAt), desc(visualJobs.id))
    .limit(1);
  return row;
}

export async function findLatestResearchRefreshJob(
  ownerId: string,
  analysisId: string,
) {
  const [row] = await db
    .select()
    .from(visualJobs)
    .where(
      and(
        eq(visualJobs.ownerId, ownerId),
        eq(visualJobs.analysisId, analysisId),
        eq(visualJobs.kind, "research_visuals"),
        ne(visualJobs.status, "completed"),
      ),
    )
    .orderBy(desc(visualJobs.createdAt), desc(visualJobs.id))
    .limit(1);
  return row;
}

export async function completeResearchJob(
  ownerId: string,
  jobId: string,
  assets: readonly NewVisualAsset[],
  warnings: readonly VisualWarning[],
  completedAt: Date,
) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .update(visualJobs)
      .set({
        status: "completed",
        warnings: [...warnings],
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          ownedJob(ownerId, jobId),
          eq(visualJobs.kind, "research_visuals"),
          eq(visualJobs.status, "pending"),
        ),
      )
      .returning();
    if (!job) return undefined;

    if (assets.length > 0) {
      await tx.insert(visualAssets).values(
        assets.map((asset) => ({
          ...asset,
          id: randomUUID(),
          ownerId: job.ownerId,
          analysisId: job.analysisId,
          jobId: job.id,
          createdAt: completedAt,
        })),
      );
    }
    return job;
  });
}

export async function failPendingJob(
  ownerId: string,
  jobId: string,
  errorCode: VisualJobErrorCode,
  completedAt: Date,
  warnings: readonly VisualWarning[] = [],
) {
  const [row] = await db
    .update(visualJobs)
    .set({
      status: "failed",
      warnings: [...warnings],
      errorCode,
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        ownedJob(ownerId, jobId),
        eq(visualJobs.status, "pending"),
      ),
    )
    .returning();
  return row;
}

export function failStaleResearchJobs(
  ownerId: string,
  analysisId: string,
  cutoff: Date,
  now = new Date(),
) {
  return db
    .update(visualJobs)
    .set({
      status: "failed",
      errorCode: "INSPIRATION_VISUALS_INTERRUPTED",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(visualJobs.ownerId, ownerId),
        eq(visualJobs.analysisId, analysisId),
        eq(visualJobs.kind, "research_visuals"),
        eq(visualJobs.status, "pending"),
        lt(visualJobs.updatedAt, cutoff),
      ),
    )
    .returning();
}

export async function listVisibleAssets(ownerId: string, jobId: string) {
  const rows = await db
    .select({
      ...getTableColumns(visualAssets),
      thumbnailAssetId: thumbnailAssets.id,
      previewAssetId: previewAssets.id,
    })
    .from(visualAssets)
    .leftJoin(
      patterns,
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.id, visualAssets.patternId),
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
      previewAssets,
      and(
        eq(previewAssets.ownerId, ownerId),
        eq(previewAssets.patternId, patterns.id),
        eq(previewAssets.role, "preview"),
      ),
    )
    .where(
      and(
        eq(visualAssets.ownerId, ownerId),
        eq(visualAssets.jobId, jobId),
        or(
          ne(visualAssets.kind, "library_match"),
          and(
            eq(visualAssets.kind, "library_match"),
            notInArray(patterns.status, ["trashed", "deleting", "deleted"]),
            or(isNotNull(thumbnailAssets.id), isNotNull(previewAssets.id)),
          ),
        ),
      ),
    )
    .orderBy(asc(visualAssets.ordinal), asc(visualAssets.id));

  const patternIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.kind === "library_match" && row.patternId ? [row.patternId] : [],
      ),
    ),
  ];
  const paletteStates = await loadPatternPaletteStates({
    ownerId,
    patternIds,
    indexVersion: getActiveVisualSearchIndexVersion(),
  });

  return rows.map(
    ({ thumbnailAssetId, previewAssetId, ...row }): VisibleVisualAssetRow => ({
      ...row,
      imageAssetId: thumbnailAssetId ?? previewAssetId,
      palette:
        row.patternId === null
          ? []
          : (paletteStates.get(row.patternId)?.palette.map(({ hex }) => hex) ??
            []),
    }),
  );
}
