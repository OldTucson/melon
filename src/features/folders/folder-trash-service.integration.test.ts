import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createFolder } from "@/features/folders/folder-service";
import { trashFolderTree } from "@/features/folders/folder-trash-service";
import { closeDatabase, db } from "@/lib/db/client";
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
import { resetDatabase } from "@/test/database";

type FolderStatus = NonNullable<typeof folders.$inferInsert.status>;
type PatternStatus = NonNullable<typeof patterns.$inferInsert.status>;

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
    normalizedName: input.name.toLowerCase(),
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
  folderId: string;
  name: string;
  id?: string;
  status?: PatternStatus;
  preTrashStatus?: PatternStatus | null;
  version?: number;
  trashBatchId?: string | null;
  trashedAt?: Date | null;
  changeSeq?: bigint;
  updatedAt?: Date;
}) => {
  const id = input.id ?? randomUUID();
  await db.insert(patterns).values({
    id,
    ownerId: input.ownerId,
    folderId: input.folderId,
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("FOLDER_TRASH_CONCURRENCY_TIMEOUT")),
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

async function waitForAdvisoryWaiters(
  monitor: ReturnType<typeof postgres>,
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

describe("folder tree trash service", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = await seedUser("folder-trash-a@example.test");
    ownerB = await seedUser("folder-trash-b@example.test");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("merges a branched three-level tree into one batch without touching assets, tags, or deleted boundaries", async () => {
    const oldBatchId = randomUUID();
    const oldTrashedAt = new Date("2026-01-02T03:04:05.000Z");
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Root",
      version: 4,
      changeSeq: 20n,
    });
    const childId = await seedFolder({
      ownerId: ownerA,
      name: "Child",
      parentId: rootId,
      status: "trashed",
      version: 7,
      trashBatchId: oldBatchId,
      trashedAt: oldTrashedAt,
      changeSeq: 21n,
    });
    const grandchildId = await seedFolder({
      ownerId: ownerA,
      name: "Grandchild",
      parentId: childId,
      version: 2,
      changeSeq: 22n,
    });
    const branchId = await seedFolder({
      ownerId: ownerA,
      name: "Branch",
      parentId: rootId,
      version: 3,
      changeSeq: 23n,
    });
    const deletedBoundaryId = await seedFolder({
      ownerId: ownerA,
      name: "Deleted boundary",
      parentId: rootId,
      status: "deleted",
      version: 8,
      changeSeq: 24n,
    });
    const behindBoundaryId = await seedFolder({
      ownerId: ownerA,
      name: "Behind boundary",
      parentId: deletedBoundaryId,
      version: 9,
      changeSeq: 25n,
    });

    const rootPatternId = await seedPattern({
      ownerId: ownerA,
      folderId: rootId,
      name: "Root ready",
      status: "ready",
      version: 10,
      changeSeq: 30n,
    });
    const childPatternId = await seedPattern({
      ownerId: ownerA,
      folderId: childId,
      name: "Already trashed",
      status: "trashed",
      preTrashStatus: "failed",
      version: 11,
      trashBatchId: oldBatchId,
      trashedAt: oldTrashedAt,
      changeSeq: 31n,
    });
    const grandchildPatternId = await seedPattern({
      ownerId: ownerA,
      folderId: grandchildId,
      name: "Grandchild failed",
      status: "failed",
      version: 12,
      changeSeq: 32n,
    });
    const branchPatternId = await seedPattern({
      ownerId: ownerA,
      folderId: branchId,
      name: "Branch ready",
      status: "ready",
      version: 13,
      changeSeq: 33n,
    });
    const deletedPatternId = await seedPattern({
      ownerId: ownerA,
      folderId: rootId,
      name: "Deleted pattern",
      status: "deleted",
      version: 14,
      changeSeq: 34n,
    });
    const behindBoundaryPatternId = await seedPattern({
      ownerId: ownerA,
      folderId: behindBoundaryId,
      name: "Behind boundary pattern",
      status: "ready",
      version: 15,
      changeSeq: 35n,
    });

    const assetId = randomUUID();
    const tagId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      ownerId: ownerA,
      patternId: rootPatternId,
      role: "source",
      objectKey: `users/${ownerA}/patterns/${rootPatternId}/source/${assetId}.psd`,
      originalFilename: "root-ready.psd",
      detectedMimeType: "image/vnd.adobe.photoshop",
      sizeBytes: 1024n,
    });
    await db.insert(tags).values({
      id: tagId,
      ownerId: ownerA,
      name: "Floral",
      normalizedName: "floral",
      colorToken: "green",
      changeSeq: 40n,
    });
    await db.insert(patternTags).values({
      ownerId: ownerA,
      patternId: rootPatternId,
      tagId,
      version: 2,
      changeSeq: 41n,
    });
    const assetsBefore = await db.select().from(assets);
    const tagsBefore = await db.select().from(tags);
    const patternTagsBefore = await db.select().from(patternTags);
    const operationId = randomUUID();

    const result = await trashFolderTree({
      ownerId: ownerA,
      folderId: rootId,
      operationId,
      version: 4,
    });

    expect(result).toEqual({
      state: "trashed",
      trashBatchId: operationId,
      rootFolderId: rootId,
      folderCount: 4,
      patternCount: 4,
    });
    const folderIds = [rootId, childId, grandchildId, branchId];
    const patternIds = [
      rootPatternId,
      childPatternId,
      grandchildPatternId,
      branchPatternId,
    ];
    const trashedFolders = await readFolders(ownerA, folderIds);
    const trashedPatterns = await readPatterns(ownerA, patternIds);
    expect(trashedFolders).toHaveLength(4);
    expect(trashedPatterns).toHaveLength(4);
    expect(
      trashedFolders.every(
        (row) =>
          row.status === "trashed" &&
          row.trashBatchId === operationId &&
          row.changeSeq === 1n,
      ),
    ).toBe(true);
    expect(
      trashedPatterns.every(
        (row) =>
          row.status === "trashed" &&
          row.trashBatchId === operationId &&
          row.changeSeq === 1n,
      ),
    ).toBe(true);
    const sharedTimestamp = trashedFolders[0]?.trashedAt?.getTime();
    expect(sharedTimestamp).toEqual(expect.any(Number));
    expect(
      trashedFolders.every(
        (row) =>
          row.trashedAt?.getTime() === sharedTimestamp &&
          row.updatedAt.getTime() === sharedTimestamp,
      ),
    ).toBe(true);
    expect(
      trashedPatterns.every(
        (row) =>
          row.trashedAt?.getTime() === sharedTimestamp &&
          row.updatedAt.getTime() === sharedTimestamp,
      ),
    ).toBe(true);
    expect(trashedFolders.map((row) => [row.id, row.version])).toEqual(
      [
        [rootId, 5],
        [childId, 8],
        [grandchildId, 3],
        [branchId, 4],
      ].sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
    const patternsById = new Map(trashedPatterns.map((row) => [row.id, row]));
    expect(patternsById.get(rootPatternId)).toMatchObject({
      folderId: rootId,
      preTrashStatus: "ready",
      version: 11,
    });
    expect(patternsById.get(childPatternId)).toMatchObject({
      folderId: childId,
      preTrashStatus: "failed",
      version: 12,
    });
    expect(patternsById.get(grandchildPatternId)).toMatchObject({
      folderId: grandchildId,
      preTrashStatus: "failed",
      version: 13,
    });
    expect(patternsById.get(branchPatternId)).toMatchObject({
      folderId: branchId,
      preTrashStatus: "ready",
      version: 14,
    });

    await expect(
      readFolders(ownerA, [deletedBoundaryId, behindBoundaryId]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: behindBoundaryId,
          status: "active",
          version: 9,
          changeSeq: 25n,
        }),
        expect.objectContaining({
          id: deletedBoundaryId,
          status: "deleted",
          version: 8,
          changeSeq: 24n,
        }),
      ]),
    );
    await expect(
      readPatterns(ownerA, [deletedPatternId, behindBoundaryPatternId]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: behindBoundaryPatternId,
          status: "ready",
          version: 15,
          changeSeq: 35n,
        }),
        expect.objectContaining({
          id: deletedPatternId,
          status: "deleted",
          version: 14,
          changeSeq: 34n,
        }),
      ]),
    );
    expect(await db.select().from(assets)).toEqual(assetsBefore);
    expect(await db.select().from(tags)).toEqual(tagsBefore);
    expect(await db.select().from(patternTags)).toEqual(patternTagsBefore);
    expect(
      await db
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.trashBatchId, oldBatchId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: patterns.id })
        .from(patterns)
        .where(eq(patterns.trashBatchId, oldBatchId)),
    ).toEqual([]);
    expect(await readChanges(ownerA)).toEqual([
      expect.objectContaining({
        seq: 1n,
        operationId,
        entityType: "folder_tree",
        entityId: rootId,
        operation: "folder_tree.trashed",
        payload: {
          rootFolderId: rootId,
          folderIds: [...folderIds].sort(),
          patternIds: [...patternIds].sort(),
        },
      }),
    ]);
    expect(await readOperations(ownerA)).toEqual([
      expect.objectContaining({
        operationId,
        kind: expect.stringMatching(/^folder\.trash:[a-f0-9]{64}$/),
        result,
      }),
    ]);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("rejects deleting folders or patterns without leaving any partial writes", async () => {
    const rootId = await seedFolder({ ownerId: ownerA, name: "Root", version: 3 });
    const childId = await seedFolder({
      ownerId: ownerA,
      name: "Deleting child",
      parentId: rootId,
      status: "deleting",
      version: 5,
    });
    const patternId = await seedPattern({
      ownerId: ownerA,
      folderId: rootId,
      name: "Ready pattern",
      status: "ready",
      version: 7,
    });
    const initialFolders = await readFolders(ownerA, [rootId, childId]);
    const initialPatterns = await readPatterns(ownerA, [patternId]);

    await expect(
      trashFolderTree({
        ownerId: ownerA,
        folderId: rootId,
        operationId: randomUUID(),
        version: 3,
      }),
    ).rejects.toMatchObject({ code: "TRASH_PURGE_IN_PROGRESS", status: 409 });
    expect(await readFolders(ownerA, [rootId, childId])).toEqual(initialFolders);
    expect(await readPatterns(ownerA, [patternId])).toEqual(initialPatterns);
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readChanges(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);

    await db.update(folders).set({ status: "active" }).where(eq(folders.id, childId));
    await db.update(patterns).set({ status: "deleting" }).where(eq(patterns.id, patternId));
    const beforePatternFailureFolders = await readFolders(ownerA, [rootId, childId]);
    const beforePatternFailurePatterns = await readPatterns(ownerA, [patternId]);
    await expect(
      trashFolderTree({
        ownerId: ownerA,
        folderId: rootId,
        operationId: randomUUID(),
        version: 3,
      }),
    ).rejects.toMatchObject({ code: "TRASH_PURGE_IN_PROGRESS", status: 409 });
    expect(await readFolders(ownerA, [rootId, childId])).toEqual(
      beforePatternFailureFolders,
    );
    expect(await readPatterns(ownerA, [patternId])).toEqual(
      beforePatternFailurePatterns,
    );
    expect(await readOperations(ownerA)).toEqual([]);
    expect(await readChanges(ownerA)).toEqual([]);
    expect(await readSyncSeq(ownerA)).toBe(0n);
  });

  it("rolls back folder updates when a later pattern update fails", async () => {
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Rollback root",
      version: 4,
      changeSeq: 50n,
    });
    const patternId = await seedPattern({
      ownerId: ownerA,
      folderId: rootId,
      name: "Rollback pattern",
      status: "ready",
      version: 6,
      changeSeq: 51n,
    });
    const foldersBefore = await readFolders(ownerA, [rootId]);
    const patternsBefore = await readPatterns(ownerA, [patternId]);
    await db.execute(sql.raw(`
      create function test_fail_folder_tree_pattern_update()
      returns trigger
      language plpgsql
      as $$
      begin
        if new.status = 'trashed'::pattern_status then
          raise exception 'TEST_FOLDER_TREE_PATTERN_UPDATE_FAILURE';
        end if;
        return new;
      end
      $$
    `));
    await db.execute(sql.raw(`
      create trigger test_fail_folder_tree_pattern_update
      before update on patterns
      for each row
      execute function test_fail_folder_tree_pattern_update()
    `));

    try {
      await expect(
        trashFolderTree({
          ownerId: ownerA,
          folderId: rootId,
          operationId: randomUUID(),
          version: 4,
        }),
      ).rejects.toThrow();
      expect(await readFolders(ownerA, [rootId])).toEqual(foldersBefore);
      expect(await readPatterns(ownerA, [patternId])).toEqual(patternsBefore);
      expect(await readOperations(ownerA)).toEqual([]);
      expect(await readChanges(ownerA)).toEqual([]);
      expect(await readSyncSeq(ownerA)).toBe(0n);
    } finally {
      await db.execute(
        sql.raw(
          "drop trigger if exists test_fail_folder_tree_pattern_update on patterns",
        ),
      );
      await db.execute(
        sql.raw("drop function if exists test_fail_folder_tree_pattern_update()"),
      );
    }
  });

  it("preserves tenant-neutral errors, state errors, and exact operation replay", async () => {
    const rootId = await seedFolder({ ownerId: ownerA, name: "Replay root", version: 2 });
    const patternId = await seedPattern({
      ownerId: ownerA,
      folderId: rootId,
      name: "Replay pattern",
      status: "ready",
    });
    const foreignRootId = await seedFolder({ ownerId: ownerB, name: "Foreign" });
    const operationId = randomUUID();
    const first = await trashFolderTree({
      ownerId: ownerA,
      folderId: rootId,
      operationId,
      version: 2,
    });

    await expect(
      trashFolderTree({
        ownerId: ownerA,
        folderId: rootId.toUpperCase(),
        operationId: operationId.toUpperCase(),
        version: 2,
      }),
    ).resolves.toEqual(first);
    expect(await readFolders(ownerA, [rootId])).toEqual([
      expect.objectContaining({ version: 3, status: "trashed", changeSeq: 1n }),
    ]);
    expect(await readPatterns(ownerA, [patternId])).toEqual([
      expect.objectContaining({ version: 1, status: "trashed", changeSeq: 1n }),
    ]);
    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readOperations(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);

    await expect(
      trashFolderTree({
        ownerId: ownerA,
        folderId: rootId,
        operationId,
        version: 3,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    for (const unavailable of [foreignRootId, randomUUID()]) {
      await expect(
        trashFolderTree({
          ownerId: ownerA,
          folderId: unavailable,
          operationId,
          version: 0,
        }),
      ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND", status: 404 });
    }

    const staleId = await seedFolder({
      ownerId: ownerA,
      name: "Stale root",
      version: 6,
    });
    await expect(
      trashFolderTree({
        ownerId: ownerA,
        folderId: staleId,
        operationId: randomUUID(),
        version: 5,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_STATE_CHANGED", status: 409 });
    const trashedId = await seedFolder({
      ownerId: ownerA,
      name: "Inactive root",
      status: "trashed",
    });
    await expect(
      trashFolderTree({
        ownerId: ownerA,
        folderId: trashedId,
        operationId: randomUUID(),
        version: 0,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_ACTIVE", status: 409 });
    const deletingId = await seedFolder({
      ownerId: ownerA,
      name: "Purging root",
      status: "deleting",
    });
    await expect(
      trashFolderTree({
        ownerId: ownerA,
        folderId: deletingId,
        operationId: randomUUID(),
        version: 0,
      }),
    ).rejects.toMatchObject({ code: "TRASH_PURGE_IN_PROGRESS", status: 409 });
    const deletedId = await seedFolder({
      ownerId: ownerA,
      name: "Deleted root",
      status: "deleted",
    });
    await expect(
      trashFolderTree({
        ownerId: ownerA,
        folderId: deletedId,
        operationId: randomUUID(),
        version: 0,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND", status: 404 });

    expect(await readChanges(ownerA)).toHaveLength(1);
    expect(await readOperations(ownerA)).toHaveLength(1);
    expect(await readSyncSeq(ownerA)).toBe(1n);
  });

  it("rejects malformed or identity-mismatched stored replay results without new writes", async () => {
    const rootId = await seedFolder({
      ownerId: ownerA,
      name: "Corrupt replay root",
      version: 2,
    });
    const patternId = await seedPattern({
      ownerId: ownerA,
      folderId: rootId,
      name: "Corrupt replay pattern",
      status: "ready",
      version: 3,
    });
    const operationId = randomUUID();
    const validResult = await trashFolderTree({
      ownerId: ownerA,
      folderId: rootId,
      operationId,
      version: 2,
    });
    const foldersAfterFirst = await readFolders(ownerA, [rootId]);
    const patternsAfterFirst = await readPatterns(ownerA, [patternId]);
    const changesAfterFirst = await readChanges(ownerA);
    const syncSeqAfterFirst = await readSyncSeq(ownerA);
    const invalidResults: Record<string, unknown>[] = [
      {},
      { ...validResult, folderCount: -1 },
      { ...validResult, folderCount: 0 },
      { ...validResult, patternCount: 0.5 },
      { ...validResult, state: "pending" },
      { ...validResult, rootFolderId: randomUUID() },
      { ...validResult, trashBatchId: randomUUID() },
      { ...validResult, unexpected: true },
    ];

    for (const invalidResult of invalidResults) {
      await db
        .update(operations)
        .set({ result: invalidResult })
        .where(
          and(
            eq(operations.ownerId, ownerA),
            eq(operations.operationId, operationId),
          ),
        );

      await expect(
        trashFolderTree({
          ownerId: ownerA,
          folderId: rootId.toUpperCase(),
          operationId: operationId.toUpperCase(),
          version: 2,
        }),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
      expect(await readFolders(ownerA, [rootId])).toEqual(foldersAfterFirst);
      expect(await readPatterns(ownerA, [patternId])).toEqual(patternsAfterFirst);
      expect(await readChanges(ownerA)).toEqual(changesAfterFirst);
      expect(await readSyncSeq(ownerA)).toBe(syncSeqAfterFirst);
      expect(await readOperations(ownerA)).toEqual([
        expect.objectContaining({ operationId, result: invalidResult }),
      ]);
    }
  });

  it("serializes concurrent identical operations into one complete replay", async () => {
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blocker = postgres(databaseUrl, { max: 1 });
    const monitor = postgres(databaseUrl, { max: 1 });

    try {
      for (let round = 0; round < 3; round += 1) {
        const rootId = await seedFolder({
          ownerId: ownerA,
          name: `Replay race root ${round}`,
        });
        const patternId = await seedPattern({
          ownerId: ownerA,
          folderId: rootId,
          name: `Replay race pattern ${round}`,
          status: "ready",
        });
        const operationId = randomUUID();
        const input = {
          ownerId: ownerA,
          folderId: rootId,
          operationId,
          version: 0,
        };
        const lockReady = deferred<void>();
        const releaseLock = deferred<void>();
        let released = false;
        const blockerTransaction = blocker.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${ownerA}, 0))`;
          lockReady.resolve();
          await releaseLock.promise;
        });

        let first: ReturnType<typeof trashFolderTree> | undefined;
        let second: ReturnType<typeof trashFolderTree> | undefined;
        try {
          await withTimeout(lockReady.promise);
          first = trashFolderTree(input);
          void first.catch(() => undefined);
          const advisoryWaiters = await waitForAdvisoryWaiters(monitor, 1);
          second = trashFolderTree(input);
          void second.catch(() => undefined);
          const operationWaiterPid = await waitForOperationClaimWaiter(monitor);
          expect(advisoryWaiters).not.toContain(operationWaiterPid);

          released = true;
          releaseLock.resolve();
          await withTimeout(blockerTransaction);
          const [firstResult, secondResult] = await withTimeout(
            Promise.all([first, second]),
          );

          expect(firstResult).toEqual({
            state: "trashed",
            trashBatchId: operationId,
            rootFolderId: rootId,
            folderCount: 1,
            patternCount: 1,
          });
          expect(secondResult).toEqual(firstResult);
          expect(await readFolders(ownerA, [rootId])).toEqual([
            expect.objectContaining({
              status: "trashed",
              trashBatchId: operationId,
              version: 1,
              changeSeq: BigInt(round + 1),
            }),
          ]);
          expect(await readPatterns(ownerA, [patternId])).toEqual([
            expect.objectContaining({
              status: "trashed",
              trashBatchId: operationId,
              version: 1,
              changeSeq: BigInt(round + 1),
            }),
          ]);
          expect(
            (await readOperations(ownerA)).filter(
              (operation) => operation.operationId === operationId,
            ),
          ).toEqual([
            expect.objectContaining({ operationId, result: firstResult }),
          ]);
          expect(
            (await readChanges(ownerA)).filter(
              (change) => change.operationId === operationId,
            ),
          ).toHaveLength(1);
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
  }, 15_000);

  it("serializes child creation and cascade trash without leaving an active descendant", async () => {
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blocker = postgres(databaseUrl, { max: 1 });
    const monitor = postgres(databaseUrl, { max: 1 });

    try {
      for (let round = 0; round < 3; round += 1) {
        const rootId = await seedFolder({
          ownerId: ownerA,
          name: `Concurrent root ${round}`,
        });
        const trashOperationId = randomUUID();
        const lockReady = deferred<void>();
        const releaseLock = deferred<void>();
        let released = false;
        const blockerTransaction = blocker.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${ownerA}, 0))`;
          lockReady.resolve();
          await releaseLock.promise;
        });

        try {
          await withTimeout(lockReady.promise);
          const create = createFolder({
            ownerId: ownerA,
            operationId: randomUUID(),
            name: `Concurrent child ${round}`,
            parentId: rootId,
          });
          const trash = trashFolderTree({
            ownerId: ownerA,
            folderId: rootId,
            operationId: trashOperationId,
            version: 0,
          });
          // The barrier intentionally waits before observing both outcomes.
          void trash.catch(() => undefined);
          const waiterPids = await waitForAdvisoryWaiters(monitor, 2);
          expect(new Set(waiterPids).size).toBeGreaterThanOrEqual(2);
          released = true;
          releaseLock.resolve();
          await withTimeout(blockerTransaction);
          const [createOutcome, trashOutcome] = await withTimeout(
            Promise.allSettled([create, trash]),
          );

          expect(trashOutcome.status).toBe("fulfilled");
          const [root] = await readFolders(ownerA, [rootId]);
          expect(root).toMatchObject({
            status: "trashed",
            trashBatchId: trashOperationId,
          });
          const children = await db
            .select()
            .from(folders)
            .where(
              and(
                eq(folders.ownerId, ownerA),
                eq(folders.parentId, rootId),
              ),
            );
          if (createOutcome.status === "fulfilled") {
            expect(children).toEqual([
              expect.objectContaining({
                id: createOutcome.value.id,
                status: "trashed",
                trashBatchId: trashOperationId,
              }),
            ]);
          } else {
            expect(createOutcome.reason).toMatchObject({
              code: "FOLDER_NOT_ACTIVE",
              status: 409,
            });
            expect(children).toEqual([]);
          }
          expect(children.some((child) => child.status === "active")).toBe(false);
        } finally {
          if (!released) releaseLock.resolve();
          await Promise.allSettled([blockerTransaction]);
        }
      }
    } finally {
      await Promise.all([
        blocker.end({ timeout: 1 }),
        monitor.end({ timeout: 1 }),
      ]);
    }
  }, 15_000);
});
