import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFolder,
  getFolderDeleteImpact,
} from "@/features/folders/folder-service";
import { trashFolderTree } from "@/features/folders/folder-trash-service";
import { closeDatabase, db } from "@/lib/db/client";
import { createOperationKey } from "@/lib/db/operation";
import {
  assets,
  changeLog,
  folders,
  operations,
  patterns,
  patternTags,
  tags,
  users,
} from "@/lib/db/schema";
import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import { resetDatabase } from "@/test/database";

import {
  listTrash,
  restoreFolderBatch,
  restorePatterns,
} from "./trash-service";

type FolderStatus = NonNullable<typeof folders.$inferInsert.status>;
type PatternStatus = NonNullable<typeof patterns.$inferInsert.status>;

const lowId = "00000000-0000-4000-8000-000000000001";
const highId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const DAY_MS = 24 * 60 * 60 * 1_000;

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
  id?: string;
  parentId?: string | null;
  status?: FolderStatus;
  version?: number;
  trashBatchId?: string | null;
  trashedAt?: Date | null;
  changeSeq?: bigint;
  updatedAt?: Date;
}) => {
  const id = input.id ?? randomUUID();
  await db.insert(folders).values({
    id,
    ownerId: input.ownerId,
    parentId: input.parentId ?? null,
    name: input.name,
    normalizedName: input.name.normalize("NFC").toLowerCase(),
    status: input.status ?? "active",
    version: input.version ?? 0,
    trashBatchId: input.trashBatchId ?? null,
    trashedAt: input.trashedAt ?? null,
    changeSeq: input.changeSeq ?? 0n,
    updatedAt: input.updatedAt,
  });
  return id;
};

const seedPattern = async (input: {
  ownerId: string;
  name: string;
  id?: string;
  folderId?: string | null;
  status?: PatternStatus;
  preTrashStatus?: PatternStatus | null;
  version?: number;
  trashBatchId?: string | null;
  trashedAt?: Date | null;
  lastErrorCode?: string | null;
  changeSeq?: bigint;
  updatedAt?: Date;
}) => {
  const id = input.id ?? randomUUID();
  await db.insert(patterns).values({
    id,
    ownerId: input.ownerId,
    folderId: input.folderId ?? null,
    name: input.name,
    originalFilename: `${input.name}.psd`,
    extension: "psd",
    detectedMimeType: "image/vnd.adobe.photoshop",
    sizeBytes: 1024n,
    contentHash: id.replaceAll("-", "").padEnd(64, "0"),
    status: input.status ?? "ready",
    preTrashStatus: input.preTrashStatus ?? null,
    version: input.version ?? 0,
    trashBatchId: input.trashBatchId ?? null,
    trashedAt: input.trashedAt ?? null,
    lastErrorCode: input.lastErrorCode ?? null,
    previewStatus: "ready",
    changeSeq: input.changeSeq ?? 0n,
    updatedAt: input.updatedAt,
  });
  return id;
};

const readFolders = (ownerId: string, ids: readonly string[]) =>
  db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, [...ids])))
    .orderBy(asc(folders.id));

const readPatterns = (ownerId: string, ids: readonly string[]) =>
  db
    .select()
    .from(patterns)
    .where(and(eq(patterns.ownerId, ownerId), inArray(patterns.id, [...ids])))
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

async function expectAppError(
  promise: Promise<unknown>,
  code: AppError["code"],
  status: number,
) {
  try {
    await promise;
    throw new Error("EXPECTED_APP_ERROR");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code, status });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("TRASH_RESTORE_CONCURRENCY_TIMEOUT")),
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

