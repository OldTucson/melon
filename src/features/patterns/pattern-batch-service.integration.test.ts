import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { lockPatternRows } from "@/features/patterns/pattern-batch-repository";
import { batchPatterns } from "@/features/patterns/pattern-batch-service";
import { closeDatabase, db } from "@/lib/db/client";
import {
  assets,
  changeLog,
  folders,
  operations,
  patterns,
  patternStatuses,
  users,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";
import { getServerEnv } from "@/lib/env/server";

type PatternStatus = (typeof patternStatuses)[number];
type FolderStatus = (typeof folders.$inferInsert)["status"];

const lowId = "00000000-0000-4000-8000-000000000001";
const middleId = "88888888-8888-4888-8888-888888888888";
const highId = "ffffffff-ffff-4fff-bfff-ffffffffffff";

const seedUser = async (email: string) => {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email,
    displayName: email,
    passwordHash: "test-password-hash",
    mustChangePassword: false,
  });
  return id;
};

const seedFolder = async (input: {
  ownerId: string;
  name: string;
  status?: FolderStatus;
}) => {
  const id = randomUUID();
  await db.insert(folders).values({
    id,
    ownerId: input.ownerId,
    name: input.name,
    normalizedName: input.name.toLowerCase(),
    status: input.status ?? "active",
  });
  return id;
};

const seedPattern = async (input: {
  ownerId: string;
  id?: string;
  name?: string;
  folderId?: string | null;
  status?: PatternStatus;
  version?: number;
  changeSeq?: bigint;
  isFavorite?: boolean;
  updatedAt?: Date;
}) => {
  const id = input.id ?? randomUUID();
  const name = input.name ?? `Pattern ${id}`;
  await db.insert(patterns).values({
    id,
    ownerId: input.ownerId,
    folderId: input.folderId ?? null,
    name,
    originalFilename: `${name}.psd`,
    extension: "psd",
    detectedMimeType: "image/vnd.adobe.photoshop",
    sizeBytes: 1024n,
    contentHash: "a".repeat(64),
    status: input.status ?? "ready",
    previewStatus: "ready",
    version: input.version ?? 0,
    changeSeq: input.changeSeq ?? 0n,
    isFavorite: input.isFavorite ?? false,
    updatedAt: input.updatedAt,
  });
  return { id, version: input.version ?? 0 };
};

const readPatterns = (ownerId: string, ids: string[]) =>
  db
    .select()
    .from(patterns)
    .where(and(eq(patterns.ownerId, ownerId), inArray(patterns.id, ids)))
    .orderBy(asc(patterns.id));

const readChanges = (ownerId: string) =>
  db
    .select()
    .from(changeLog)
    .where(eq(changeLog.ownerId, ownerId))
    .orderBy(asc(changeLog.seq));

const readOperations = (ownerId: string) =>
  db
    .select()
    .from(operations)
    .where(eq(operations.ownerId, ownerId))
    .orderBy(asc(operations.operationId));

