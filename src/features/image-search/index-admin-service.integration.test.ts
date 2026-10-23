import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import {
  assets,
  patterns,
  users,
  visualSearchDocuments,
  visualSearchJobs,
  visualSearchWorkers,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

import {
  getImageSearchIndexStatus,
  rebuildImageSearchIndex,
  retryFailedImageSearchJobs,
} from "./index-admin-service";

const NOW = new Date("2026-10-20T08:00:00.000Z");
const INDEX_VERSION = "visual-search-v2";

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

async function seedPattern(input: {
  ownerId: string;
  status?: (typeof patterns.$inferInsert)["status"];
  previewStatus?: (typeof patterns.$inferInsert)["previewStatus"];
}) {
  const patternId = randomUUID();
  const previewAssetId = randomUUID();
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
    id: previewAssetId,
    ownerId: input.ownerId,
    patternId,
    role: "preview",
    objectKey: `users/${input.ownerId}/patterns/${patternId}/${previewAssetId}.webp`,
    originalFilename: "preview.webp",
    sizeBytes: 12n,
  });
  return { patternId, previewAssetId };
}

async function seedDocument(input: {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
  status?: (typeof visualSearchDocuments.$inferInsert)["status"];
  indexVersion?: string;
}) {
  await db.insert(visualSearchDocuments).values({
    id: randomUUID(),
    ownerId: input.ownerId,
    patternId: input.patternId,
    previewAssetId: input.previewAssetId,
    previewHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    indexVersion: input.indexVersion ?? INDEX_VERSION,
    status: input.status ?? "ready",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedJob(input: {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
  status: (typeof visualSearchJobs.$inferInsert)["status"];
  indexVersion?: string;
}) {
  const id = randomUUID();
  await db.insert(visualSearchJobs).values({
    id,
    ownerId: input.ownerId,
    patternId: input.patternId,
    previewAssetId: input.previewAssetId,
    indexVersion: input.indexVersion ?? INDEX_VERSION,
    status: input.status,
    attemptCount: input.status === "failed" ? 5 : 0,
    availableAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

describe("image search index admin service", () => {
  beforeEach(async () => resetDatabase());
  afterAll(async () => closeDatabase());

  it("reports current-preview counts for one owner and classifies heartbeat freshness", async () => {
    const ownerA = await seedUser("index-admin-a@example.test");
    const ownerB = await seedUser("index-admin-b@example.test");
    const readyA = await seedPattern({ ownerId: ownerA });
    const readyB = await seedPattern({ ownerId: ownerA });
    const pending = await seedPattern({ ownerId: ownerA });
    const failed = await seedPattern({ ownerId: ownerA });
    const stale = await seedPattern({
      ownerId: ownerA,
      previewStatus: "pending",
    });
    const foreign = await seedPattern({ ownerId: ownerB });

    await seedDocument({ ownerId: ownerA, ...readyA });
    await seedDocument({ ownerId: ownerA, ...readyB });
    await seedDocument({ ownerId: ownerA, ...stale });
    await seedDocument({
      ownerId: ownerA,
      ...pending,
      indexVersion: "visual-search-v0",
    });
    await seedDocument({ ownerId: ownerB, ...foreign });
    const pendingJobId = await seedJob({
      ownerId: ownerA,
      ...pending,
      status: "pending",
    });
    await seedJob({ ownerId: ownerA, ...failed, status: "failed" });
    await seedJob({ ownerId: ownerB, ...foreign, status: "failed" });
    await db.insert(visualSearchWorkers).values({
      workerId: "worker-current",
      indexVersion: INDEX_VERSION,
      lastSeenAt: new Date(NOW.getTime() - 45_000),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(visualSearchWorkers).values({
      workerId: "worker-old-version",
      indexVersion: "visual-search-v0",
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(getImageSearchIndexStatus(ownerA, NOW)).resolves.toEqual({
      indexVersion: INDEX_VERSION,
      eligible: 4,
      ready: 2,
      pending: 1,
      indexing: 0,
      failed: 1,
      worker: "online",
    });

    await db
      .update(visualSearchJobs)
      .set({ status: "leased" })
      .where(eq(visualSearchJobs.id, pendingJobId));
    await expect(getImageSearchIndexStatus(ownerA, NOW)).resolves.toMatchObject(
      {
        pending: 0,
        indexing: 1,
      },
    );

    await db
      .update(visualSearchWorkers)
      .set({ lastSeenAt: new Date(NOW.getTime() - 45_001) })
      .where(eq(visualSearchWorkers.workerId, "worker-current"));
    expect((await getImageSearchIndexStatus(ownerA, NOW)).worker).toBe("stale");

    await db
      .delete(visualSearchWorkers)
      .where(eq(visualSearchWorkers.indexVersion, INDEX_VERSION));
    expect((await getImageSearchIndexStatus(ownerA, NOW)).worker).toBe(
      "offline",
    );
  });

  it("retries only failed jobs for the owner's eligible current previews with a new identity", async () => {
    const ownerA = await seedUser("index-retry-a@example.test");
    const ownerB = await seedUser("index-retry-b@example.test");
    const retryable = await seedPattern({ ownerId: ownerA });
    const completed = await seedPattern({ ownerId: ownerA });
    const oldVersion = await seedPattern({ ownerId: ownerA });
    const ineligible = await seedPattern({
      ownerId: ownerA,
      status: "deleted",
    });
    const foreign = await seedPattern({ ownerId: ownerB });
    const oldFailedId = await seedJob({
      ownerId: ownerA,
      ...retryable,
      status: "failed",
    });
    const completedId = await seedJob({
      ownerId: ownerA,
      ...completed,
      status: "complete",
    });
    await seedJob({
      ownerId: ownerA,
      ...oldVersion,
      status: "failed",
      indexVersion: "visual-search-v0",
    });
    await seedJob({ ownerId: ownerA, ...ineligible, status: "failed" });
    await seedJob({ ownerId: ownerB, ...foreign, status: "failed" });

    await expect(retryFailedImageSearchJobs(ownerA, NOW)).resolves.toEqual({
      enqueued: 1,
    });

    const ownerJobs = await db
      .select()
      .from(visualSearchJobs)
      .where(eq(visualSearchJobs.ownerId, ownerA));
    const replacement = ownerJobs.find(
      (job) => job.patternId === retryable.patternId,
    );
    expect(replacement).toMatchObject({
      status: "pending",
      attemptCount: 0,
      lastErrorCode: null,
      availableAt: NOW,
    });
    expect(replacement?.id).not.toBe(oldFailedId);
    expect(ownerJobs).toContainEqual(
      expect.objectContaining({ id: completedId, status: "complete" }),
    );
    expect(ownerJobs).toContainEqual(
      expect.objectContaining({
        patternId: oldVersion.patternId,
        indexVersion: "visual-search-v0",
        status: "failed",
      }),
    );
    expect(ownerJobs).toContainEqual(
      expect.objectContaining({
        patternId: ineligible.patternId,
        status: "failed",
      }),
    );
    expect(
      await db
        .select()
        .from(visualSearchJobs)
        .where(
          and(
            eq(visualSearchJobs.ownerId, ownerB),
            eq(visualSearchJobs.status, "failed"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("rebuilds only one owner's eligible previews through an idempotent paged enqueue", async () => {
    const ownerA = await seedUser("index-rebuild-a@example.test");
    const ownerB = await seedUser("index-rebuild-b@example.test");
    const alreadyReady = await seedPattern({ ownerId: ownerA });
    await seedPattern({ ownerId: ownerA, status: "trashed" });
    await seedPattern({ ownerId: ownerA, previewStatus: "failed" });
    await seedPattern({ ownerId: ownerB });
    await seedDocument({ ownerId: ownerA, ...alreadyReady });

    await expect(rebuildImageSearchIndex(ownerA, NOW)).resolves.toEqual({
      enqueued: 2,
      alreadyExisting: 0,
    });
    await expect(rebuildImageSearchIndex(ownerA, NOW)).resolves.toEqual({
      enqueued: 0,
      alreadyExisting: 2,
    });

    const jobs = await db.select().from(visualSearchJobs);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.ownerId === ownerA)).toBe(true);
    expect(jobs.every((job) => job.indexVersion === INDEX_VERSION)).toBe(true);
    expect(
      await db
        .select()
        .from(visualSearchDocuments)
        .where(
          and(
            eq(visualSearchDocuments.ownerId, ownerA),
            eq(visualSearchDocuments.status, "ready"),
          ),
        ),
    ).toHaveLength(1);
  });
});
