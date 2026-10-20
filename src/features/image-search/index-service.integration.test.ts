import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env/server";
import * as schema from "@/lib/db/schema";
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
  patternId?: string;
  assetId?: string;
  status?: (typeof patterns.$inferInsert)["status"];
  previewStatus?: (typeof patterns.$inferInsert)["previewStatus"];
  role?: (typeof assets.$inferInsert)["role"];
}) {
  const patternId = input.patternId ?? randomUUID();
  const assetId = input.assetId ?? randomUUID();
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("VISUAL_SEARCH_CONCURRENCY_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForPatternLockWaiter(
  monitor: ReturnType<typeof postgres>,
  input: { blockerApplication: string; waiterApplication: string },
) {
  return withTimeout(
    (async () => {
      while (true) {
        const waiters = await monitor<{ pid: number }[]>`
          select waiter.pid
          from pg_stat_activity waiter
          where waiter.datname = current_database()
            and waiter.application_name = ${input.waiterApplication}
            and waiter.state = 'active'
            and waiter.wait_event_type = 'Lock'
            and waiter.query ilike '%patterns%'
            and waiter.query ilike '%for update%'
            and exists (
              select 1
              from pg_stat_activity blocker
              where blocker.pid = any(pg_blocking_pids(waiter.pid))
                and blocker.application_name = ${input.blockerApplication}
            )
        `;
        if (waiters[0]) return waiters[0].pid;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })(),
  );
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
        cursor: firstPage.nextCursor ?? undefined,
      }),
    );
    const rows = [...firstPage.candidates, ...secondPage.candidates];

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

  it("holds pattern locks until a backfill page commits before preview replacement", async () => {
    const ownerId = await seedUser("backfill-lock@example.test");
    const stable = await seedPatternWithPreview({
      ownerId,
      patternId: "00000000-0000-4000-8000-000000000010",
      assetId: "00000000-0000-4000-8000-000000000110",
    });
    const replaced = await seedPatternWithPreview({
      ownerId,
      patternId: "00000000-0000-4000-8000-000000000020",
      assetId: "00000000-0000-4000-8000-000000000120",
      previewStatus: "manual",
    });
    const replacementAssetId = "00000000-0000-4000-8000-000000000121";
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blockerApplication = `visual-search-backfill-${randomUUID()}`;
    const waiterApplication = `visual-search-replacement-${randomUUID()}`;
    const backfillClient = postgres(databaseUrl, {
      max: 1,
      connection: { application_name: blockerApplication },
    });
    const replacementClient = postgres(databaseUrl, {
      max: 1,
      connection: { application_name: waiterApplication },
    });
    const monitor = postgres(databaseUrl, { max: 1 });
    const backfillDatabase = drizzle(backfillClient, { schema });
    const replacementDatabase = drizzle(replacementClient, { schema });
    const candidatesSelected = deferred();
    const releaseBackfill = deferred();
    let backfillPage: Promise<unknown> | undefined;
    let replacement: Promise<unknown> | undefined;

    try {
      backfillPage = backfillDatabase.transaction(async (tx) => {
        const page = await listVisualSearchBackfillCandidates(tx, {
          limit: 500,
        });
        candidatesSelected.resolve();
        await releaseBackfill.promise;
        for (const candidate of page.candidates) {
          await enqueueVisualSearchIndexJob(tx, {
            ...candidate,
            indexVersion: "visual-search-v2",
            now: NOW,
          });
        }
      });
      await withTimeout(candidatesSelected.promise);

      replacement = replacementDatabase.transaction(async (tx) => {
        const [lockedPattern] = await tx
          .select({ id: patterns.id })
          .from(patterns)
          .where(
            and(
              eq(patterns.ownerId, ownerId),
              eq(patterns.id, replaced.patternId),
            ),
          )
          .orderBy(asc(patterns.id))
          .for("update");
        if (!lockedPattern) throw new Error("REPLACEMENT_PATTERN_MISSING");
        await tx
          .delete(assets)
          .where(
            and(
              eq(assets.ownerId, ownerId),
              eq(assets.patternId, replaced.patternId),
              eq(assets.id, replaced.assetId),
            ),
          );
        await tx.insert(assets).values({
          id: replacementAssetId,
          ownerId,
          patternId: replaced.patternId,
          role: "preview",
          objectKey: `users/${ownerId}/patterns/${replaced.patternId}/${replacementAssetId}.webp`,
          originalFilename: "replacement.webp",
          sizeBytes: 12n,
        });
      });

      const observed = await withTimeout(
        Promise.race([
          waitForPatternLockWaiter(monitor, {
            blockerApplication,
            waiterApplication,
          }).then(() => "blocked" as const),
          replacement.then(() => "completed" as const),
        ]),
      );
      releaseBackfill.resolve();
      const outcomes = await withTimeout(
        Promise.allSettled([backfillPage, replacement]),
      );

      expect(observed).toBe("blocked");
      expect(outcomes).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      expect(
        await db
          .select({ previewAssetId: visualSearchJobs.previewAssetId })
          .from(visualSearchJobs)
          .orderBy(asc(visualSearchJobs.previewAssetId)),
      ).toEqual([{ previewAssetId: stable.assetId }]);
      expect(
        await db
          .select({ id: assets.id })
          .from(assets)
          .where(eq(assets.patternId, replaced.patternId)),
      ).toEqual([{ id: replacementAssetId }]);
    } finally {
      releaseBackfill.resolve();
      await Promise.allSettled(
        [backfillPage, replacement].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await Promise.all([
        backfillClient.end({ timeout: 1 }),
        replacementClient.end({ timeout: 1 }),
        monitor.end({ timeout: 1 }),
      ]);
    }
  });

  it("revalidates candidates after a replacement-first pattern lock commits", async () => {
    const ownerId = await seedUser("backfill-reverse-lock@example.test");
    const stable = await seedPatternWithPreview({
      ownerId,
      patternId: "00000000-0000-4000-8000-000000000030",
      assetId: "00000000-0000-4000-8000-000000000130",
    });
    const replaced = await seedPatternWithPreview({
      ownerId,
      patternId: "00000000-0000-4000-8000-000000000040",
      assetId: "00000000-0000-4000-8000-000000000140",
      previewStatus: "manual",
    });
    const replacementAssetId = "00000000-0000-4000-8000-000000000141";
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blockerApplication = `visual-search-replacement-${randomUUID()}`;
    const waiterApplication = `visual-search-backfill-${randomUUID()}`;
    const replacementClient = postgres(databaseUrl, {
      max: 1,
      connection: { application_name: blockerApplication },
    });
    const backfillClient = postgres(databaseUrl, {
      max: 1,
      connection: { application_name: waiterApplication },
    });
    const monitor = postgres(databaseUrl, { max: 1 });
    const replacementDatabase = drizzle(replacementClient, { schema });
    const backfillDatabase = drizzle(backfillClient, { schema });
    const replacementMutated = deferred();
    const releaseReplacement = deferred();
    let replacement: Promise<unknown> | undefined;
    let backfillPage: Promise<unknown> | undefined;

    try {
      replacement = replacementDatabase.transaction(async (tx) => {
        const [lockedPattern] = await tx
          .select({ id: patterns.id })
          .from(patterns)
          .where(
            and(
              eq(patterns.ownerId, ownerId),
              eq(patterns.id, replaced.patternId),
            ),
          )
          .orderBy(asc(patterns.id))
          .for("update");
        if (!lockedPattern) throw new Error("REPLACEMENT_PATTERN_MISSING");
        await tx
          .delete(assets)
          .where(
            and(
              eq(assets.ownerId, ownerId),
              eq(assets.patternId, replaced.patternId),
              eq(assets.id, replaced.assetId),
            ),
          );
        await tx.insert(assets).values({
          id: replacementAssetId,
          ownerId,
          patternId: replaced.patternId,
          role: "preview",
          objectKey: `users/${ownerId}/patterns/${replaced.patternId}/${replacementAssetId}.webp`,
          originalFilename: "replacement.webp",
          sizeBytes: 12n,
        });
        replacementMutated.resolve();
        await releaseReplacement.promise;
      });
      await withTimeout(replacementMutated.promise);

      backfillPage = backfillDatabase.transaction(async (tx) => {
        const page = await listVisualSearchBackfillCandidates(tx, {
          limit: 500,
        });
        for (const candidate of page.candidates) {
          await enqueueVisualSearchIndexJob(tx, {
            ...candidate,
            indexVersion: "visual-search-v2",
            now: NOW,
          });
        }
        return page;
      });
      await waitForPatternLockWaiter(monitor, {
        blockerApplication,
        waiterApplication,
      });
      releaseReplacement.resolve();
      const outcomes = await withTimeout(
        Promise.allSettled([replacement, backfillPage]),
      );

      expect(outcomes).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({
          status: "fulfilled",
          value: {
            candidates: [
              {
                ownerId,
                patternId: stable.patternId,
                previewAssetId: stable.assetId,
              },
            ],
            scanned: 2,
            nextCursor: {
              ownerId,
              patternId: replaced.patternId,
              previewAssetId: replaced.assetId,
            },
          },
        }),
      ]);
      expect(
        await db
          .select({ previewAssetId: visualSearchJobs.previewAssetId })
          .from(visualSearchJobs)
          .orderBy(asc(visualSearchJobs.previewAssetId)),
      ).toEqual([{ previewAssetId: stable.assetId }]);
      expect(
        await db
          .select({ id: assets.id })
          .from(assets)
          .where(eq(assets.patternId, replaced.patternId)),
      ).toEqual([{ id: replacementAssetId }]);
    } finally {
      releaseReplacement.resolve();
      await Promise.allSettled(
        [replacement, backfillPage].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await Promise.all([
        replacementClient.end({ timeout: 1 }),
        backfillClient.end({ timeout: 1 }),
        monitor.end({ timeout: 1 }),
      ]);
    }
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
