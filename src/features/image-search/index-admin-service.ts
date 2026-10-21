import "server-only";

import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { db } from "@/lib/db/client";
import {
  assets,
  patterns,
  visualSearchDocuments,
  visualSearchJobs,
  visualSearchWorkers,
} from "@/lib/db/schema";

import type { ImageSearchIndexStatus } from "./contracts";
import {
  enqueueVisualSearchIndexJob,
  getActiveVisualSearchIndexVersion,
  listVisualSearchBackfillCandidates,
  runVisualSearchBackfill,
} from "./index-service";

const validDateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const WORKER_ONLINE_WINDOW_MS = 45_000;

type IndexStatusRow = {
  eligible: number;
  ready: number;
  pending: number;
  indexing: number;
  failed: number;
  last_seen_at: Date | string | null;
};

function adminContext(ownerId: string, now: Date) {
  return {
    ownerId: normalizedUuidSchema.parse(ownerId),
    now: validDateSchema.parse(now),
    indexVersion: getActiveVisualSearchIndexVersion(),
  };
}

export async function getImageSearchIndexStatus(
  rawOwnerId: string,
  rawNow = new Date(),
): Promise<ImageSearchIndexStatus> {
  const { ownerId, now, indexVersion } = adminContext(rawOwnerId, rawNow);
  const [row] = await db.execute<IndexStatusRow>(sql`
    with eligible as materialized (
      select pattern.id as pattern_id, asset.id as preview_asset_id
      from ${patterns} pattern
      inner join ${assets} asset
        on asset.owner_id = pattern.owner_id
       and asset.pattern_id = pattern.id
       and asset.role = 'preview'
      where pattern.owner_id = ${ownerId}
        and pattern.preview_status in ('ready', 'manual')
        and pattern.status not in ('deleting', 'deleted')
    )
    select
      (select count(*)::integer from eligible) as eligible,
      (select count(*)::integer from eligible item where exists (
        select 1
        from ${visualSearchDocuments} document
        where document.owner_id = ${ownerId}
          and document.pattern_id = item.pattern_id
          and document.preview_asset_id = item.preview_asset_id
          and document.index_version = ${indexVersion}
          and document.status = 'ready'
      )) as ready,
      (select count(*)::integer from eligible item where exists (
        select 1
        from ${visualSearchJobs} job
        where job.owner_id = ${ownerId}
          and job.pattern_id = item.pattern_id
          and job.preview_asset_id = item.preview_asset_id
          and job.index_version = ${indexVersion}
          and job.status = 'pending'
      )) as pending,
      (select count(*)::integer from eligible item where exists (
        select 1
        from ${visualSearchJobs} job
        where job.owner_id = ${ownerId}
          and job.pattern_id = item.pattern_id
          and job.preview_asset_id = item.preview_asset_id
          and job.index_version = ${indexVersion}
          and job.status = 'leased'
      )) as indexing,
      (select count(*)::integer from eligible item where exists (
        select 1
        from ${visualSearchJobs} job
        where job.owner_id = ${ownerId}
          and job.pattern_id = item.pattern_id
          and job.preview_asset_id = item.preview_asset_id
          and job.index_version = ${indexVersion}
          and job.status = 'failed'
      )) as failed,
      (select max(worker.last_seen_at)
       from ${visualSearchWorkers} worker
       where worker.index_version = ${indexVersion}) as last_seen_at
  `);
  if (!row) throw new Error("IMAGE_SEARCH_INDEX_STATUS_MISSING");

  const lastSeenAt =
    row.last_seen_at === null
      ? null
      : validDateSchema.parse(
          row.last_seen_at instanceof Date
            ? row.last_seen_at
            : new Date(row.last_seen_at),
        );
  const worker =
    lastSeenAt === null
      ? "offline"
      : now.getTime() - lastSeenAt.getTime() <= WORKER_ONLINE_WINDOW_MS
        ? "online"
        : "stale";

  return {
    indexVersion,
    eligible: row.eligible,
    ready: row.ready,
    pending: row.pending,
    indexing: row.indexing,
    failed: row.failed,
    worker,
  };
}

export async function retryFailedImageSearchJobs(
  rawOwnerId: string,
  rawNow = new Date(),
) {
  const { ownerId, now, indexVersion } = adminContext(rawOwnerId, rawNow);
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({
        id: visualSearchJobs.id,
        ownerId: visualSearchJobs.ownerId,
        patternId: visualSearchJobs.patternId,
        previewAssetId: visualSearchJobs.previewAssetId,
      })
      .from(visualSearchJobs)
      .innerJoin(
        assets,
        and(
          eq(assets.ownerId, visualSearchJobs.ownerId),
          eq(assets.patternId, visualSearchJobs.patternId),
          eq(assets.id, visualSearchJobs.previewAssetId),
          eq(assets.role, "preview"),
        ),
      )
      .innerJoin(
        patterns,
        and(
          eq(patterns.ownerId, visualSearchJobs.ownerId),
          eq(patterns.id, visualSearchJobs.patternId),
          inArray(patterns.previewStatus, ["ready", "manual"]),
          notInArray(patterns.status, ["deleting", "deleted"]),
        ),
      )
      .where(
        and(
          eq(visualSearchJobs.ownerId, ownerId),
          eq(visualSearchJobs.indexVersion, indexVersion),
          eq(visualSearchJobs.status, "failed"),
        ),
      )
      .orderBy(asc(visualSearchJobs.createdAt), asc(visualSearchJobs.id))
      .for("update");

    if (candidates.length === 0) return { enqueued: 0 };

    await tx.delete(visualSearchJobs).where(
      and(
        eq(visualSearchJobs.ownerId, ownerId),
        inArray(
          visualSearchJobs.id,
          candidates.map((candidate) => candidate.id),
        ),
      ),
    );

    for (const candidate of candidates) {
      const result = await enqueueVisualSearchIndexJob(tx, {
        ownerId: candidate.ownerId,
        patternId: candidate.patternId,
        previewAssetId: candidate.previewAssetId,
        indexVersion,
        now,
      });
      if (!result.inserted) {
        throw new Error("IMAGE_SEARCH_RETRY_ENQUEUE_CONFLICT");
      }
    }

    return { enqueued: candidates.length };
  });
}

export async function rebuildImageSearchIndex(
  rawOwnerId: string,
  rawNow = new Date(),
) {
  const { ownerId, now, indexVersion } = adminContext(rawOwnerId, rawNow);
  const result = await runVisualSearchBackfill({
    ownerId,
    version: indexVersion,
    services: {
      transaction: (work) => db.transaction(work),
      listCandidates: listVisualSearchBackfillCandidates,
      enqueue: enqueueVisualSearchIndexJob,
    },
    now: () => now,
  });
  return {
    enqueued: result.inserted,
    alreadyExisting: result.alreadyExisting,
  };
}