const readSyncSeq = async (ownerId: string) => {
  const [owner] = await db
    .select({ syncSeq: users.syncSeq })
    .from(users)
    .where(eq(users.id, ownerId));
  return owner?.syncSeq;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("PATTERN_BATCH_CONCURRENCY_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntilBlockedByFolderTransaction(
  monitor: ReturnType<typeof postgres>,
  blockerPid: number,
) {
  while (true) {
    const blocked = await monitor<{ pid: number }[]>`
      select activity.pid
      from pg_stat_activity activity
      where activity.datname = current_database()
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
        and activity.query ilike '%folders%'
        and activity.query ilike '%for update%'
    `;
    if (blocked[0]) return blocked[0].pid;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function errorChainHas(
  error: unknown,
  property: "code" | "status",
  value: unknown,
) {
  let candidate = error;
  const seen = new Set<unknown>();
  while (
    typeof candidate === "object" &&
    candidate !== null &&
    !seen.has(candidate)
  ) {
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (record[property] === value) return true;
    candidate = record.cause;
  }
  return false;
}

describe("pattern batch service", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = await seedUser("pattern-batch-a@example.test");
    ownerB = await seedUser("pattern-batch-b@example.test");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("moves ready and failed patterns atomically with one deterministic event", async () => {
    const source = await seedFolder({ ownerId: ownerA, name: "Source" });
    const target = await seedFolder({ ownerId: ownerA, name: "Target" });
    const low = await seedPattern({
      ownerId: ownerA,
      id: lowId,
      name: "Low",
      folderId: source,
      status: "ready",
    });
    const high = await seedPattern({
      ownerId: ownerA,
      id: highId,
      name: "High",
      folderId: source,
      status: "failed",
    });
    const previewAssetId = randomUUID();
    await db.insert(assets).values({
      id: previewAssetId,
      ownerId: ownerA,
      patternId: low.id,
      role: "preview",
      objectKey: `users/${ownerA}/patterns/${low.id}/derived/${previewAssetId}.png`,
      originalFilename: "low-preview.png",
      detectedMimeType: "image/png",
      sizeBytes: 128n,
    });
    const operationId = randomUUID();

    const result = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId,
        action: "move",
        patterns: [high, low],
        folderId: target,
      },
    });

    expect(result.patterns.map((pattern) => pattern.id)).toEqual([lowId, highId]);
    expect(result.patterns).toEqual([
      expect.objectContaining({
        id: lowId,
        ownerId: ownerA,
        folderId: target,
        trashBatchId: null,
        preTrashStatus: null,
        previewAssetId,
        version: 1,
        changeSeq: "1",
        paletteStatus: "pending",
        palette: [],
      }),
      expect.objectContaining({
        id: highId,
        ownerId: ownerA,
        folderId: target,
        trashBatchId: null,
        preTrashStatus: null,
        version: 1,
        changeSeq: "1",
        paletteStatus: "pending",
        palette: [],
      }),
    ]);
    expect(await readPatterns(ownerA, [highId, lowId])).toEqual([
      expect.objectContaining({ id: lowId, folderId: target, version: 1, changeSeq: 1n }),
      expect.objectContaining({ id: highId, folderId: target, version: 1, changeSeq: 1n }),
    ]);
    expect(await readChanges(ownerA)).toEqual([
      expect.objectContaining({
        seq: 1n,
        operationId,
        entityType: "pattern_batch",
        entityId: operationId,
        operation: "patterns.moved",
        payload: { patternIds: [lowId, highId] },
      }),
    ]);
    expect(await readOperations(ownerA)).toEqual([
      expect.objectContaining({
        operationId,
        kind: expect.stringMatching(/^pattern\.batch:[a-f0-9]{64}$/),
        result,
      }),
    ]);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("stores and replays deterministic no-op moves without mutating rows or sync state", async () => {
    const target = await seedFolder({ ownerId: ownerA, name: "Already there" });
    const lowUpdatedAt = new Date("2026-01-02T03:04:05.000Z");
    const highUpdatedAt = new Date("2026-02-03T04:05:06.000Z");
    const low = await seedPattern({
      ownerId: ownerA,
      id: lowId,
      folderId: target,
      status: "ready",
      version: 4,
      changeSeq: 7n,
      updatedAt: lowUpdatedAt,
    });
    const high = await seedPattern({
      ownerId: ownerA,
      id: highId,
      folderId: target,
      status: "failed",
      version: 5,
      changeSeq: 8n,
      updatedAt: highUpdatedAt,
    });
    const filedOperationId = randomUUID();

    const filedResult = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId: filedOperationId,
        action: "move",
        patterns: [high, low],
        folderId: target,
      },
    });

    expect(filedResult.patterns.map((pattern) => pattern.id)).toEqual([
      lowId,
      highId,
    ]);
    expect(filedResult.patterns).toEqual([
      expect.objectContaining({
        id: lowId,
        folderId: target,
        status: "ready",
        version: 4,
        changeSeq: "7",
        updatedAt: lowUpdatedAt.toISOString(),
      }),
      expect.objectContaining({
        id: highId,
        folderId: target,
        status: "failed",
        version: 5,
        changeSeq: "8",
        updatedAt: highUpdatedAt.toISOString(),
      }),
    ]);
    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId: filedOperationId,
          action: "move",
          patterns: [low, high],
          folderId: target,
        },
      }),
    ).resolves.toEqual(filedResult);

    const unfiledUpdatedAt = new Date("2026-03-04T05:06:07.000Z");
    const unfiled = await seedPattern({
      ownerId: ownerA,
      id: middleId,
      folderId: null,
      version: 6,
      changeSeq: 9n,
      updatedAt: unfiledUpdatedAt,
    });
    const unfiledOperationId = randomUUID();
    const unfiledResult = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId: unfiledOperationId,
        action: "move",
        patterns: [unfiled],
        folderId: null,
      },
    });
    expect(unfiledResult.patterns).toEqual([
      expect.objectContaining({
        id: unfiled.id,
        folderId: null,
        version: 6,
        changeSeq: "9",
        updatedAt: unfiledUpdatedAt.toISOString(),
      }),
    ]);

    expect(await readPatterns(ownerA, [low.id, high.id, unfiled.id])).toEqual([
      expect.objectContaining({
        id: low.id,
        folderId: target,
        version: 4,
        changeSeq: 7n,
        updatedAt: lowUpdatedAt,
      }),
      expect.objectContaining({
        id: unfiled.id,
        folderId: null,
        version: 6,
        changeSeq: 9n,
        updatedAt: unfiledUpdatedAt,
      }),
      expect.objectContaining({
        id: high.id,
        folderId: target,
        version: 5,
        changeSeq: 8n,
        updatedAt: highUpdatedAt,
      }),
    ]);
    expect(await readChanges(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);
    expect(await readOperations(ownerA)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: filedOperationId,
          result: filedResult,
        }),
        expect.objectContaining({
          operationId: unfiledOperationId,
          result: unfiledResult,
        }),
      ]),
    );
    expect(await readOperations(ownerA)).toHaveLength(2);
  });

  it("validates an already-targeted folder is still active before accepting a no-op", async () => {
    const target = await seedFolder({
      ownerId: ownerA,
      name: "Inactive target",
      status: "trashed",
    });
    const pattern = await seedPattern({ ownerId: ownerA, folderId: target });

    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId: randomUUID(),
          action: "move",
          patterns: [pattern],
          folderId: target,
        },
      }),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_ACTIVE", status: 409 });
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);
  });

  it("does not skip version or status validation when a move would otherwise be a no-op", async () => {
    const target = await seedFolder({
      ownerId: ownerA,
      name: "Validated no-op target",
    });
    const pattern = await seedPattern({ ownerId: ownerA, folderId: target });

    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId: randomUUID(),
          action: "move",
          patterns: [{ id: pattern.id, version: 1 }],
          folderId: target,
        },
      }),
    ).rejects.toMatchObject({ code: "PATTERN_STATE_CHANGED", status: 409 });

    await db
      .update(patterns)
      .set({ status: "draft" })
      .where(and(eq(patterns.ownerId, ownerA), eq(patterns.id, pattern.id)));
    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId: randomUUID(),
          action: "move",
          patterns: [pattern],
          folderId: target,
        },
      }),
    ).rejects.toMatchObject({ code: "PATTERN_STATE_CHANGED", status: 409 });

    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readChanges(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);
  });

  it("updates only changed rows in a mixed move and logs only affected IDs", async () => {
    const source = await seedFolder({ ownerId: ownerA, name: "Mixed source" });
    const target = await seedFolder({ ownerId: ownerA, name: "Mixed target" });
    const unchangedAt = new Date("2026-04-05T06:07:08.000Z");
    const changedAt = new Date("2026-05-06T07:08:09.000Z");
    const unchanged = await seedPattern({
      ownerId: ownerA,
      id: lowId,
      folderId: target,
      version: 3,
      changeSeq: 11n,
      updatedAt: unchangedAt,
    });
    const changed = await seedPattern({
      ownerId: ownerA,
      id: highId,
      folderId: source,
      version: 4,
      changeSeq: 12n,
      updatedAt: changedAt,
    });
    const operationId = randomUUID();

    const result = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId,
        action: "move",
        patterns: [changed, unchanged],
        folderId: target,
      },
    });

    expect(result.patterns).toEqual([
      expect.objectContaining({
        id: unchanged.id,
        folderId: target,
        version: 3,
        changeSeq: "11",
        updatedAt: unchangedAt.toISOString(),
      }),
      expect.objectContaining({
        id: changed.id,
        folderId: target,
        version: 5,
        changeSeq: "1",
        updatedAt: expect.any(String),
      }),
    ]);
    expect(result.patterns[1]?.updatedAt).not.toBe(changedAt.toISOString());
    expect(await readPatterns(ownerA, [unchanged.id, changed.id])).toEqual([
      expect.objectContaining({
        id: unchanged.id,
        folderId: target,
        version: 3,
        changeSeq: 11n,
        updatedAt: unchangedAt,
      }),
      expect.objectContaining({
        id: changed.id,
        folderId: target,
        version: 5,
        changeSeq: 1n,
      }),
    ]);
    expect(await readChanges(ownerA)).toEqual([
      expect.objectContaining({
        operationId,
        operation: "patterns.moved",
        payload: { patternIds: [changed.id] },
      }),
    ]);
    expect(await readSyncSeq(ownerA)).toBe(1n);
    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId,
          action: "move",
          patterns: [unchanged, changed],
          folderId: target,
        },
      }),
    ).resolves.toEqual(result);
    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("moves a pattern to unfiled and applies one favorite value to every row", async () => {
    const folderId = await seedFolder({ ownerId: ownerA, name: "Filed" });
    const first = await seedPattern({ ownerId: ownerA, folderId, isFavorite: false });
    const moved = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId: randomUUID(),
        action: "move",
        patterns: [first],
        folderId: null,
      },
    });
    expect(moved.patterns).toEqual([
      expect.objectContaining({ id: first.id, folderId: null, version: 1 }),
    ]);

    const second = await seedPattern({ ownerId: ownerA, isFavorite: false });
    const favorited = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId: randomUUID(),
        action: "favorite",
        patterns: [second, { id: first.id, version: 1 }],
        isFavorite: true,
      },
    });
    expect(favorited.patterns.map((pattern) => pattern.id)).toEqual(
      [first.id, second.id].sort(),
    );
    expect(favorited.patterns).toEqual([
      expect.objectContaining({ isFavorite: true, version: expect.any(Number), changeSeq: "2" }),
      expect.objectContaining({ isFavorite: true, version: expect.any(Number), changeSeq: "2" }),
    ]);
    expect((await readChanges(ownerA)).map((change) => change.operation)).toEqual([
      "patterns.moved",
      "patterns.favorited",
    ]);
    expect(await readSyncSeq(ownerA)).toBe(2n);
  });

  it("trashes a batch with one timestamp while preserving folders, prior status, and assets", async () => {
    const folderId = await seedFolder({ ownerId: ownerA, name: "Keep location" });
    const ready = await seedPattern({ ownerId: ownerA, folderId, status: "ready" });
    const failed = await seedPattern({ ownerId: ownerA, folderId, status: "failed" });
    const sourceAssetId = randomUUID();
    await db.insert(assets).values({
      id: sourceAssetId,
      ownerId: ownerA,
      patternId: ready.id,
      role: "source",
      objectKey: `users/${ownerA}/patterns/${ready.id}/source/${sourceAssetId}.psd`,
      originalFilename: "source.psd",
      detectedMimeType: "image/vnd.adobe.photoshop",
      sizeBytes: 1024n,
    });
    const operationId = randomUUID();

    const result = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId,
        action: "trash",
        patterns: [failed, ready],
      },
    });

    const byId = new Map(result.patterns.map((pattern) => [pattern.id, pattern]));
    expect(byId.get(ready.id)).toMatchObject({
      folderId,
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: operationId,
      version: 1,
      changeSeq: "1",
    });
    expect(byId.get(failed.id)).toMatchObject({
      folderId,
      status: "trashed",
      preTrashStatus: "failed",
      trashBatchId: operationId,
      version: 1,
      changeSeq: "1",
    });
    expect(byId.get(ready.id)?.trashedAt).toEqual(byId.get(failed.id)?.trashedAt);
    expect(byId.get(ready.id)?.trashedAt).toEqual(expect.any(String));
    expect(
      await db.select({ id: assets.id, objectKey: assets.objectKey }).from(assets),
    ).toEqual([
      {
        id: sourceAssetId,
        objectKey: `users/${ownerA}/patterns/${ready.id}/source/${sourceAssetId}.psd`,
      },
    ]);
    expect(await readChanges(ownerA)).toEqual([
      expect.objectContaining({
        operation: "patterns.trashed",
        payload: { patternIds: [ready.id, failed.id].sort() },
      }),
    ]);
  });

  it("rolls back every row, operation, log, and sequence for one stale version", async () => {
    const source = await seedFolder({ ownerId: ownerA, name: "Source" });
    const target = await seedFolder({ ownerId: ownerA, name: "Target" });
    const first = await seedPattern({ ownerId: ownerA, folderId: source });
    const second = await seedPattern({ ownerId: ownerA, folderId: source });

    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId: randomUUID(),
          action: "move",
          patterns: [first, { id: second.id, version: second.version + 1 }],
          folderId: target,
        },
      }),
    ).rejects.toMatchObject({ code: "PATTERN_STATE_CHANGED", status: 409 });

    expect(await readPatterns(ownerA, [first.id, second.id])).toEqual([
      expect.objectContaining({ folderId: source, version: 0, changeSeq: 0n }),
      expect.objectContaining({ folderId: source, version: 0, changeSeq: 0n }),
    ]);
    expect(await readChanges(ownerA)).toEqual([]);
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);
  });

  it("keeps foreign and missing pattern IDs indistinguishable and never partially updates", async () => {
    const owned = await seedPattern({ ownerId: ownerA });
    const foreign = await seedPattern({ ownerId: ownerB });

    for (const unavailable of [foreign.id, randomUUID()]) {
      await expect(
        batchPatterns({
          ownerId: ownerA,
          mutation: {
            operationId: randomUUID(),
            action: "favorite",
            patterns: [owned, { id: unavailable, version: 0 }],
            isFavorite: true,
          },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }

    expect(await readPatterns(ownerA, [owned.id])).toEqual([
      expect.objectContaining({ id: owned.id, isFavorite: false, version: 0 }),
    ]);
    expect(await readPatterns(ownerB, [foreign.id])).toEqual([
      expect.objectContaining({ id: foreign.id, isFavorite: false, version: 0 }),
    ]);
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);
  });

  it.each(["draft", "hashing", "uploading", "processing", "trashed", "deleting", "deleted"] as const)(
    "rejects the non-editable %s status as a state conflict",
    async (status) => {
      const pattern = await seedPattern({ ownerId: ownerA, status });

      await expect(
        batchPatterns({
          ownerId: ownerA,
          mutation: {
            operationId: randomUUID(),
            action: "favorite",
            patterns: [pattern],
            isFavorite: true,
          },
        }),
      ).rejects.toMatchObject({ code: "PATTERN_STATE_CHANGED", status: 409 });

      expect(await readPatterns(ownerA, [pattern.id])).toEqual([
        expect.objectContaining({ status, isFavorite: false, version: 0 }),
      ]);
      expect(await readOperations(ownerA)).toEqual([]);
    },
  );

  it("requires an active owned target folder and distinguishes missing from inactive", async () => {
    const pattern = await seedPattern({ ownerId: ownerA });
    const foreign = await seedFolder({ ownerId: ownerB, name: "Foreign" });

    for (const folderId of [foreign, randomUUID()]) {
      await expect(
        batchPatterns({
          ownerId: ownerA,
          mutation: {
            operationId: randomUUID(),
            action: "move",
            patterns: [pattern],
            folderId,
          },
        }),
      ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND", status: 404 });
    }

    for (const status of ["trashed", "deleting", "deleted"] as const) {
      const folderId = await seedFolder({
        ownerId: ownerA,
        name: `Inactive ${status}`,
        status,
      });
      await expect(
        batchPatterns({
          ownerId: ownerA,
          mutation: {
            operationId: randomUUID(),
            action: "move",
            patterns: [pattern],
            folderId,
          },
        }),
      ).rejects.toMatchObject({ code: "FOLDER_NOT_ACTIVE", status: 409 });
    }

    expect(await readPatterns(ownerA, [pattern.id])).toEqual([
      expect.objectContaining({ folderId: null, version: 0, changeSeq: 0n }),
    ]);
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);
  });

  it("enforces normalized unique IDs and the batch limit in direct service calls", async () => {
    const pattern = await seedPattern({ ownerId: ownerA, id: lowId });
    const operationId = randomUUID();

    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId,
          action: "trash",
          patterns: [pattern, { id: pattern.id.toUpperCase(), version: 0 }],
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId,
          action: "trash",
          patterns: Array.from({ length: 101 }, () => ({
            id: randomUUID(),
            version: 0,
          })),
        },
      }),
    ).rejects.toMatchObject({ code: "BATCH_LIMIT_EXCEEDED", status: 400 });

    expect(await readOperations(ownerA)).toEqual([]);
  });

  it("rejects repository calls that are not sorted, unique, and normalized", async () => {
    await seedPattern({ ownerId: ownerA, id: lowId });
    await seedPattern({ ownerId: ownerA, id: highId });

    for (const ids of [
      [highId, lowId],
      [lowId, lowId],
      [highId.toUpperCase()],
    ]) {
      await expect(
        db.transaction((tx) => lockPatternRows(ownerA, tx, ids)),
      ).rejects.toThrow("PATTERN_IDS_MUST_BE_SORTED_UNIQUE_NORMALIZED");
    }
  });

  it("replays a canonical reordered request and rejects operation reuse without duplicate writes", async () => {
    const low = await seedPattern({ ownerId: ownerA, id: lowId });
    const high = await seedPattern({ ownerId: ownerA, id: highId });
    const foreign = await seedPattern({ ownerId: ownerB });
    const operationId = randomUUID();
    const first = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId,
        action: "favorite",
        patterns: [high, low],
        isFavorite: true,
      },
    });

    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId: operationId.toUpperCase(),
          action: "favorite",
          patterns: [
            { id: low.id.toUpperCase(), version: 0 },
            { id: high.id.toUpperCase(), version: 0 },
          ],
          isFavorite: true,
        },
      }),
    ).resolves.toEqual(first);
    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId,
          action: "favorite",
          patterns: [low, high],
          isFavorite: false,
        },
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    for (const unavailable of [foreign.id, randomUUID()]) {
      await expect(
        batchPatterns({
          ownerId: ownerA,
          mutation: {
            operationId,
            action: "favorite",
            patterns: [low, { id: unavailable, version: 0 }],
            isFavorite: true,
          },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }

    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readOperations(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
    expect(await readPatterns(ownerA, [low.id, high.id])).toEqual([
      expect.objectContaining({ id: low.id, isFavorite: true, version: 1 }),
      expect.objectContaining({ id: high.id, isFavorite: true, version: 1 }),
    ]);
  });

  it("normalizes legacy replay DTOs that predate folder and trash fields", async () => {
    const pattern = await seedPattern({ ownerId: ownerA });
    const operationId = randomUUID();
    const first = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId,
        action: "favorite",
        patterns: [pattern],
        isFavorite: true,
      },
    });
    const legacyPatterns = first.patterns.map((item) => {
      const legacy = { ...item } as Record<string, unknown>;
      delete legacy.folderId;
      delete legacy.trashBatchId;
      delete legacy.preTrashStatus;
      return legacy;
    });
    await db
      .update(operations)
      .set({ result: { patterns: legacyPatterns } })
      .where(
        and(
          eq(operations.ownerId, ownerA),
          eq(operations.operationId, operationId),
        ),
      );

    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId,
          action: "favorite",
          patterns: [pattern],
          isFavorite: true,
        },
      }),
    ).resolves.toEqual({
      patterns: [
        expect.objectContaining({
          id: pattern.id,
          folderId: null,
          trashBatchId: null,
          preTrashStatus: null,
        }),
      ],
    });
    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("rejects a corrupted stored replay result instead of returning another tenant or target", async () => {
    const pattern = await seedPattern({ ownerId: ownerA });
    const operationId = randomUUID();
    const result = await batchPatterns({
      ownerId: ownerA,
      mutation: {
        operationId,
        action: "favorite",
        patterns: [pattern],
        isFavorite: true,
      },
    });
    await db
      .update(operations)
      .set({
        result: {
          patterns: result.patterns.map((item) => ({
            ...item,
            ownerId: ownerB,
          })),
        },
      })
      .where(
        and(
          eq(operations.ownerId, ownerA),
          eq(operations.operationId, operationId),
        ),
      );

    await expect(
      batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId,
          action: "favorite",
          patterns: [pattern],
          isFavorite: true,
        },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
  });

  it("serializes identical concurrent requests into one exact replay", async () => {
    const first = await seedPattern({ ownerId: ownerA, id: lowId });
    const second = await seedPattern({ ownerId: ownerA, id: highId });
    const input = {
      ownerId: ownerA,
      mutation: {
        operationId: randomUUID(),
        action: "favorite" as const,
        patterns: [second, first],
        isFavorite: true,
      },
    };

    const [left, right] = await withTimeout(
      Promise.all([batchPatterns(input), batchPatterns(input)]),
    );

    expect(right).toEqual(left);
    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readOperations(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
    expect(await readPatterns(ownerA, [first.id, second.id])).toEqual([
      expect.objectContaining({ id: first.id, version: 1, isFavorite: true }),
      expect.objectContaining({ id: second.id, version: 1, isFavorite: true }),
    ]);
  });

  it("locks reversed inputs in stable order without deadlock or partial success", async () => {
    const first = await seedPattern({ ownerId: ownerA, id: lowId });
    const second = await seedPattern({ ownerId: ownerA, id: highId });
    const outcomes = await withTimeout(
      Promise.allSettled([
        batchPatterns({
          ownerId: ownerA,
          mutation: {
            operationId: randomUUID(),
            action: "favorite",
            patterns: [first, second],
            isFavorite: true,
          },
        }),
        batchPatterns({
          ownerId: ownerA,
          mutation: {
            operationId: randomUUID(),
            action: "favorite",
            patterns: [second, first],
            isFavorite: false,
          },
        }),
      ]),
    );
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(failures).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "PATTERN_STATE_CHANGED",
          status: 409,
        }),
      }),
    ]);
    const winner = successes[0];
    if (winner?.status !== "fulfilled") throw new Error("BATCH_RACE_NO_WINNER");
    expect(winner.value.patterns.map((pattern) => pattern.id)).toEqual([
      lowId,
      highId,
    ]);
    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readOperations(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("locks a move target before patterns to match folder-tree transaction ordering", async () => {
    const source = await seedFolder({ ownerId: ownerA, name: "Lock source" });
    const target = await seedFolder({ ownerId: ownerA, name: "Lock target" });
    const pattern = await seedPattern({ ownerId: ownerA, folderId: source });
    const operationId = randomUUID();
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blocker = postgres(databaseUrl, {
      max: 1,
      connection: {
        application_name: "pattern-batch-folder-lock-blocker",
      },
    });
    const monitor = postgres(databaseUrl, {
      max: 1,
      connection: {
        application_name: "pattern-batch-folder-lock-monitor",
      },
    });
    const folderLocked = deferred<number>();
    const requestPatternLock = deferred<void>();
    let blockerTransaction: Promise<unknown> | undefined;
    let batch: Promise<Awaited<ReturnType<typeof batchPatterns>>> | undefined;

    try {
      blockerTransaction = blocker.begin(async (tx) => {
        await tx`set local lock_timeout = '750ms'`;
        await tx`set local statement_timeout = '1500ms'`;
        const [backend] = await tx<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        if (!backend) throw new Error("LOCK_BLOCKER_PID_MISSING");
        await tx`
          select id
          from folders
          where owner_id = ${ownerA}
            and id = ${target}
          for update
        `;
        folderLocked.resolve(backend.pid);
        await requestPatternLock.promise;
        await tx`
          select id
          from patterns
          where owner_id = ${ownerA}
            and id = ${pattern.id}
          for update
        `;
      });

      const blockerPid = await withTimeout(folderLocked.promise);
      batch = batchPatterns({
        ownerId: ownerA,
        mutation: {
          operationId,
          action: "move",
          patterns: [pattern],
          folderId: target,
        },
      });
      await withTimeout(
        waitUntilBlockedByFolderTransaction(monitor, blockerPid),
      );
      requestPatternLock.resolve(undefined);

      const [blockerOutcome, batchOutcome] = await withTimeout(
        Promise.allSettled([blockerTransaction, batch]),
      );
      for (const outcome of [blockerOutcome, batchOutcome]) {
        if (outcome.status === "rejected") {
          expect(errorChainHas(outcome.reason, "code", "40P01")).toBe(false);
          expect(errorChainHas(outcome.reason, "status", 500)).toBe(false);
        }
      }
      expect(blockerOutcome).toMatchObject({ status: "fulfilled" });
      expect(batchOutcome).toMatchObject({ status: "fulfilled" });
    } finally {
      requestPatternLock.resolve(undefined);
      await Promise.allSettled(
        [blockerTransaction, batch].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await Promise.all([blocker.end({ timeout: 1 }), monitor.end({ timeout: 1 })]);
    }

    await expect(readPatterns(ownerA, [pattern.id])).resolves.toEqual([
      expect.objectContaining({
        id: pattern.id,
        folderId: target,
        version: 1,
        changeSeq: 1n,
      }),
    ]);
    await expect(readChanges(ownerA)).resolves.toEqual([
      expect.objectContaining({
        operationId,
        operation: "patterns.moved",
        payload: { patternIds: [pattern.id] },
      }),
    ]);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });
});
