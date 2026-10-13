import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { trashFolderTree } from "@/features/folders/folder-trash-service";
import type {
  BrowserCredentialIssuer,
  BrowserOssCredentials,
  OssAdapter,
} from "@/features/storage/contracts";
import {
  patternObjectPrefix,
  sourceObjectKey,
} from "@/features/storage/object-keys";
import { closeDatabase, db } from "@/lib/db/client";
import {
  assets,
  changeLog,
  folders,
  operations,
  patterns,
  patternTags,
  tags,
  uploadSessions,
  users,
} from "@/lib/db/schema";
import { AppError } from "@/lib/http/app-error";
import { createOperationKey } from "@/lib/db/operation";
import { resetDatabase } from "@/test/database";
import { FakeOssAdapter } from "@/test/fake-oss";
import { createUploadService } from "@/features/uploads/upload-service";

import { createTrashPurgeService } from "./trash-purge-service";
import { listExpiredTrashTargets } from "./trash-purge-repository";
import { listTrash } from "./trash-service";

const now = new Date("2026-10-13T03:00:00.000Z");
const trashedAt = new Date("2026-09-01T00:00:00.000Z");

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

async function seedFolder(input: {
  ownerId: string;
  trashBatchId: string;
  name: string;
  parentId?: string | null;
}) {
  const id = randomUUID();
  await db.insert(folders).values({
    id,
    ownerId: input.ownerId,
    parentId: input.parentId ?? null,
    name: input.name,
    normalizedName: input.name.toLowerCase(),
    status: "trashed",
    trashBatchId: input.trashBatchId,
    trashedAt,
  });
  return id;
}

async function seedTrashedPattern(input: {
  ownerId: string;
  trashBatchId: string;
  name: string;
  folderId?: string | null;
}) {
  const id = randomUUID();
  await db.insert(patterns).values({
    id,
    ownerId: input.ownerId,
    folderId: input.folderId ?? null,
    name: input.name,
    originalFilename: `${input.name}.psd`,
    extension: "psd",
    detectedMimeType: "image/vnd.adobe.photoshop",
    sizeBytes: 12n,
    contentHash: "a".repeat(64),
    status: "trashed",
    previewStatus: "ready",
    isFavorite: true,
    preTrashStatus: "ready",
    trashBatchId: input.trashBatchId,
    trashedAt,
    lastErrorCode: "OLD_ERROR",
  });
  return id;
}

