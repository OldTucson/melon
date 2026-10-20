import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import {
  assets,
  patterns,
  users,
  visualSearchDocuments,
  visualSearchJobs,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

import {
  ACTIVE_VISUAL_SEARCH_INDEX_VERSION,
  enqueueVisualSearchIndexJob,
  listVisualSearchBackfillCandidates,
} from "./index-service";

const NOW = new Date("2026-10-20T08:00:00.000Z");

async function seedUser(email: string) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email,
    displayName: email,
    passwordHash: "test-password-hash",
    mustChangePassword: false,
  });
  return id;
}

async function seedPatternWithPreview(input: {
  ownerId: string;
  status?: (typeof patterns.$inferInsert)["status"];
  previewStatus?: (typeof patterns.$inferInsert)["previewStatus"];
  role?: (typeof assets.$inferInsert)["role"];
}) {
  const patternId = randomUUID();
  const assetId = randomUUID();
  await db.insert(patterns).values({
    id: patternId,
    ownerId: input.ownerId,
    name: patternId,
    originalFilename: `${patternId}.psd`,
    extension: "psd",
    sizeBytes: 12n,
    status: input.status ?? "ready",
    previewStatus: input.previewStatus ?? "ready",
  });
  await db.insert(assets).values({
    id: assetId,
    ownerId: input.ownerId,
    patternId,
    role: input.role ?? "preview",
    objectKey: `users/${input.ownerId}/patterns/${patternId}/${assetId}.webp`,
    originalFilename: `${input.role ?? "preview"}.webp`,
    sizeBytes: 12n,
  });
  return { patternId, assetId };
}