async function waitForBlockedAdvisoryPids(
  monitor: ReturnType<typeof postgres>,
  blockerPid: number,
  minimum: number,
) {
  return withTimeout(
    (async () => {
      while (true) {
        const waiters = await monitor<{ pid: number }[]>`
          select activity.pid
          from pg_stat_activity activity
          where activity.datname = current_database()
            and activity.state = 'active'
            and activity.wait_event_type = 'Lock'
            and ${blockerPid} = any(pg_blocking_pids(activity.pid))
            and activity.query ilike '%pg_advisory_xact_lock%'
          order by activity.pid
        `;
        if (waiters.length >= minimum) return waiters.map((row) => row.pid);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })(),
  );
}

async function waitForOperationClaimWaiter(
  monitor: ReturnType<typeof postgres>,
) {
  return withTimeout(
    (async () => {
      while (true) {
        const waiters = await monitor<{ pid: number }[]>`
          select activity.pid
          from pg_stat_activity activity
          where activity.datname = current_database()
            and activity.state = 'active'
            and activity.wait_event_type = 'Lock'
            and activity.query ilike '%insert into "operations"%'
          order by activity.pid
        `;
        if (waiters[0]) return waiters[0].pid;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })(),
  );
}

async function waitForPatternLockWaiter(
  monitor: ReturnType<typeof postgres>,
  blockerPids: readonly number[],
  excludedPids: readonly number[] = [],
) {
  return withTimeout(
    (async () => {
      while (true) {
        const waiters = await monitor<{ pid: number }[]>`
          select activity.pid
          from pg_stat_activity activity
          where activity.datname = current_database()
            and activity.state = 'active'
            and activity.wait_event_type = 'Lock'
            and pg_blocking_pids(activity.pid) && ${blockerPids}::integer[]
            and not (activity.pid = any(${excludedPids}::integer[]))
            and activity.query ilike '%patterns%'
            and activity.query ilike '%for update%'
          order by activity.pid
        `;
        if (waiters[0]) return waiters[0].pid;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })(),
  );
}

describe("trash read model and restore services", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = await seedUser("trash-a@example.test");
    ownerB = await seedUser("trash-b@example.test");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("groups current trash deterministically without leaking storage or another tenant", async () => {
    const folderBatchId = "10000000-0000-4000-8000-000000000001";
    const zeroPatternBatchId = "20000000-0000-4000-8000-000000000002";
    const patternBatchId = "30000000-0000-4000-8000-000000000003";
    const hiddenBatchId = "40000000-0000-4000-8000-000000000004";
    const folderPurgeOperationId = "50000000-0000-4000-8000-000000000005";
    const patternPurgeOperationId = "60000000-0000-4000-8000-000000000006";
    const earliest = new Date("2026-01-02T03:04:05.000Z");
    const middle = new Date("2026-01-03T03:04:05.000Z");
    const newest = new Date("2026-01-04T03:04:05.000Z");

    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "夏日果园",
      status: "deleting",
      trashBatchId: folderBatchId,
      trashedAt: earliest,
    });
    const childId = await seedFolder({
      ownerId: ownerA,
      name: "柑橘",
      parentId: rootId,
      status: "deleting",
      trashBatchId: folderBatchId,
      trashedAt: newest,
    });
    await seedFolder({
      ownerId: ownerA,
      name: "柠檬",
      parentId: childId,
      status: "deleting",
      trashBatchId: folderBatchId,
      trashedAt: middle,
    });
    const folderPatternId = await seedPattern({
      ownerId: ownerA,
      name: "Folder pattern",
      folderId: childId,
      status: "deleting",
      preTrashStatus: "ready",
      trashBatchId: folderBatchId,
      trashedAt: middle,
      lastErrorCode: "ZZZ_FAILURE",
    });
    await seedPattern({
      ownerId: ownerA,
      name: "Deleting folder pattern",
      folderId: rootId,
      status: "deleting",
      preTrashStatus: "failed",
      trashBatchId: folderBatchId,
      trashedAt: newest,
      lastErrorCode: "AAA_FAILURE",
    });
    const previewAssetId = randomUUID();
    await db.insert(assets).values({
      id: previewAssetId,
      ownerId: ownerA,
      patternId: folderPatternId,
      role: "preview",
      objectKey: `users/${ownerA}/private/secret.png`,
      originalFilename: "secret.png",
      detectedMimeType: "image/png",
      sizeBytes: 12n,
    });

    const zeroRootId = await seedFolder({
      ownerId: ownerA,
      name: "Empty folder",
      status: "trashed",
      trashBatchId: zeroPatternBatchId,
      trashedAt: middle,
    });

    const ordinaryLowId = await seedPattern({
      ownerId: ownerA,
      id: lowId,
      name: "Ordinary low",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: patternBatchId,
      trashedAt: middle,
      lastErrorCode: "Z_ERROR",
    });
    const ordinaryHighId = await seedPattern({
      ownerId: ownerA,
      id: highId,
      name: "Ordinary high",
      status: "deleting",
      preTrashStatus: "failed",
      trashBatchId: patternBatchId,
      trashedAt: newest,
      lastErrorCode: "A_ERROR",
    });
    await seedPattern({
      ownerId: ownerA,
      name: "No batch",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: null,
      trashedAt: newest,
    });
    await seedPattern({
      ownerId: ownerA,
      name: "Deleted only",
      status: "deleted",
      preTrashStatus: null,
      trashBatchId: hiddenBatchId,
      trashedAt: earliest,
    });
    await db.insert(operations).values({
      ownerId: ownerA,
      operationId: hiddenBatchId,
      kind: "pattern.trash:empty",
      result: {},
    });
    const foreignPatternId = await seedPattern({
      ownerId: ownerB,
      name: "Other tenant",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: patternBatchId,
      trashedAt: newest,
    });
    await db.insert(operations).values([
      {
        ownerId: ownerA,
        operationId: folderPurgeOperationId,
        kind: createOperationKey("trash.folder-batch.purge", {
          trashBatchId: folderBatchId,
        }),
        result: {
          state: "pending",
          target: { kind: "folder_batch", trashBatchId: folderBatchId },
        },
      },
      {
        ownerId: ownerA,
        operationId: patternPurgeOperationId,
        kind: createOperationKey("trash.patterns.purge", {
          patternIds: [ordinaryHighId],
        }),
        result: {
          state: "pending",
          target: { kind: "patterns", patternIds: [ordinaryHighId] },
        },
      },
    ]);

    const result = await listTrash({ ownerId: ownerA });

    expect(result.folderBatches).toEqual([
      {
        trashBatchId: folderBatchId,
        rootFolderId: rootId,
        rootFolderName: "夏日果园",
        folderCount: 3,
        patternCount: 2,
        state: "deleting",
        lastErrorCode: "AAA_FAILURE",
        purgeOperationId: folderPurgeOperationId,
        trashedAt: newest.toISOString(),
        expiresAt: new Date(earliest.getTime() + 30 * DAY_MS).toISOString(),
        activeAuthorizationCount: 0,
        activeRevenueFen: "0",
        totalAuthorizationCount: 0,
        assetCount: 1,
      },
      {
        trashBatchId: zeroPatternBatchId,
        rootFolderId: zeroRootId,
        rootFolderName: "Empty folder",
        folderCount: 1,
        patternCount: 0,
        state: "trashed",
        lastErrorCode: null,
        purgeOperationId: null,
        trashedAt: middle.toISOString(),
        expiresAt: new Date(middle.getTime() + 30 * DAY_MS).toISOString(),
        activeAuthorizationCount: 0,
        activeRevenueFen: "0",
        totalAuthorizationCount: 0,
        assetCount: 0,
      },
    ]);
    expect(result.patternBatches).toEqual([
      {
        trashBatchId: patternBatchId,
        state: "deleting",
        lastErrorCode: "A_ERROR",
        purgeOperationId: patternPurgeOperationId,
        trashedAt: newest.toISOString(),
        expiresAt: new Date(middle.getTime() + 30 * DAY_MS).toISOString(),
        activeAuthorizationCount: 0,
        activeRevenueFen: "0",
        totalAuthorizationCount: 0,
        assetCount: 0,
        patterns: [
          {
            id: ordinaryHighId,
            name: "Ordinary high",
            originalFilename: "Ordinary high.psd",
            extension: "psd",
            sizeBytes: "1024",
            folderId: null,
            status: "deleting",
            previewStatus: "ready",
            previewAssetId: null,
            thumbnailAssetId: null,
            version: 0,
            lastErrorCode: "A_ERROR",
            trashedAt: newest.toISOString(),
            activeAuthorizationCount: 0,
            activeRevenueFen: "0",
            totalAuthorizationCount: 0,
            assetCount: 0,
          },
          {
            id: ordinaryLowId,
            name: "Ordinary low",
            originalFilename: "Ordinary low.psd",
            extension: "psd",
            sizeBytes: "1024",
            folderId: null,
            status: "trashed",
            previewStatus: "ready",
            previewAssetId: null,
            thumbnailAssetId: null,
            version: 0,
            lastErrorCode: "Z_ERROR",
            trashedAt: middle.toISOString(),
            activeAuthorizationCount: 0,
            activeRevenueFen: "0",
            totalAuthorizationCount: 0,
            assetCount: 0,
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain("secret.png");
    expect(serialized).not.toContain(foreignPatternId);
    expect(serialized).not.toContain("sourceAssetId");
  });

  it.each([
    "multiple roots",
    "no root",
    "null timestamp",
    "non-trash folder",
  ])(
    "rejects a corrupt %s trash read instead of inventing a batch",
    async (corruption) => {
      const batchId = randomUUID();
      if (corruption === "multiple roots") {
        await seedFolder({
          ownerId: ownerA,
          name: "Root A",
          status: "trashed",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
        await seedFolder({
          ownerId: ownerA,
          name: "Root B",
          status: "trashed",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
      } else if (corruption === "no root") {
        const firstId = await seedFolder({
          ownerId: ownerA,
          name: "First",
          status: "trashed",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
        const secondId = await seedFolder({
          ownerId: ownerA,
          name: "Second",
          parentId: firstId,
          status: "trashed",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
        await db
          .update(folders)
          .set({ parentId: secondId })
          .where(eq(folders.id, firstId));
      } else if (corruption === "null timestamp") {
        await seedPattern({
          ownerId: ownerA,
          name: "Missing timestamp",
          status: "trashed",
          preTrashStatus: "ready",
          trashBatchId: batchId,
          trashedAt: null,
        });
      } else {
        await seedFolder({
          ownerId: ownerA,
          name: "Invalid active folder",
          status: "active",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
        await seedPattern({
          ownerId: ownerA,
          name: "Must not become ordinary",
          status: "trashed",
          preTrashStatus: "ready",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
      }

      await expectAppError(
        listTrash({ ownerId: ownerA }),
        "INTERNAL_ERROR",
        500,
      );
    },
  );

  it.each(["trashed", "deleting", "deleted"] as const)(
    "rejects an ordinary trash batch that points into a %s folder batch",
    async (folderStatus) => {
      const folderBatchId = randomUUID();
      const patternBatchId = randomUUID();
      const folderId = await seedFolder({
        ownerId: ownerA,
        name: `${folderStatus} folder`,
        status: folderStatus,
        trashBatchId: folderBatchId,
        trashedAt: new Date(),
      });
      await seedPattern({
        ownerId: ownerA,
        name: "Wrong batch pattern",
        folderId,
        status: "trashed",
        preTrashStatus: "ready",
        trashBatchId: patternBatchId,
        trashedAt: new Date(),
      });

      await expectAppError(
        listTrash({ ownerId: ownerA }),
        "INTERNAL_ERROR",
        500,
      );
    },
  );

  it("rejects a folder batch collision from a pattern in an active outside folder", async () => {
    const folderBatchId = randomUUID();
    await seedFolder({
      ownerId: ownerA,
      name: "Folder batch root",
      status: "trashed",
      trashBatchId: folderBatchId,
      trashedAt: new Date(),
    });
    const outsideFolderId = await seedFolder({
      ownerId: ownerA,
      name: "Active outside folder",
    });
    await seedPattern({
      ownerId: ownerA,
      name: "Colliding outside pattern",
      folderId: outsideFolderId,
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: folderBatchId,
      trashedAt: new Date(),
    });

    await expectAppError(
      listTrash({ ownerId: ownerA }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("lists an ordinary trash batch stored in an active folder", async () => {
    const folderId = await seedFolder({
      ownerId: ownerA,
      name: "Active ordinary folder",
    });
    const patternBatchId = randomUUID();
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Active folder ordinary pattern",
      folderId,
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: patternBatchId,
      trashedAt: new Date(),
    });

    const result = await listTrash({ ownerId: ownerA });

    expect(result.folderBatches).toEqual([]);
    expect(result.patternBatches).toEqual([
      expect.objectContaining({
        trashBatchId: patternBatchId,
        patterns: [
          expect.objectContaining({ id: patternId, folderId }),
        ],
      }),
    ]);
  });

  it("restores a selected ordinary subset with one sorted event and strict replay", async () => {
    const batchId = randomUUID();
    const trashedAt = new Date("2026-02-03T04:05:06.000Z");
    const targetFolderId = await seedFolder({
      ownerId: ownerA,
      name: "Target",
    });
    const lowPatternId = await seedPattern({
      ownerId: ownerA,
      id: lowId,
      name: "Low",
      folderId: targetFolderId,
      status: "trashed",
      preTrashStatus: "ready",
      version: 4,
      trashBatchId: batchId,
      trashedAt,
      lastErrorCode: "OLD_ERROR",
      changeSeq: 7n,
    });
    const highPatternId = await seedPattern({
      ownerId: ownerA,
      id: highId,
      name: "High",
      folderId: null,
      status: "trashed",
      preTrashStatus: "failed",
      version: 8,
      trashBatchId: batchId,
      trashedAt,
      changeSeq: 9n,
    });
    const untouchedId = await seedPattern({
      ownerId: ownerA,
      name: "Untouched",
      status: "trashed",
      preTrashStatus: "ready",
      version: 2,
      trashBatchId: batchId,
      trashedAt,
    });
    const assetId = randomUUID();
    const tagId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      ownerId: ownerA,
      patternId: lowPatternId,
      role: "source",
      objectKey: `users/${ownerA}/patterns/${lowPatternId}/source.psd`,
      originalFilename: "low.psd",
      sizeBytes: 1024n,
    });
    await db.insert(tags).values({
      id: tagId,
      ownerId: ownerA,
      name: "Keep",
      normalizedName: "keep",
      colorToken: "green",
    });
    await db.insert(patternTags).values({
      ownerId: ownerA,
      patternId: lowPatternId,
      tagId,
    });
    const assetsBefore = await db.select().from(assets);
    const tagsBefore = await db.select().from(tags);
    const relationsBefore = await db.select().from(patternTags);
    const operationId = randomUUID();

    const result = await restorePatterns({
      ownerId: ownerA,
      operationId,
      patternIds: [highPatternId.toUpperCase(), lowPatternId.toUpperCase()],
    });

    expect(result).toEqual({
      state: "restored",
      patterns: [
        expect.objectContaining({
          id: lowPatternId,
          status: "ready",
          folderId: targetFolderId,
          version: 5,
          changeSeq: "1",
        }),
        expect.objectContaining({
          id: highPatternId,
          status: "failed",
          folderId: null,
          version: 9,
          changeSeq: "1",
        }),
      ],
    });
    const restored = await readPatterns(ownerA, [highPatternId, lowPatternId]);
    expect(restored).toEqual([
      expect.objectContaining({
        id: lowPatternId,
        status: "ready",
        folderId: targetFolderId,
        preTrashStatus: null,
        trashBatchId: null,
        trashedAt: null,
        lastErrorCode: null,
        version: 5,
        changeSeq: 1n,
      }),
      expect.objectContaining({
        id: highPatternId,
        status: "failed",
        folderId: null,
        preTrashStatus: null,
        trashBatchId: null,
        trashedAt: null,
        lastErrorCode: null,
        version: 9,
        changeSeq: 1n,
      }),
    ]);
    expect(restored[0]?.updatedAt.getTime()).toBe(
      restored[1]?.updatedAt.getTime(),
    );
    await expect(readPatterns(ownerA, [untouchedId])).resolves.toEqual([
      expect.objectContaining({
        id: untouchedId,
        status: "trashed",
        trashBatchId: batchId,
        version: 2,
      }),
    ]);
    expect(await readChanges(ownerA)).toEqual([
      expect.objectContaining({
        seq: 1n,
        operationId,
        entityType: "pattern_batch",
        entityId: operationId,
        operation: "patterns.restored",
        payload: { patternIds: [lowPatternId, highPatternId] },
      }),
    ]);
    expect(await readSyncSeq(ownerA)).toBe(1n);
    expect(await db.select().from(assets)).toEqual(assetsBefore);
    expect(await db.select().from(tags)).toEqual(tagsBefore);
    expect(await db.select().from(patternTags)).toEqual(relationsBefore);

    await expect(
      restorePatterns({
        ownerId: ownerA,
        operationId,
        patternIds: [lowPatternId, highPatternId],
      }),
    ).resolves.toEqual(result);
    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readOperations(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("rejects missing and foreign ordinary patterns with the same neutral error", async () => {
    const ownId = await seedPattern({
      ownerId: ownerA,
      name: "Own",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: randomUUID(),
      trashedAt: new Date(),
    });
    const foreignId = await seedPattern({
      ownerId: ownerB,
      name: "Foreign",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: randomUUID(),
      trashedAt: new Date(),
    });

    for (const targetId of [foreignId, randomUUID()]) {
      await expectAppError(
        restorePatterns({
          ownerId: ownerA,
          operationId: randomUUID(),
          patternIds: [ownId, targetId],
        }),
        "NOT_FOUND",
        404,
      );
    }
    await expect(readPatterns(ownerA, [ownId])).resolves.toEqual([
      expect.objectContaining({ id: ownId, status: "trashed", version: 0 }),
    ]);
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readChanges(ownerA)).toEqual([]);
  });

  it.each([
    ["active", "ready", null, "PATTERN_STATE_CHANGED", 409],
    ["deleted", "deleted", null, "PATTERN_STATE_CHANGED", 409],
    ["missing pre-trash state", "trashed", null, "PATTERN_STATE_CHANGED", 409],
    ["purge in progress", "deleting", "ready", "TRASH_PURGE_IN_PROGRESS", 409],
  ] as const)(
    "rejects an ordinary pattern with %s without partial writes",
    async (_name, status, preTrashStatus, code, httpStatus) => {
      const validId = await seedPattern({
        ownerId: ownerA,
        name: "Valid",
        status: "trashed",
        preTrashStatus: "ready",
        trashBatchId: randomUUID(),
        trashedAt: new Date(),
      });
      const invalidId = await seedPattern({
        ownerId: ownerA,
        name: "Invalid",
        status,
        preTrashStatus,
        trashBatchId: randomUUID(),
        trashedAt: new Date(),
      });

      await expectAppError(
        restorePatterns({
          ownerId: ownerA,
          operationId: randomUUID(),
          patternIds: [validId, invalidId],
        }),
        code,
        httpStatus,
      );
      expect(await readPatterns(ownerA, [validId, invalidId])).toEqual([
        expect.objectContaining({ status: expect.any(String), version: 0 }),
        expect.objectContaining({ status: expect.any(String), version: 0 }),
      ]);
      expect(await readOperations(ownerA)).toEqual([]);
      expect(await readChanges(ownerA)).toEqual([]);
    },
  );

  it("requires a folder batch action for every pattern in a folder batch", async () => {
    const batchId = randomUUID();
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Folder batch",
      status: "trashed",
      trashBatchId: batchId,
      trashedAt: new Date(),
    });
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Folder child",
      folderId: rootId,
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: batchId,
      trashedAt: new Date(),
    });

    await expectAppError(
      restorePatterns({
        ownerId: ownerA,
        operationId: randomUUID(),
        patternIds: [patternId],
      }),
      "FOLDER_BATCH_ACTION_REQUIRED",
      409,
    );
    await expect(readPatterns(ownerA, [patternId])).resolves.toEqual([
      expect.objectContaining({ status: "trashed", version: 0 }),
    ]);
  });

  it.each(["trashed", "deleting", "deleted"] as const)(
    "rejects ordinary restore into a %s folder without any writes",
    async (folderStatus) => {
      const folderId = await seedFolder({
        ownerId: ownerA,
        name: `${folderStatus} restore target`,
        status: folderStatus,
        trashBatchId: randomUUID(),
        trashedAt: new Date(),
      });
      const patternId = await seedPattern({
        ownerId: ownerA,
        name: "Invalid restore target",
        folderId,
        status: "trashed",
        preTrashStatus: "ready",
        version: 3,
        trashBatchId: randomUUID(),
        trashedAt: new Date(),
      });
      const folderBefore = await readFolders(ownerA, [folderId]);
      const patternBefore = await readPatterns(ownerA, [patternId]);

      await expectAppError(
        restorePatterns({
          ownerId: ownerA,
          operationId: randomUUID(),
          patternIds: [patternId],
        }),
        "PATTERN_STATE_CHANGED",
        409,
      );

      expect(await readFolders(ownerA, [folderId])).toEqual(folderBefore);
      expect(await readPatterns(ownerA, [patternId])).toEqual(patternBefore);
      expect(await readOperations(ownerA)).toEqual([]);
      expect(await readChanges(ownerA)).toEqual([]);
      expect(await readSyncSeq(ownerA)).toBe(0n);
    },
  );

  it("binds ordinary-pattern operation IDs to the exact sorted selection", async () => {
    const firstId = await seedPattern({
      ownerId: ownerA,
      name: "First",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: randomUUID(),
      trashedAt: new Date(),
    });
    const secondId = await seedPattern({
      ownerId: ownerA,
      name: "Second",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: randomUUID(),
      trashedAt: new Date(),
    });
    const operationId = randomUUID();
    await restorePatterns({ ownerId: ownerA, operationId, patternIds: [firstId] });

    await expectAppError(
      restorePatterns({
        ownerId: ownerA,
        operationId,
        patternIds: [secondId],
      }),
      "OPERATION_ID_REUSED",
      409,
    );
    await expect(readPatterns(ownerA, [secondId])).resolves.toEqual([
      expect.objectContaining({ status: "trashed", version: 0 }),
    ]);
  });

  it("linearizes concurrent replays of the same ordinary restore", async () => {
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Concurrent",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: randomUUID(),
      trashedAt: new Date(),
    });
    const operationId = randomUUID();
    const call = () =>
      restorePatterns({ ownerId: ownerA, operationId, patternIds: [patternId] });

    const [first, second] = await withTimeout(Promise.all([call(), call()]));

    expect(second).toEqual(first);
    await expect(readPatterns(ownerA, [patternId])).resolves.toEqual([
      expect.objectContaining({ status: "ready", version: 1, changeSeq: 1n }),
    ]);
    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readOperations(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("linearizes ordinary restore against folder-tree trash without deadlock", async () => {
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blocker = postgres(databaseUrl, { max: 1 });
    const monitor = postgres(databaseUrl, { max: 1 });
    const folderId = await seedFolder({
      ownerId: ownerA,
      name: "Concurrent ordinary restore folder",
    });
    const patternBatchId = randomUUID();
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Concurrent ordinary restore pattern",
      folderId,
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: patternBatchId,
      trashedAt: new Date(),
    });
    const restoreOperationId = randomUUID();
    const trashOperationId = randomUUID();
    const expectedImpact = await getFolderDeleteImpact({
      ownerId: ownerA,
      folderId,
    });
    const lockReady = deferred<void>();
    const releaseLock = deferred<void>();
    let blockerPid = 0;
    let released = false;
    const blockerTransaction = blocker.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`
        select pg_backend_pid() as pid
      `;
      blockerPid = backend!.pid;
      await tx`
        select id
        from patterns
        where owner_id = ${ownerA}
          and id = ${patternId}
        for update
      `;
      lockReady.resolve();
      await releaseLock.promise;
    });
    let restore: ReturnType<typeof restorePatterns> | undefined;
    let trash: ReturnType<typeof trashFolderTree> | undefined;

    try {
      await withTimeout(lockReady.promise);
      restore = restorePatterns({
        ownerId: ownerA,
        operationId: restoreOperationId,
        patternIds: [patternId],
      });
      void restore.catch(() => undefined);
      const restorePid = await waitForPatternLockWaiter(
        monitor,
        [blockerPid],
      );

      trash = trashFolderTree({
        ownerId: ownerA,
        folderId,
        operationId: trashOperationId,
        version: 0,
        expectedImpact,
      });
      void trash.catch(() => undefined);
      const trashPid = await waitForPatternLockWaiter(
        monitor,
        [blockerPid, restorePid],
        [restorePid],
      );
      expect(trashPid).not.toBe(restorePid);

      released = true;
      releaseLock.resolve();
      await withTimeout(blockerTransaction);
      const restoreResult = await withTimeout(restore);
      await expect(withTimeout(trash)).rejects.toMatchObject({
        code: "FOLDER_DELETE_SCOPE_CHANGED",
        status: 409,
        details: {
          folderCount: 1,
          patternCount: 1,
          alreadyTrashedPatternCount: 0,
        },
      });

      expect(restoreResult).toEqual({
        state: "restored",
        patterns: [
          expect.objectContaining({
            id: patternId,
            status: "ready",
            folderId,
            version: 1,
            changeSeq: "1",
          }),
        ],
      });
      await expect(readFolders(ownerA, [folderId])).resolves.toEqual([
        expect.objectContaining({
          id: folderId,
          status: "active",
          trashBatchId: null,
          version: 0,
          changeSeq: 0n,
        }),
      ]);
      await expect(readPatterns(ownerA, [patternId])).resolves.toEqual([
        expect.objectContaining({
          id: patternId,
          folderId,
          status: "ready",
          preTrashStatus: null,
          trashBatchId: null,
          version: 1,
          changeSeq: 1n,
        }),
      ]);
      expect(await readChanges(ownerA)).toEqual([
        expect.objectContaining({
          seq: 1n,
          operationId: restoreOperationId,
          operation: "patterns.restored",
        }),
      ]);
      expect(await readOperations(ownerA)).toHaveLength(1);
      expect(await readSyncSeq(ownerA)).toBe(1n);
    } finally {
      if (!released) releaseLock.resolve();
      await Promise.allSettled([
        blockerTransaction,
        ...(restore ? [restore] : []),
        ...(trash ? [trash] : []),
      ]);
      await Promise.all([
        blocker.end({ timeout: 1 }),
        monitor.end({ timeout: 1 }),
      ]);
    }
  }, 10_000);

  it("rejects a malformed stored ordinary replay result", async () => {
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Replay",
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: randomUUID(),
      trashedAt: new Date(),
    });
    const operationId = randomUUID();
    await restorePatterns({ ownerId: ownerA, operationId, patternIds: [patternId] });
    await db
      .update(operations)
      .set({ result: { state: "restored", patterns: [] } })
      .where(
        and(
          eq(operations.ownerId, ownerA),
          eq(operations.operationId, operationId),
        ),
      );

    await expectAppError(
      restorePatterns({ ownerId: ownerA, operationId, patternIds: [patternId] }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("restores one complete folder tree atomically and preserves hierarchy and assets", async () => {
    const batchId = randomUUID();
    const outsideParentId = await seedFolder({
      ownerId: ownerA,
      name: "Outside active parent",
    });
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Root",
      parentId: outsideParentId,
      status: "trashed",
      version: 4,
      trashBatchId: batchId,
      trashedAt: new Date("2026-01-01T00:00:00.000Z"),
      changeSeq: 7n,
    });
    const childId = await seedFolder({
      ownerId: ownerA,
      name: "Child",
      parentId: rootId,
      status: "trashed",
      version: 5,
      trashBatchId: batchId,
      trashedAt: new Date("2026-01-01T00:00:00.000Z"),
      changeSeq: 8n,
    });
    const grandchildId = await seedFolder({
      ownerId: ownerA,
      name: "Grandchild",
      parentId: childId,
      status: "trashed",
      version: 6,
      trashBatchId: batchId,
      trashedAt: new Date("2026-01-01T00:00:00.000Z"),
      changeSeq: 9n,
    });
    const readyId = await seedPattern({
      ownerId: ownerA,
      name: "Ready",
      folderId: childId,
      status: "trashed",
      preTrashStatus: "ready",
      version: 10,
      trashBatchId: batchId,
      trashedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastErrorCode: "OLD_ERROR",
    });
    const failedId = await seedPattern({
      ownerId: ownerA,
      name: "Failed",
      folderId: grandchildId,
      status: "trashed",
      preTrashStatus: "failed",
      version: 11,
      trashBatchId: batchId,
      trashedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const assetId = randomUUID();
    const tagId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      ownerId: ownerA,
      patternId: readyId,
      role: "source",
      objectKey: `users/${ownerA}/patterns/${readyId}/source.psd`,
      originalFilename: "ready.psd",
      sizeBytes: 1024n,
    });
    await db.insert(tags).values({
      id: tagId,
      ownerId: ownerA,
      name: "Keep",
      normalizedName: "keep",
      colorToken: "blue",
    });
    await db.insert(patternTags).values({
      ownerId: ownerA,
      patternId: readyId,
      tagId,
    });
    const assetsBefore = await db.select().from(assets);
    const tagsBefore = await db.select().from(tags);
    const relationsBefore = await db.select().from(patternTags);
    const operationId = randomUUID();

    const result = await restoreFolderBatch({
      ownerId: ownerA,
      operationId,
      trashBatchId: batchId,
    });

    expect(result).toEqual({
      state: "restored",
      trashBatchId: batchId,
      rootFolderId: rootId,
      folderCount: 3,
      patternCount: 2,
    });
    const restoredFolders = await readFolders(ownerA, [
      rootId,
      childId,
      grandchildId,
    ]);
    const restoredPatterns = await readPatterns(ownerA, [readyId, failedId]);
    expect(restoredFolders).toEqual([
      expect.objectContaining({
        status: "active",
        trashBatchId: null,
        trashedAt: null,
        changeSeq: 1n,
      }),
      expect.objectContaining({
        status: "active",
        trashBatchId: null,
        trashedAt: null,
        changeSeq: 1n,
      }),
      expect.objectContaining({
        status: "active",
        trashBatchId: null,
        trashedAt: null,
        changeSeq: 1n,
      }),
    ]);
    expect(restoredFolders.find((row) => row.id === rootId)?.parentId).toBe(
      outsideParentId,
    );
    expect(restoredFolders.find((row) => row.id === childId)?.parentId).toBe(
      rootId,
    );
    expect(
      restoredFolders.find((row) => row.id === grandchildId)?.parentId,
    ).toBe(childId);
    expect(restoredPatterns).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        status: expect.any(String),
        preTrashStatus: null,
        trashBatchId: null,
        trashedAt: null,
        lastErrorCode: null,
        changeSeq: 1n,
      }),
      expect.objectContaining({
        id: expect.any(String),
        status: expect.any(String),
        preTrashStatus: null,
        trashBatchId: null,
        trashedAt: null,
        lastErrorCode: null,
        changeSeq: 1n,
      }),
    ]);
    expect(restoredPatterns.find((row) => row.id === readyId)).toMatchObject({
      folderId: childId,
      status: "ready",
      version: 11,
    });
    expect(restoredPatterns.find((row) => row.id === failedId)).toMatchObject({
      folderId: grandchildId,
      status: "failed",
      version: 12,
    });
    const sharedUpdatedAt = restoredFolders[0]?.updatedAt.getTime();
    expect(
      [...restoredFolders, ...restoredPatterns].every(
        (row) => row.updatedAt.getTime() === sharedUpdatedAt,
      ),
    ).toBe(true);
    expect(await readChanges(ownerA)).toEqual([
      expect.objectContaining({
        seq: 1n,
        operationId,
        entityType: "folder_tree",
        entityId: rootId,
        operation: "folder_tree.restored",
        payload: {
          rootFolderId: rootId,
          folderIds: [...[rootId, childId, grandchildId]].sort(),
          patternIds: [...[readyId, failedId]].sort(),
        },
      }),
    ]);
    expect(await db.select().from(assets)).toEqual(assetsBefore);
    expect(await db.select().from(tags)).toEqual(tagsBefore);
    expect(await db.select().from(patternTags)).toEqual(relationsBefore);

    await expect(
      restoreFolderBatch({ ownerId: ownerA, operationId, trashBatchId: batchId }),
    ).resolves.toEqual(result);
    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("serializes folder-batch restore with a real hierarchy writer", async () => {
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blocker = postgres(databaseUrl, { max: 1 });
    const monitor = postgres(databaseUrl, { max: 1 });
    const batchId = randomUUID();
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Blocked restore root",
      status: "trashed",
      trashBatchId: batchId,
      trashedAt: new Date(),
    });
    const restoreOperationId = randomUUID();
    const createOperationId = randomUUID();
    const lockReady = deferred<void>();
    const releaseLock = deferred<void>();
    let blockerPid = 0;
    let released = false;
    const blockerTransaction = blocker.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`
        select pg_backend_pid() as pid
      `;
      blockerPid = backend!.pid;
      await tx`select pg_advisory_xact_lock(hashtextextended(${ownerA}, 0))`;
      lockReady.resolve();
      await releaseLock.promise;
    });
    let restore: ReturnType<typeof restoreFolderBatch> | undefined;
    let create: ReturnType<typeof createFolder> | undefined;

    try {
      await withTimeout(lockReady.promise);
      restore = restoreFolderBatch({
        ownerId: ownerA,
        operationId: restoreOperationId,
        trashBatchId: batchId,
      });
      create = createFolder({
        ownerId: ownerA,
        operationId: createOperationId,
        name: "Concurrent child",
        parentId: rootId,
      });
      void restore.catch(() => undefined);
      void create.catch(() => undefined);

      const blockedPids = await waitForBlockedAdvisoryPids(
        monitor,
        blockerPid,
        2,
      );
      expect(new Set(blockedPids).size).toBeGreaterThanOrEqual(2);

      released = true;
      releaseLock.resolve();
      await withTimeout(blockerTransaction);
      const [restoreOutcome, createOutcome] = await withTimeout(
        Promise.allSettled([restore, create]),
      );

      expect(restoreOutcome).toEqual({
        status: "fulfilled",
        value: {
          state: "restored",
          trashBatchId: batchId,
          rootFolderId: rootId,
          folderCount: 1,
          patternCount: 0,
        },
      });
      await expect(readFolders(ownerA, [rootId])).resolves.toEqual([
        expect.objectContaining({ id: rootId, status: "active", version: 1 }),
      ]);
      if (createOutcome.status === "fulfilled") {
        await expect(
          readFolders(ownerA, [createOutcome.value.id]),
        ).resolves.toEqual([
          expect.objectContaining({
            id: createOutcome.value.id,
            parentId: rootId,
            status: "active",
          }),
        ]);
      } else {
        expect(createOutcome.reason).toMatchObject({
          code: "FOLDER_NOT_ACTIVE",
          status: 409,
        });
      }
    } finally {
      if (!released) releaseLock.resolve();
      await Promise.allSettled([
        blockerTransaction,
        ...(restore ? [restore] : []),
        ...(create ? [create] : []),
      ]);
      await Promise.all([
        blocker.end({ timeout: 1 }),
        monitor.end({ timeout: 1 }),
      ]);
    }
  }, 10_000);

  it("linearizes concurrent identical folder restores into one complete replay", async () => {
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blocker = postgres(databaseUrl, { max: 1 });
    const monitor = postgres(databaseUrl, { max: 1 });

    try {
      for (let round = 0; round < 3; round += 1) {
        const batchId = randomUUID();
        const rootId = await seedFolder({
          ownerId: ownerA,
          name: `Concurrent restore root ${round}`,
          status: "trashed",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
        const patternId = await seedPattern({
          ownerId: ownerA,
          name: `Concurrent restore pattern ${round}`,
          folderId: rootId,
          status: "trashed",
          preTrashStatus: "ready",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
        const operationId = randomUUID();
        const input = { ownerId: ownerA, operationId, trashBatchId: batchId };
        const lockReady = deferred<void>();
        const releaseLock = deferred<void>();
        let blockerPid = 0;
        let released = false;
        const blockerTransaction = blocker.begin(async (tx) => {
          const [backend] = await tx<{ pid: number }[]>`
            select pg_backend_pid() as pid
          `;
          blockerPid = backend!.pid;
          await tx`select pg_advisory_xact_lock(hashtextextended(${ownerA}, 0))`;
          lockReady.resolve();
          await releaseLock.promise;
        });
        let first: ReturnType<typeof restoreFolderBatch> | undefined;
        let second: ReturnType<typeof restoreFolderBatch> | undefined;

        try {
          await withTimeout(lockReady.promise);
          first = restoreFolderBatch(input);
          void first.catch(() => undefined);
          const [firstWaiterPid] = await waitForBlockedAdvisoryPids(
            monitor,
            blockerPid,
            1,
          );
          second = restoreFolderBatch(input);
          void second.catch(() => undefined);
          const operationWaiterPid = await waitForOperationClaimWaiter(monitor);
          expect(operationWaiterPid).not.toBe(firstWaiterPid);

          released = true;
          releaseLock.resolve();
          await withTimeout(blockerTransaction);
          const [firstResult, secondResult] = await withTimeout(
            Promise.all([first, second]),
          );

          expect(firstResult).toEqual({
            state: "restored",
            trashBatchId: batchId,
            rootFolderId: rootId,
            folderCount: 1,
            patternCount: 1,
          });
          expect(secondResult).toEqual(firstResult);
          await expect(readFolders(ownerA, [rootId])).resolves.toEqual([
            expect.objectContaining({
              id: rootId,
              status: "active",
              version: 1,
              changeSeq: BigInt(round + 1),
            }),
          ]);
          await expect(readPatterns(ownerA, [patternId])).resolves.toEqual([
            expect.objectContaining({
              id: patternId,
              status: "ready",
              version: 1,
              changeSeq: BigInt(round + 1),
            }),
          ]);
          expect(
            (await readChanges(ownerA)).filter(
              (change) => change.operationId === operationId,
            ),
          ).toHaveLength(1);
          expect(
            (await readOperations(ownerA)).filter(
              (operation) => operation.operationId === operationId,
            ),
          ).toEqual([
            expect.objectContaining({ operationId, result: firstResult }),
          ]);
          expect(await readSyncSeq(ownerA)).toBe(BigInt(round + 1));
        } finally {
          if (!released) releaseLock.resolve();
          await Promise.allSettled([
            blockerTransaction,
            ...(first ? [first] : []),
            ...(second ? [second] : []),
          ]);
        }
      }
    } finally {
      await Promise.all([
        blocker.end({ timeout: 1 }),
        monitor.end({ timeout: 1 }),
      ]);
    }
  }, 20_000);

  it("refuses a folder batch whose outside parent is no longer active", async () => {
    const batchId = randomUUID();
    const outsideParentId = await seedFolder({
      ownerId: ownerA,
      name: "Outside trashed parent",
      status: "trashed",
      trashBatchId: randomUUID(),
      trashedAt: new Date(),
    });
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Root",
      parentId: outsideParentId,
      status: "trashed",
      trashBatchId: batchId,
      trashedAt: new Date(),
    });

    await expectAppError(
      restoreFolderBatch({
        ownerId: ownerA,
        operationId: randomUUID(),
        trashBatchId: batchId,
      }),
      "FOLDER_NOT_ACTIVE",
      409,
    );
    await expect(readFolders(ownerA, [rootId])).resolves.toEqual([
      expect.objectContaining({ status: "trashed", version: 0 }),
    ]);
    expect(await readOperations(ownerA)).toEqual([]);
  });

  it("rejects deleting folders or patterns as purge in progress", async () => {
    for (const deletingEntity of ["folder", "pattern"] as const) {
      await resetDatabase();
      ownerA = await seedUser(`deleting-${deletingEntity}@example.test`);
      const batchId = randomUUID();
      const rootId = await seedFolder({
        ownerId: ownerA,
        name: "Root",
        status: deletingEntity === "folder" ? "deleting" : "trashed",
        trashBatchId: batchId,
        trashedAt: new Date(),
      });
      if (deletingEntity === "pattern") {
        await seedPattern({
          ownerId: ownerA,
          name: "Deleting",
          folderId: rootId,
          status: "deleting",
          preTrashStatus: "ready",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
      }

      await expectAppError(
        restoreFolderBatch({
          ownerId: ownerA,
          operationId: randomUUID(),
          trashBatchId: batchId,
        }),
        "TRASH_PURGE_IN_PROGRESS",
        409,
      );
      expect(await readOperations(ownerA)).toEqual([]);
      expect(await readChanges(ownerA)).toEqual([]);
    }
  });

  it.each(["missing", "foreign", "ordinary"] as const)(
    "returns a neutral missing-batch error for a %s folder-batch target",
    async (kind) => {
      const batchId = randomUUID();
      if (kind === "foreign") {
        await seedFolder({
          ownerId: ownerB,
          name: "Foreign",
          status: "trashed",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
      } else if (kind === "ordinary") {
        await seedPattern({
          ownerId: ownerA,
          name: "Ordinary",
          status: "trashed",
          preTrashStatus: "ready",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
      }

      await expectAppError(
        restoreFolderBatch({
          ownerId: ownerA,
          operationId: randomUUID(),
          trashBatchId: batchId,
        }),
        "TRASH_BATCH_NOT_FOUND",
        404,
      );
      expect(await readOperations(ownerA)).toEqual([]);
    },
  );

  it.each(["multiple roots", "partial subtree", "deleted member", "active member"])(
    "rejects a corrupt folder batch with %s without partial writes",
    async (corruption) => {
      const batchId = randomUUID();
      const rootId = await seedFolder({
        ownerId: ownerA,
        name: "Root",
        status: "trashed",
        trashBatchId: batchId,
        trashedAt: new Date(),
      });
      if (corruption === "multiple roots") {
        await seedFolder({
          ownerId: ownerA,
          name: "Other root",
          status: "trashed",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
      } else if (corruption === "partial subtree") {
        await seedFolder({
          ownerId: ownerA,
          name: "Wrong batch child",
          parentId: rootId,
          status: "trashed",
          trashBatchId: randomUUID(),
          trashedAt: new Date(),
        });
      } else if (corruption === "deleted member") {
        await seedFolder({
          ownerId: ownerA,
          name: "Deleted child",
          parentId: rootId,
          status: "deleted",
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
      } else {
        await db
          .update(folders)
          .set({ status: "active" })
          .where(eq(folders.id, rootId));
      }

      await expectAppError(
        restoreFolderBatch({
          ownerId: ownerA,
          operationId: randomUUID(),
          trashBatchId: batchId,
        }),
        "TRASH_BATCH_NOT_FOUND",
        404,
      );
      await expect(readFolders(ownerA, [rootId])).resolves.toEqual([
        expect.objectContaining({ version: 0 }),
      ]);
      expect(await readOperations(ownerA)).toEqual([]);
      expect(await readChanges(ownerA)).toEqual([]);
    },
  );

  it.each([
    "wrong batch inside tree",
    "null batch inside tree",
    "same batch outside tree",
    "deleted inside tree",
  ] as const)(
    "rejects a folder batch with pattern membership corruption: %s",
    async (corruption) => {
      const batchId = randomUUID();
      const rootId = await seedFolder({
        ownerId: ownerA,
        name: "Pattern membership root",
        status: "trashed",
        version: 4,
        trashBatchId: batchId,
        trashedAt: new Date(),
      });
      const validPatternId = await seedPattern({
        ownerId: ownerA,
        name: "Valid batch pattern",
        folderId: rootId,
        status: "trashed",
        preTrashStatus: "ready",
        version: 5,
        trashBatchId: batchId,
        trashedAt: new Date(),
      });
      const folderIds = [rootId];
      let corruptPatternId: string;

      if (corruption === "wrong batch inside tree") {
        corruptPatternId = await seedPattern({
          ownerId: ownerA,
          name: "Wrong batch pattern",
          folderId: rootId,
          status: "trashed",
          preTrashStatus: "ready",
          version: 6,
          trashBatchId: randomUUID(),
          trashedAt: new Date(),
        });
      } else if (corruption === "null batch inside tree") {
        corruptPatternId = await seedPattern({
          ownerId: ownerA,
          name: "Null batch pattern",
          folderId: rootId,
          status: "trashed",
          preTrashStatus: "ready",
          version: 6,
          trashBatchId: null,
          trashedAt: new Date(),
        });
      } else if (corruption === "same batch outside tree") {
        const outsideFolderId = await seedFolder({
          ownerId: ownerA,
          name: "Outside active folder",
        });
        folderIds.push(outsideFolderId);
        corruptPatternId = await seedPattern({
          ownerId: ownerA,
          name: "Outside batch pattern",
          folderId: outsideFolderId,
          status: "trashed",
          preTrashStatus: "ready",
          version: 6,
          trashBatchId: batchId,
          trashedAt: new Date(),
        });
      } else {
        corruptPatternId = await seedPattern({
          ownerId: ownerA,
          name: "Deleted tree pattern",
          folderId: rootId,
          status: "deleted",
          preTrashStatus: null,
          version: 6,
          trashBatchId: null,
          trashedAt: new Date(),
        });
      }

      const patternIds = [validPatternId, corruptPatternId];
      const foldersBefore = await readFolders(ownerA, folderIds);
      const patternsBefore = await readPatterns(ownerA, patternIds);

      await expectAppError(
        restoreFolderBatch({
          ownerId: ownerA,
          operationId: randomUUID(),
          trashBatchId: batchId,
        }),
        "TRASH_BATCH_NOT_FOUND",
        404,
      );

      expect(await readFolders(ownerA, folderIds)).toEqual(foldersBefore);
      expect(await readPatterns(ownerA, patternIds)).toEqual(patternsBefore);
      expect(await readOperations(ownerA)).toEqual([]);
      expect(await readChanges(ownerA)).toEqual([]);
      expect(await readSyncSeq(ownerA)).toBe(0n);
    },
  );

  it("rejects a folder-batch pattern with no recoverable prior state", async () => {
    const batchId = randomUUID();
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Root",
      status: "trashed",
      trashBatchId: batchId,
      trashedAt: new Date(),
    });
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Broken",
      folderId: rootId,
      status: "trashed",
      preTrashStatus: null,
      trashBatchId: batchId,
      trashedAt: new Date(),
    });

    await expectAppError(
      restoreFolderBatch({
        ownerId: ownerA,
        operationId: randomUUID(),
        trashBatchId: batchId,
      }),
      "PATTERN_STATE_CHANGED",
      409,
    );
    await expect(readPatterns(ownerA, [patternId])).resolves.toEqual([
      expect.objectContaining({ status: "trashed", version: 0 }),
    ]);
  });

  it("maps only a known live folder-name unique violation and rolls back", async () => {
    const batchId = randomUUID();
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Root",
      status: "trashed",
      trashBatchId: batchId,
      trashedAt: new Date(),
    });
    await db.execute(sql.raw(`
      create function trash_test_name_conflict() returns trigger
      language plpgsql as $$
      begin
        raise unique_violation using
          constraint = 'folders_owner_root_name_live_unique';
      end;
      $$;
      create trigger trash_test_name_conflict_trigger
      before update on folders
      for each row execute function trash_test_name_conflict();
    `));

    try {
      await expectAppError(
        restoreFolderBatch({
          ownerId: ownerA,
          operationId: randomUUID(),
          trashBatchId: batchId,
        }),
        "FOLDER_NAME_CONFLICT",
        409,
      );
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists trash_test_name_conflict_trigger on folders;
        drop function if exists trash_test_name_conflict();
      `));
    }
    await expect(readFolders(ownerA, [rootId])).resolves.toEqual([
      expect.objectContaining({ status: "trashed", version: 0 }),
    ]);
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readChanges(ownerA)).toEqual([]);
  });

  it("rolls back folder updates when a later pattern update fails", async () => {
    const batchId = randomUUID();
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Root",
      status: "trashed",
      trashBatchId: batchId,
      trashedAt: new Date(),
    });
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Pattern",
      folderId: rootId,
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: batchId,
      trashedAt: new Date(),
    });
    await db.execute(sql.raw(`
      create function trash_test_pattern_failure() returns trigger
      language plpgsql as $$
      begin
        raise exception 'forced pattern restore failure';
      end;
      $$;
      create trigger trash_test_pattern_failure_trigger
      before update on patterns
      for each row execute function trash_test_pattern_failure();
    `));

    try {
      await expect(
        restoreFolderBatch({
          ownerId: ownerA,
          operationId: randomUUID(),
          trashBatchId: batchId,
        }),
      ).rejects.toBeDefined();
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists trash_test_pattern_failure_trigger on patterns;
        drop function if exists trash_test_pattern_failure();
      `));
    }
    await expect(readFolders(ownerA, [rootId])).resolves.toEqual([
      expect.objectContaining({ status: "trashed", version: 0 }),
    ]);
    await expect(readPatterns(ownerA, [patternId])).resolves.toEqual([
      expect.objectContaining({ status: "trashed", version: 0 }),
    ]);
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readChanges(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);
  });

  it("binds folder-batch operation replay to the exact trash batch", async () => {
    const firstBatchId = randomUUID();
    const secondBatchId = randomUUID();
    await seedFolder({
      ownerId: ownerA,
      name: "First",
      status: "trashed",
      trashBatchId: firstBatchId,
      trashedAt: new Date(),
    });
    const secondRootId = await seedFolder({
      ownerId: ownerA,
      name: "Second",
      status: "trashed",
      trashBatchId: secondBatchId,
      trashedAt: new Date(),
    });
    const operationId = randomUUID();
    await restoreFolderBatch({
      ownerId: ownerA,
      operationId,
      trashBatchId: firstBatchId,
    });

    await expectAppError(
      restoreFolderBatch({
        ownerId: ownerA,
        operationId,
        trashBatchId: secondBatchId,
      }),
      "OPERATION_ID_REUSED",
      409,
    );
    await expect(readFolders(ownerA, [secondRootId])).resolves.toEqual([
      expect.objectContaining({ status: "trashed", version: 0 }),
    ]);
  });
});
