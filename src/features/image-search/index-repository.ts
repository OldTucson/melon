import "server-only";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  notInArray,
  or,
} from "drizzle-orm";
import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import type { DbTransaction } from "@/lib/db/client";
import {
  assets,
  patterns,
  visualSearchDocuments,
  visualSearchJobs,
} from "@/lib/db/schema";

const indexVersionSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
const validDateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const enqueueInputSchema = z.object({
  ownerId: normalizedUuidSchema,
  patternId: normalizedUuidSchema,
  previewAssetId: normalizedUuidSchema,
  indexVersion: indexVersionSchema,
  now: validDateSchema,
});
const backfillCursorSchema = z.object({
  ownerId: normalizedUuidSchema,
  patternId: normalizedUuidSchema,
  previewAssetId: normalizedUuidSchema,
});
const backfillPageSchema = z.object({
  cursor: backfillCursorSchema.optional(),
  limit: z.number().int().min(1).max(500),
});
const deleteInputSchema = z.object({
  ownerId: normalizedUuidSchema,
  patternIds: z.array(normalizedUuidSchema).min(1),
});

const VISUAL_SEARCH_JOB_MAX_ATTEMPTS = 5;

export type VisualSearchBackfillCandidate = z.output<
  typeof backfillCursorSchema
>;

export type VisualSearchBackfillPage = {
  candidates: VisualSearchBackfillCandidate[];
  scanned: number;
  nextCursor: VisualSearchBackfillCandidate | null;
};

export function parseVisualSearchIndexVersion(value: unknown) {
  return indexVersionSchema.parse(value);
}

export async function insertVisualSearchJob(
  tx: DbTransaction,
  rawInput: z.input<typeof enqueueInputSchema>,
) {
  const input = enqueueInputSchema.parse(rawInput);
  const jobId = randomUUID();
  const [inserted] = await tx
    .insert(visualSearchJobs)
    .values({
      id: jobId,
      ownerId: input.ownerId,
      patternId: input.patternId,
      previewAssetId: input.previewAssetId,
      previewHash: null,
      indexVersion: input.indexVersion,
      status: "pending",
      attemptCount: 0,
      maxAttempts: VISUAL_SEARCH_JOB_MAX_ATTEMPTS,
      availableAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({
      target: [
        visualSearchJobs.ownerId,
        visualSearchJobs.patternId,
        visualSearchJobs.previewAssetId,
        visualSearchJobs.indexVersion,
      ],
    })
    .returning({ id: visualSearchJobs.id });

  return inserted
    ? ({ inserted: true, jobId: inserted.id } as const)
    : ({ inserted: false, jobId: null } as const);
}

export async function selectVisualSearchBackfillCandidates(
  tx: DbTransaction,
  rawInput: z.input<typeof backfillPageSchema>,
): Promise<VisualSearchBackfillPage> {
  const input = backfillPageSchema.parse(rawInput);
  // Trashed patterns remain eligible because restore retains their search index.
  const predicates = [
    eq(assets.role, "preview"),
    inArray(patterns.previewStatus, ["ready", "manual"]),
    notInArray(patterns.status, ["deleting", "deleted"]),
  ];

  if (input.cursor) {
    predicates.push(
      or(
        gt(assets.ownerId, input.cursor.ownerId),
        and(
          eq(assets.ownerId, input.cursor.ownerId),
          gt(assets.patternId, input.cursor.patternId),
        ),
        and(
          eq(assets.ownerId, input.cursor.ownerId),
          eq(assets.patternId, input.cursor.patternId),
          gt(assets.id, input.cursor.previewAssetId),
        ),
      )!,
    );
  }

  const scannedCandidates = await tx
    .select({
      ownerId: assets.ownerId,
      patternId: assets.patternId,
      previewAssetId: assets.id,
    })
    .from(assets)
    .innerJoin(
      patterns,
      and(
        eq(patterns.ownerId, assets.ownerId),
        eq(patterns.id, assets.patternId),
      ),
    )
    .where(and(...predicates))
    .orderBy(asc(assets.ownerId), asc(assets.patternId), asc(assets.id))
    .limit(input.limit);

  const nextCursor = scannedCandidates.at(-1) ?? null;
  if (!nextCursor) {
    return { candidates: [], scanned: 0, nextCursor: null };
  }

  const patternIdentities = scannedCandidates.filter(
    (candidate, index, candidates) =>
      index === 0 ||
      candidate.ownerId !== candidates[index - 1]!.ownerId ||
      candidate.patternId !== candidates[index - 1]!.patternId,
  );
  await tx
    .select({ ownerId: patterns.ownerId, patternId: patterns.id })
    .from(patterns)
    .where(
      or(
        ...patternIdentities.map((candidate) =>
          and(
            eq(patterns.ownerId, candidate.ownerId),
            eq(patterns.id, candidate.patternId),
          ),
        ),
      ),
    )
    .orderBy(asc(patterns.ownerId), asc(patterns.id))
    .for("update");

  const candidates = await tx
    .select({
      ownerId: assets.ownerId,
      patternId: assets.patternId,
      previewAssetId: assets.id,
    })
    .from(assets)
    .innerJoin(
      patterns,
      and(
        eq(patterns.ownerId, assets.ownerId),
        eq(patterns.id, assets.patternId),
      ),
    )
    .where(
      and(
        eq(assets.role, "preview"),
        inArray(patterns.previewStatus, ["ready", "manual"]),
        notInArray(patterns.status, ["deleting", "deleted"]),
        or(
          ...scannedCandidates.map((candidate) =>
            and(
              eq(assets.ownerId, candidate.ownerId),
              eq(assets.patternId, candidate.patternId),
              eq(assets.id, candidate.previewAssetId),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(assets.ownerId), asc(assets.patternId), asc(assets.id));

  return {
    candidates,
    scanned: scannedCandidates.length,
    nextCursor,
  };
}

export async function deleteVisualSearchRowsForPatterns(
  tx: DbTransaction,
  rawInput: z.input<typeof deleteInputSchema>,
) {
  const input = deleteInputSchema.parse(rawInput);
  const patternIds = [...new Set(input.patternIds)].sort();
  const deletedJobs = await tx
    .delete(visualSearchJobs)
    .where(
      and(
        eq(visualSearchJobs.ownerId, input.ownerId),
        inArray(visualSearchJobs.patternId, patternIds),
      ),
    )
    .returning({ id: visualSearchJobs.id });
  const deletedDocuments = await tx
    .delete(visualSearchDocuments)
    .where(
      and(
        eq(visualSearchDocuments.ownerId, input.ownerId),
        inArray(visualSearchDocuments.patternId, patternIds),
      ),
    )
    .returning({ id: visualSearchDocuments.id });

  return {
    deletedJobs: deletedJobs.length,
    deletedDocuments: deletedDocuments.length,
  };
}