describe("visual search index service", () => {
  beforeEach(async () => resetDatabase());
  afterAll(async () => closeDatabase());

  it("enqueues one canonical pending job and reports conflict-driven idempotency", async () => {
    const ownerId = await seedUser("index-job@example.test");
    const { patternId, assetId } = await seedPatternWithPreview({ ownerId });

    const first = await db.transaction((tx) =>
      enqueueVisualSearchIndexJob(tx, {
        ownerId: ownerId.toUpperCase(),
        patternId: patternId.toUpperCase(),
        previewAssetId: assetId.toUpperCase(),
        indexVersion: ACTIVE_VISUAL_SEARCH_INDEX_VERSION,
        now: NOW,
      }),
    );
    const replay = await db.transaction((tx) =>
      enqueueVisualSearchIndexJob(tx, {
        ownerId,
        patternId,
        previewAssetId: assetId,
        indexVersion: ACTIVE_VISUAL_SEARCH_INDEX_VERSION,
        now: NOW,
      }),
    );

    expect(first).toEqual({ inserted: true, jobId: expect.any(String) });
    expect(replay).toEqual({ inserted: false, jobId: null });
    const rows = await db
      .select()
      .from(visualSearchJobs)
      .orderBy(asc(visualSearchJobs.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId,
      patternId,
      previewAssetId: assetId,
      previewHash: null,
      indexVersion: "visual-search-v1",
      status: "pending",
      attemptCount: 0,
      maxAttempts: 5,
      availableAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("leaves commit control with the caller transaction", async () => {
    const ownerId = await seedUser("index-rollback@example.test");
    const { patternId, assetId } = await seedPatternWithPreview({ ownerId });

    await expect(
      db.transaction(async (tx) => {
        await enqueueVisualSearchIndexJob(tx, {
          ownerId,
          patternId,
          previewAssetId: assetId,
          indexVersion: ACTIVE_VISUAL_SEARCH_INDEX_VERSION,
          now: NOW,
        });
        throw new Error("ROLL_BACK_CALLER_TRANSACTION");
      }),
    ).rejects.toThrow("ROLL_BACK_CALLER_TRANSACTION");
    expect(await db.select().from(visualSearchJobs)).toEqual([]);
  });

  it.each([
    { ownerId: "not-a-uuid" },
    { patternId: "not-a-uuid" },
    { previewAssetId: "not-a-uuid" },
    { indexVersion: "Visual-Search-V1" },
    { indexVersion: "visual_search_v1" },
    { indexVersion: "x".repeat(65) },
    { now: new Date(Number.NaN) },
  ])("rejects invalid enqueue input %# without writing", async (override) => {
    const ownerId = await seedUser(`invalid-${randomUUID()}@example.test`);
    const { patternId, assetId } = await seedPatternWithPreview({ ownerId });

    await expect(
      db.transaction((tx) =>
        enqueueVisualSearchIndexJob(tx, {
          ownerId,
          patternId,
          previewAssetId: assetId,
          indexVersion: ACTIVE_VISUAL_SEARCH_INDEX_VERSION,
          now: NOW,
          ...override,
        }),
      ),
    ).rejects.toBeDefined();
    expect(await db.select().from(visualSearchJobs)).toEqual([]);
  });

  it("rejects a cross-owner job without creating an orphan", async () => {
    const ownerId = await seedUser("index-owner@example.test");
    const otherOwnerId = await seedUser("index-other@example.test");
    const { patternId, assetId } = await seedPatternWithPreview({ ownerId });

    await expect(
      db.transaction((tx) =>
        enqueueVisualSearchIndexJob(tx, {
          ownerId: otherOwnerId,
          patternId,
          previewAssetId: assetId,
          indexVersion: ACTIVE_VISUAL_SEARCH_INDEX_VERSION,
          now: NOW,
        }),
      ),
    ).rejects.toBeDefined();
    expect(await db.select().from(visualSearchJobs)).toEqual([]);
  });

  it("selects ready and manual previews across owners while preserving trash", async () => {
    const ownerA = await seedUser("backfill-a@example.test");
    const ownerB = await seedUser("backfill-b@example.test");
    const ready = await seedPatternWithPreview({ ownerId: ownerA });
    const manual = await seedPatternWithPreview({
      ownerId: ownerA,
      previewStatus: "manual",
    });
    const trashed = await seedPatternWithPreview({
      ownerId: ownerB,
      status: "trashed",
    });
    const processing = await seedPatternWithPreview({
      ownerId: ownerA,
      status: "processing",
    });
    await seedPatternWithPreview({ ownerId: ownerA, previewStatus: "pending" });
    await seedPatternWithPreview({ ownerId: ownerA, previewStatus: "failed" });
    await seedPatternWithPreview({
      ownerId: ownerA,
      previewStatus: "unsupported",
    });
    await seedPatternWithPreview({ ownerId: ownerA, status: "deleting" });
    await seedPatternWithPreview({ ownerId: ownerB, status: "deleted" });
    await seedPatternWithPreview({ ownerId: ownerB, role: "thumbnail" });

    const firstPage = await db.transaction((tx) =>
      listVisualSearchBackfillCandidates(tx, { limit: 2 }),
    );
    const secondPage = await db.transaction((tx) =>
      listVisualSearchBackfillCandidates(tx, {
        limit: 2,
        cursor: firstPage.at(-1),
      }),
    );
    const rows = [...firstPage, ...secondPage];

    expect(rows).toEqual(
      [ready, manual, trashed, processing]
        .map(({ patternId, assetId }, index) => ({
          ownerId: index === 2 ? ownerB : ownerA,
          patternId,
          previewAssetId: assetId,
        }))
        .sort((left, right) =>
          `${left.ownerId}:${left.patternId}:${left.previewAssetId}`.localeCompare(
            `${right.ownerId}:${right.patternId}:${right.previewAssetId}`,
          ),
        ),
    );
    expect(rows).toContainEqual({
      ownerId: ownerB,
      patternId: trashed.patternId,
      previewAssetId: trashed.assetId,
    });
  });

  it("does not return an existing job for a different index version", async () => {
    const ownerId = await seedUser("backfill-version@example.test");
    const { patternId, assetId } = await seedPatternWithPreview({ ownerId });
    const documentId = randomUUID();
    await db.insert(visualSearchDocuments).values({
      id: documentId,
      ownerId,
      patternId,
      previewAssetId: assetId,
      previewHash: "a".repeat(64),
      indexVersion: "visual-search-old",
      status: "ready",
    });
    await db.transaction((tx) =>
      enqueueVisualSearchIndexJob(tx, {
        ownerId,
        patternId,
        previewAssetId: assetId,
        indexVersion: "visual-search-old",
        now: NOW,
      }),
    );

    await db.transaction((tx) =>
      enqueueVisualSearchIndexJob(tx, {
        ownerId,
        patternId,
        previewAssetId: assetId,
        indexVersion: ACTIVE_VISUAL_SEARCH_INDEX_VERSION,
        now: NOW,
      }),
    );

    const jobs = await db
      .select()
      .from(visualSearchJobs)
      .where(eq(visualSearchJobs.patternId, patternId));
    expect(jobs.map((job) => job.indexVersion).sort()).toEqual([
      "visual-search-old",
      "visual-search-v1",
    ]);
    expect(await db.select().from(visualSearchDocuments)).toEqual([
      expect.objectContaining({
        id: documentId,
        indexVersion: "visual-search-old",
        status: "ready",
      }),
    ]);
  });
});