async function seedSourceAsset(
  ownerId: string,
  patternId: string,
  oss: FakeOssAdapter,
) {
  const id = randomUUID();
  const objectKey = sourceObjectKey({
    ownerId,
    patternId,
    assetId: id,
    extension: "psd",
  });
  await db.insert(assets).values({
    id,
    ownerId,
    patternId,
    role: "source",
    objectKey,
    originalFilename: "source.psd",
    sizeBytes: 12n,
    contentHash: "b".repeat(64),
  });
  oss.putObject(objectKey, Uint8Array.from([1, 2, 3]));
  return { id, objectKey };
}

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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("trash permanent purge", () => {
  beforeEach(async () => resetDatabase());
  afterAll(closeDatabase);

  it("persists pending before OSS, removes relations, and finalizes one pattern tombstone", async () => {
    const ownerId = await seedUser("purge-pattern@example.test");
    const trashBatchId = randomUUID();
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId,
      name: "Orchard",
    });
    const tagId = randomUUID();
    await db.insert(tags).values({
      id: tagId,
      ownerId,
      name: "Fruit",
      normalizedName: "fruit",
      colorToken: "red",
    });
    await db.insert(patternTags).values({ ownerId, patternId, tagId });

    const operationId = randomUUID();
    const observed: Array<{ patternStatus: string; operationState: unknown }> = [];
    const oss = new FakeOssAdapter();
    const { objectKey } = await seedSourceAsset(ownerId, patternId, oss);
    await db.insert(uploadSessions).values({
      id: randomUUID(),
      ownerId,
      patternId,
      operationId: randomUUID(),
      sourceObjectKey: objectKey,
      fileFingerprint: {},
      sizeBytes: 12n,
      status: "completed",
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    const inspectingOss: OssAdapter = {
      ...oss,
      headObject: oss.headObject.bind(oss),
      readRange: oss.readRange.bind(oss),
      createSignedGet: oss.createSignedGet.bind(oss),
      deleteObjects: oss.deleteObjects.bind(oss),
      listObjectKeys: oss.listObjectKeys.bind(oss),
      deleteObjectsUnderPrefix: async (prefix, keys) => {
        const [pattern] = await db
          .select({ status: patterns.status })
          .from(patterns)
          .where(and(eq(patterns.ownerId, ownerId), eq(patterns.id, patternId)));
        const [operation] = await db
          .select({ result: operations.result })
          .from(operations)
          .where(
            and(
              eq(operations.ownerId, ownerId),
              eq(operations.operationId, operationId),
            ),
          );
        observed.push({
          patternStatus: pattern!.status,
          operationState: operation?.result,
        });
        await oss.deleteObjectsUnderPrefix(prefix, keys);
      },
    };
    const service = createTrashPurgeService({
      database: db,
      oss: inspectingOss,
      now: () => now,
    });

    await expect(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
    ).resolves.toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 0,
    });

    expect(observed).toEqual([
      {
        patternStatus: "deleting",
        operationState: {
          state: "pending",
          target: { kind: "patterns", patternIds: [patternId] },
        },
      },
    ]);
    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    expect(pattern).toMatchObject({
      status: "deleted",
      folderId: null,
      trashBatchId: null,
      preTrashStatus: null,
      contentHash: null,
      lastErrorCode: null,
      deletedAt: now,
      isFavorite: false,
      version: 1,
    });
    expect(await db.select().from(assets)).toEqual([]);
    expect(await db.select().from(patternTags)).toEqual([]);
    expect(await db.select().from(uploadSessions)).toEqual([]);
    expect(oss.objects.size).toBe(0);

    const [operation] = await db
      .select()
      .from(operations)
      .where(eq(operations.operationId, operationId));
    expect(operation?.result).toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 0,
    });
    expect(await db.select().from(changeLog)).toHaveLength(1);

    await expect(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
    ).resolves.toEqual(operation?.result);
    expect(oss.deleteCalls).toHaveLength(1);
    expect(await db.select().from(changeLog)).toHaveLength(1);
  });

  it("keeps assets and a pending operation after OSS failure, then resumes it", async () => {
    const ownerId = await seedUser("purge-retry@example.test");
    const trashBatchId = randomUUID();
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId,
      name: "Retry",
    });
    const operationId = randomUUID();
    const oss = new FakeOssAdapter();
    await seedSourceAsset(ownerId, patternId, oss);
    oss.failDeleteCall = 1;
    const service = createTrashPurgeService({
      database: db,
      oss,
      now: () => now,
    });

    await expectAppError(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
      "OSS_DELETE_FAILED",
      502,
    );

    const [failedPattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    expect(failedPattern).toMatchObject({
      status: "deleting",
      trashBatchId,
      lastErrorCode: "OSS_DELETE_FAILED",
      version: 0,
    });
    expect(await db.select().from(assets)).toHaveLength(1);
    const [pending] = await db
      .select()
      .from(operations)
      .where(eq(operations.operationId, operationId));
    expect(pending?.result).toEqual({
      state: "pending",
      target: { kind: "patterns", patternIds: [patternId] },
    });
    await expect(listTrash({ ownerId })).resolves.toMatchObject({
      patternBatches: [
        {
          trashBatchId,
          state: "deleting",
          lastErrorCode: "OSS_DELETE_FAILED",
          purgeOperationId: operationId,
        },
      ],
    });

    await expect(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
    ).resolves.toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 0,
    });
    expect(oss.deleteCalls).toHaveLength(2);
  });

  it("maps an OSS prefix-list failure to the retryable purge error", async () => {
    const ownerId = await seedUser("purge-list-failure@example.test");
    const trashBatchId = randomUUID();
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId,
      name: "List failure",
    });
    class ListingFailureOss extends FakeOssAdapter {
      override async listObjectKeys(): Promise<string[]> {
        throw new Error("OSS_LIST_FAILED");
      }
    }
    const oss = new ListingFailureOss();
    await seedSourceAsset(ownerId, patternId, oss);
    const service = createTrashPurgeService({
      database: db,
      oss,
      now: () => now,
    });

    await expectAppError(
      service.purgePatterns({
        ownerId,
        operationId: randomUUID(),
        patternIds: [patternId],
      }),
      "OSS_DELETE_FAILED",
      502,
    );
    const [failedPattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    expect(failedPattern).toMatchObject({
      status: "deleting",
      lastErrorCode: "OSS_DELETE_FAILED",
    });
    expect(await db.select().from(assets)).toHaveLength(1);
  });

  it("deletes every object under the pattern prefix, including uncommitted objects", async () => {
    const ownerId = await seedUser("purge-prefix@example.test");
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId: randomUUID(),
      name: "Prefix cleanup",
    });
    const oss = new FakeOssAdapter();
    const source = await seedSourceAsset(ownerId, patternId, oss);
    const prefix = patternObjectPrefix({ ownerId, patternId });
    const uncommitted = `${prefix}derived/uncommitted-preview.tmp`;
    const unrelatedPatternId = randomUUID();
    const unrelated = sourceObjectKey({
      ownerId,
      patternId: unrelatedPatternId,
      assetId: randomUUID(),
      extension: "psd",
    });
    oss.objects.set(uncommitted, Uint8Array.from([4, 5, 6]));
    oss.putObject(unrelated, Uint8Array.from([7]));
    const service = createTrashPurgeService({
      database: db,
      oss,
      now: () => now,
    });

    await service.purgePatterns({
      ownerId,
      operationId: randomUUID(),
      patternIds: [patternId],
    });

    expect(oss.objects.has(source.objectKey)).toBe(false);
    expect(oss.objects.has(uncommitted)).toBe(false);
    expect(oss.objects.has(unrelated)).toBe(true);
  });

  it("aborts upload sessions and defers without failure until every write credential expires", async () => {
    const ownerId = await seedUser("purge-credential-fence@example.test");
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId: randomUUID(),
      name: "Credential fence",
    });
    const oss = new FakeOssAdapter();
    const source = await seedSourceAsset(ownerId, patternId, oss);
    const safeAfter = new Date(now.getTime() + 5 * 60 * 1_000);
    const sessionId = randomUUID();
    await db.insert(uploadSessions).values({
      id: sessionId,
      ownerId,
      patternId,
      operationId: randomUUID(),
      sourceObjectKey: source.objectKey,
      fileFingerprint: {},
      sizeBytes: 12n,
      status: "uploading",
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      credentialIssueFenceAt: new Date(now.getTime() + 60_000),
      credentialsExpireAt: safeAfter,
    });
    let currentNow = now;
    const operationId = randomUUID();
    const service = createTrashPurgeService({
      database: db,
      oss,
      now: () => currentNow,
    });

    await expectAppError(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
      "TRASH_PURGE_DEFERRED",
      409,
    );
    const [pendingPattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    const [abortedSession] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, sessionId));
    expect(pendingPattern).toMatchObject({
      status: "deleting",
      lastErrorCode: null,
    });
    expect(abortedSession).toMatchObject({
      status: "aborted",
      lastErrorCode: "UPLOAD_ABORTED_BY_PURGE",
    });
    expect(oss.deleteCalls).toHaveLength(0);
    expect(oss.objects.has(source.objectKey)).toBe(true);

    currentNow = new Date(safeAfter.getTime() + 1);
    await expect(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
    ).resolves.toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 0,
    });
    expect(oss.objects.has(source.objectKey)).toBe(false);
    expect(await db.select().from(changeLog)).toHaveLength(1);
  });

  it("lets purge fence an in-flight credential issue without returning write access", async () => {
    const ownerId = await seedUser("purge-inflight-credential@example.test");
    const folderId = randomUUID();
    await db.insert(folders).values({
      id: folderId,
      ownerId,
      name: "Pending upload",
      normalizedName: "pending upload",
      status: "active",
    });
    const started = deferred();
    const response = deferred<BrowserOssCredentials>();
    const credentialIssuer: BrowserCredentialIssuer = {
      async issue() {
        started.resolve(undefined);
        return response.promise;
      },
    };
    let currentNow = new Date("2026-10-09T10:00:00.000Z");
    const oss = new FakeOssAdapter();
    const upload = createUploadService({
      database: db,
      oss,
      credentialIssuer,
      now: () => currentNow,
    });
    const uploadInput = {
      operationId: randomUUID(),
      patternId: randomUUID(),
      sourceAssetId: randomUUID(),
      originalFilename: "pending.psd",
      extension: "psd" as const,
      sizeBytes: 12,
      lastModified: 1_700_000_000_000,
      contentHash: "d".repeat(64),
    };
    const initialization = upload.initialize({ ownerId, input: uploadInput });
    await started.promise;
    await db
      .update(patterns)
      .set({ folderId })
      .where(eq(patterns.id, uploadInput.patternId));
    const trashBatchId = randomUUID();
    await trashFolderTree({
      ownerId,
      folderId,
      operationId: trashBatchId,
      version: 0,
    });
    const purgeOperationId = randomUUID();
    const purge = createTrashPurgeService({
      database: db,
      oss,
      now: () => currentNow,
    });

    await expectAppError(
      purge.purgeFolderBatch({
        ownerId,
        operationId: purgeOperationId,
        trashBatchId,
      }),
      "TRASH_PURGE_DEFERRED",
      409,
    );
    response.resolve({
      accessKeyId: "STS.in-flight",
      accessKeySecret: "temporary-secret",
      securityToken: "temporary-token",
      expiration: "2026-10-09T10:15:00.000Z",
      region: "oss-cn-hangzhou",
      bucket: "melon-test-assets",
      endpoint: "https://assets.example.test",
      cname: true,
    });
    await expect(initialization).rejects.toMatchObject({
      code: "UPLOAD_SESSION_INVALID_STATE",
    });
    const [fencedSession] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.operationId, uploadInput.operationId));
    expect(fencedSession).toMatchObject({
      status: "aborted",
      credentialIssueFenceAt: null,
      credentialsExpireAt: new Date("2026-10-09T10:15:00.000Z"),
    });

    currentNow = new Date("2026-10-09T10:15:00.001Z");
    await expect(
      purge.purgeFolderBatch({
        ownerId,
        operationId: purgeOperationId,
        trashBatchId,
      }),
    ).resolves.toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 1,
    });
  });

  it("replays after OSS succeeds but finalization fails and emits one event", async () => {
    const ownerId = await seedUser("purge-finalize-retry@example.test");
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId: randomUUID(),
      name: "Finalize retry",
    });
    const oss = new FakeOssAdapter();
    await seedSourceAsset(ownerId, patternId, oss);
    let transactions = 0;
    const flakyDatabase = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") {
          return Reflect.get(target, property, receiver);
        }
        return async (...args: Parameters<typeof db.transaction>) => {
          transactions += 1;
          if (transactions === 2) throw new Error("FINALIZATION_UNAVAILABLE");
          return db.transaction(...args);
        };
      },
    });
    const operationId = randomUUID();
    const flakyService = createTrashPurgeService({
      database: flakyDatabase,
      oss,
      now: () => now,
    });

    await expect(
      flakyService.purgePatterns({
        ownerId,
        operationId,
        patternIds: [patternId],
      }),
    ).rejects.toThrow("FINALIZATION_UNAVAILABLE");
    expect(oss.objects.size).toBe(0);
    expect(await db.select().from(assets)).toHaveLength(1);
    expect(await db.select().from(changeLog)).toHaveLength(0);

    const service = createTrashPurgeService({
      database: db,
      oss,
      now: () => now,
    });
    await expect(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
    ).resolves.toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 0,
    });
    expect(await db.select().from(changeLog)).toHaveLength(1);
    expect(oss.deleteCalls).toHaveLength(1);
  });

  it("purges a complete folder batch and clears self references in tombstones", async () => {
    const ownerId = await seedUser("purge-folder@example.test");
    const trashBatchId = randomUUID();
    const rootId = await seedFolder({
      ownerId,
      trashBatchId,
      name: "Root",
    });
    const childId = await seedFolder({
      ownerId,
      trashBatchId,
      name: "Child",
      parentId: rootId,
    });
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId,
      name: "Nested",
      folderId: childId,
    });
    const oss = new FakeOssAdapter();
    await seedSourceAsset(ownerId, patternId, oss);
    const operationId = randomUUID();
    const service = createTrashPurgeService({
      database: db,
      oss,
      now: () => now,
    });

    await expect(
      service.purgeFolderBatch({ ownerId, operationId, trashBatchId }),
    ).resolves.toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 2,
    });

    const folderRows = await db
      .select()
      .from(folders)
      .where(inArray(folders.id, [rootId, childId]))
      .orderBy(asc(folders.id));
    expect(folderRows).toHaveLength(2);
    expect(
      folderRows.every(
        (folder) =>
          folder.status === "deleted" &&
          folder.parentId === null &&
          folder.trashBatchId === null &&
          folder.deletedAt?.getTime() === now.getTime(),
      ),
    ).toBe(true);
    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    expect(pattern).toMatchObject({ status: "deleted", folderId: null });
    const [event] = await db.select().from(changeLog);
    expect(event).toMatchObject({
      operationId,
      operation: "folder_tree.deleted",
      entityType: "folder_tree",
    });
  });

  it("rejects ordinary purge for a folder batch and isolates owners", async () => {
    const ownerId = await seedUser("purge-owner@example.test");
    const attackerId = await seedUser("purge-attacker@example.test");
    const trashBatchId = randomUUID();
    const folderId = await seedFolder({
      ownerId,
      trashBatchId,
      name: "Protected",
    });
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId,
      name: "Protected pattern",
      folderId,
    });
    const service = createTrashPurgeService({
      database: db,
      oss: new FakeOssAdapter(),
      now: () => now,
    });

    await expectAppError(
      service.purgePatterns({
        ownerId,
        operationId: randomUUID(),
        patternIds: [patternId],
      }),
      "FOLDER_BATCH_ACTION_REQUIRED",
      409,
    );
    await expectAppError(
      service.purgePatterns({
        ownerId: attackerId,
        operationId: randomUUID(),
        patternIds: [patternId],
      }),
      "NOT_FOUND",
      404,
    );
  });

  it("rejects an empty or corrupt replay instead of treating it as complete", async () => {
    const ownerId = await seedUser("purge-corrupt@example.test");
    const trashBatchId = randomUUID();
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId,
      name: "Corrupt",
    });
    const operationId = randomUUID();
    const service = createTrashPurgeService({
      database: db,
      oss: new FakeOssAdapter(),
      now: () => now,
    });
    await db.insert(operations).values({
      ownerId,
      operationId,
      kind: createOperationKey("trash.patterns.purge", {
        patternIds: [patternId],
      }),
      result: {},
    });

    await expectAppError(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
      "INTERNAL_ERROR",
      500,
    );
    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    expect(pattern?.status).toBe("trashed");
  });

  it("treats a pending operation whose target reverted state as corruption", async () => {
    const ownerId = await seedUser("purge-state-corrupt@example.test");
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId: randomUUID(),
      name: "Wrong state",
    });
    const operationId = randomUUID();
    const target = { kind: "patterns" as const, patternIds: [patternId] };
    await db.insert(operations).values({
      ownerId,
      operationId,
      kind: createOperationKey("trash.patterns.purge", {
        patternIds: [patternId],
      }),
      result: { state: "pending", target },
    });
    const service = createTrashPurgeService({
      database: db,
      oss: new FakeOssAdapter(),
      now: () => now,
    });

    await expectAppError(
      service.purgePatterns({ ownerId, operationId, patternIds: [patternId] }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("treats a pending folder purge with reverted state as corruption", async () => {
    const ownerId = await seedUser("purge-folder-state-corrupt@example.test");
    const trashBatchId = randomUUID();
    await seedFolder({ ownerId, trashBatchId, name: "Wrong folder state" });
    const operationId = randomUUID();
    await db.insert(operations).values({
      ownerId,
      operationId,
      kind: createOperationKey("trash.folder-batch.purge", { trashBatchId }),
      result: {
        state: "pending",
        target: { kind: "folder_batch", trashBatchId },
      },
    });
    const service = createTrashPurgeService({
      database: db,
      oss: new FakeOssAdapter(),
      now: () => now,
    });

    await expectAppError(
      service.purgeFolderBatch({ ownerId, operationId, trashBatchId }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("treats a pending folder purge with an incomplete subtree as corruption", async () => {
    const ownerId = await seedUser("purge-folder-tree-corrupt@example.test");
    const trashBatchId = randomUUID();
    const rootId = await seedFolder({
      ownerId,
      trashBatchId,
      name: "Pending root",
    });
    await seedFolder({
      ownerId,
      trashBatchId: randomUUID(),
      name: "Escaped child",
      parentId: rootId,
    });
    await db
      .update(folders)
      .set({ status: "deleting" })
      .where(eq(folders.id, rootId));
    const operationId = randomUUID();
    await db.insert(operations).values({
      ownerId,
      operationId,
      kind: createOperationKey("trash.folder-batch.purge", { trashBatchId }),
      result: {
        state: "pending",
        target: { kind: "folder_batch", trashBatchId },
      },
    });
    const service = createTrashPurgeService({
      database: db,
      oss: new FakeOssAdapter(),
      now: () => now,
    });

    await expectAppError(
      service.purgeFolderBatch({ ownerId, operationId, trashBatchId }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("serializes concurrent finalization of the same pending operation", async () => {
    const ownerId = await seedUser("purge-concurrent@example.test");
    const patternId = await seedTrashedPattern({
      ownerId,
      trashBatchId: randomUUID(),
      name: "Concurrent",
    });
    const operationId = randomUUID();
    const bothDeleting = deferred();
    const release = deferred();
    class BlockingOss extends FakeOssAdapter {
      arrivals = 0;

      override async deleteObjectsUnderPrefix(prefix: string, keys: string[]) {
        this.arrivals += 1;
        if (this.arrivals === 2) bothDeleting.resolve();
        await release.promise;
        return super.deleteObjectsUnderPrefix(prefix, keys);
      }
    }
    const oss = new BlockingOss();
    await seedSourceAsset(ownerId, patternId, oss);
    const service = createTrashPurgeService({
      database: db,
      oss,
      now: () => now,
    });
    const input = { ownerId, operationId, patternIds: [patternId] };

    const first = service.purgePatterns(input);
    const second = service.purgePatterns(input);
    await bothDeleting.promise;
    release.resolve();
    const results = await Promise.all([first, second]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 0,
    });
    expect(await db.select().from(changeLog)).toHaveLength(1);
    expect(oss.deleteCalls).toHaveLength(2);
  });

  it("rejects ambiguous pending operations within one ordinary trash batch", async () => {
    const ownerId = await seedUser("purge-ambiguous@example.test");
    const trashBatchId = randomUUID();
    const firstId = await seedTrashedPattern({
      ownerId,
      trashBatchId,
      name: "First",
    });
    const secondId = await seedTrashedPattern({
      ownerId,
      trashBatchId,
      name: "Second",
    });
    await db
      .update(patterns)
      .set({ status: "deleting" })
      .where(inArray(patterns.id, [firstId, secondId]));
    await db.insert(operations).values(
      [firstId, secondId].map((patternId) => ({
        ownerId,
        operationId: randomUUID(),
        kind: createOperationKey("trash.patterns.purge", {
          patternIds: [patternId],
        }),
        result: {
          state: "pending",
          target: { kind: "patterns", patternIds: [patternId] },
        },
      })),
    );

    await expectAppError(listTrash({ ownerId }), "INTERNAL_ERROR", 500);
  });

  it("finds complete expired batches from the earliest folder or pattern timestamp", async () => {
    const ownerId = await seedUser("purge-expired@example.test");
    const folderBatchId = randomUUID();
    const ordinaryBatchId = randomUUID();
    const recent = new Date("2026-10-01T00:00:00.000Z");
    const old = new Date("2026-08-01T00:00:00.000Z");
    const rootId = await seedFolder({
      ownerId,
      trashBatchId: folderBatchId,
      name: "Recent root",
    });
    await db
      .update(folders)
      .set({ trashedAt: recent })
      .where(eq(folders.id, rootId));
    const folderPatternId = await seedTrashedPattern({
      ownerId,
      trashBatchId: folderBatchId,
      name: "Old nested pattern",
      folderId: rootId,
    });
    await db
      .update(patterns)
      .set({ trashedAt: old })
      .where(eq(patterns.id, folderPatternId));
    const ordinaryOldId = await seedTrashedPattern({
      ownerId,
      trashBatchId: ordinaryBatchId,
      name: "Old ordinary",
    });
    const ordinaryRecentId = await seedTrashedPattern({
      ownerId,
      trashBatchId: ordinaryBatchId,
      name: "Recent ordinary",
    });
    await db
      .update(patterns)
      .set({ trashedAt: old })
      .where(eq(patterns.id, ordinaryOldId));
    await db
      .update(patterns)
      .set({ trashedAt: recent })
      .where(eq(patterns.id, ordinaryRecentId));

    await expect(
      listExpiredTrashTargets(new Date("2026-09-13T00:00:00.000Z")),
    ).resolves.toEqual(
      [
        {
          kind: "folder_batch",
          ownerId,
          trashBatchId: folderBatchId,
        },
        {
          kind: "patterns",
          ownerId,
          trashBatchId: ordinaryBatchId,
          patternIds: [ordinaryOldId, ordinaryRecentId].sort(),
        },
      ].sort((left, right) =>
        left.trashBatchId.localeCompare(right.trashBatchId),
      ),
    );
  });

  it("excludes an entire ordinary batch when any member is deleting or has a pending purge", async () => {
    const ownerId = await seedUser("purge-expired-pending@example.test");
    const deletingBatchId = randomUUID();
    const pendingBatchId = randomUUID();
    const corruptBatchId = randomUUID();
    const deletingId = await seedTrashedPattern({
      ownerId,
      trashBatchId: deletingBatchId,
      name: "Deleting member",
    });
    await seedTrashedPattern({
      ownerId,
      trashBatchId: deletingBatchId,
      name: "Untouched sibling",
    });
    await db
      .update(patterns)
      .set({ status: "deleting" })
      .where(eq(patterns.id, deletingId));

    const pendingId = await seedTrashedPattern({
      ownerId,
      trashBatchId: pendingBatchId,
      name: "Pending member",
    });
    await seedTrashedPattern({
      ownerId,
      trashBatchId: pendingBatchId,
      name: "Pending sibling",
    });
    await db.insert(operations).values({
      ownerId,
      operationId: randomUUID(),
      kind: createOperationKey("trash.patterns.purge", {
        patternIds: [pendingId],
      }),
      result: {
        state: "pending",
        target: { kind: "patterns", patternIds: [pendingId] },
      },
    });
    await seedTrashedPattern({
      ownerId,
      trashBatchId: corruptBatchId,
      name: "Corrupt pending sibling",
    });
    await db.insert(operations).values({
      ownerId,
      operationId: randomUUID(),
      kind: createOperationKey("trash.patterns.purge", {
        patternIds: [randomUUID()],
      }),
      result: {
        state: "pending",
        target: { kind: "patterns", patternIds: "corrupt" },
      },
    });

    await expect(
      listExpiredTrashTargets(new Date("2026-09-13T00:00:00.000Z")),
    ).resolves.toEqual([]);
  });
});
