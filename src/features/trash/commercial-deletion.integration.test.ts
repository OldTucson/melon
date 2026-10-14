import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getAuthorizationDashboard } from "@/features/analytics/dashboard-service";
import {
  createAuthorization,
  listAuthorizations,
  voidAuthorization,
} from "@/features/authorizations/authorization-service";
import { batchPatterns } from "@/features/patterns/pattern-batch-service";
import { sourceObjectKey } from "@/features/storage/object-keys";
import { closeDatabase, db } from "@/lib/db/client";
import {
  assets,
  authorizations,
  changeLog,
  operations,
  patterns,
  patternTags,
  tags,
  users,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";
import { FakeOssAdapter } from "@/test/fake-oss";

import { createTrashPurgeService } from "./trash-purge-service";
import { listTrash, restorePatterns } from "./trash-service";
import { getPatternDeletionImpact } from "./commercial-impact";

const fieldId = "00000000-0000-4000-8000-000000000001";
const today = "2026-10-14";
const purgeTime = new Date("2026-10-14T08:00:00.000Z");

describe("commercial data across the trash lifecycle", () => {
  beforeEach(async () => resetDatabase());
  afterAll(closeDatabase);

  it("preserves commercial history through trash and restore, then removes it on permanent deletion", async () => {
    const ownerId = randomUUID();
    const patternId = randomUUID();
    await db.insert(users).values({
      id: ownerId,
      email: "commercial-trash@example.test",
      displayName: "Commercial trash",
      passwordHash: "test-password-hash",
      mustChangePassword: false,
    });
    await db.insert(patterns).values({
      id: patternId,
      ownerId,
      name: "Secret pattern name",
      originalFilename: "secret-client-pattern.psd",
      extension: "psd",
      detectedMimeType: "image/vnd.adobe.photoshop",
      sizeBytes: 1024n,
      contentHash: "a".repeat(64),
      status: "ready",
      previewStatus: "ready",
      isFavorite: true,
    });

    const activeOperationId = randomUUID();
    const active = await createAuthorization({
      ownerId,
      patternId,
      operationId: activeOperationId,
      commercialVersion: 0,
      kind: "standard",
      fieldId,
      licenseeName: "Active customer",
      priceYuan: "2500",
      authorizedOn: "2026-10-01",
      note: "Commercial note that must be removed",
      historyConfirmed: false,
    });
    const voidCreateOperationId = randomUUID();
    const toVoid = await createAuthorization({
      ownerId,
      patternId,
      operationId: voidCreateOperationId,
      commercialVersion: 1,
      kind: "standard",
      fieldId,
      licenseeName: "Voided customer",
      priceYuan: "800",
      authorizedOn: "2026-10-02",
      note: null,
      historyConfirmed: false,
    });
    const voidOperationId = randomUUID();
    await voidAuthorization({
      ownerId,
      authorizationId: toVoid.id,
      operationId: voidOperationId,
      version: toVoid.version,
      commercialVersion: 2,
    });

    const sourceAssetId = randomUUID();
    const objectKey = sourceObjectKey({
      ownerId,
      patternId,
      assetId: sourceAssetId,
      extension: "psd",
    });
    await db.insert(assets).values({
      id: sourceAssetId,
      ownerId,
      patternId,
      role: "source",
      objectKey,
      originalFilename: "secret-client-pattern.psd",
      sizeBytes: 1024n,
      contentHash: "b".repeat(64),
    });
    const tagId = randomUUID();
    await db.insert(tags).values({
      id: tagId,
      ownerId,
      name: "Private tag",
      normalizedName: "private tag",
      colorToken: "red",
    });
    await db.insert(patternTags).values({ ownerId, patternId, tagId });

    await expect(
      getPatternDeletionImpact({ ownerId, patternIds: [patternId] }),
    ).resolves.toEqual({
      activeAuthorizationCount: 1,
      activeRevenueFen: "250000",
      totalAuthorizationCount: 2,
      assetCount: 1,
      purgeOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    const beforeTrash = await getAuthorizationDashboard({
      ownerId,
      query: { range: "current_year" },
      today,
    });
    expect(beforeTrash.metrics).toMatchObject({
      revenueFen: "250000",
      count: 1,
      patternCount: 1,
    });

    const firstTrash = await batchPatterns({
      ownerId,
      mutation: {
        operationId: randomUUID(),
        action: "trash",
        patterns: [{ id: patternId, version: 0 }],
      },
    });
    const trashed = firstTrash.patterns[0]!;
    expect(trashed.status).toBe("trashed");
    await expect(
      getPatternDeletionImpact({ ownerId, patternIds: [patternId] }),
    ).rejects.toMatchObject({
      code: "PATTERN_STATE_CHANGED",
      status: 409,
    });
    await expect(
      listAuthorizations({ ownerId, patternId, includeVoid: true }),
    ).resolves.toMatchObject({ items: [{ id: toVoid.id }, { id: active.id }] });

    const whileTrashed = await getAuthorizationDashboard({
      ownerId,
      query: { range: "current_year" },
      today,
    });
    expect(whileTrashed.metrics).toMatchObject(beforeTrash.metrics);
    expect(
      whileTrashed.currentStates.reduce(
        (sum, row) => sum + row.patternCount,
        0,
      ),
    ).toBe(0);
    await expect(
      createAuthorization({
        ownerId,
        patternId,
        operationId: randomUUID(),
        commercialVersion: 3,
        kind: "standard",
        fieldId,
        licenseeName: "Blocked customer",
        priceYuan: "1",
        authorizedOn: "2026-10-03",
        note: null,
        historyConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "PATTERN_NOT_ACTIVE", status: 409 });

    const restored = await restorePatterns({
      ownerId,
      operationId: randomUUID(),
      patternIds: [patternId],
    });
    expect(restored.patterns[0]).toMatchObject({
      id: patternId,
      status: "ready",
      version: trashed.version + 1,
    });
    await expect(
      listAuthorizations({ ownerId, patternId, includeVoid: true }),
    ).resolves.toMatchObject({ items: [{ id: toVoid.id }, { id: active.id }] });

    const secondTrash = await batchPatterns({
      ownerId,
      mutation: {
        operationId: randomUUID(),
        action: "trash",
        patterns: [
          { id: patternId, version: restored.patterns[0]!.version },
        ],
      },
    });
    const trash = await listTrash({ ownerId });
    expect(trash.patternBatches[0]).toMatchObject({
      activeAuthorizationCount: 1,
      activeRevenueFen: "250000",
      totalAuthorizationCount: 2,
      assetCount: 1,
      patterns: [
        expect.objectContaining({
          id: patternId,
          activeAuthorizationCount: 1,
          activeRevenueFen: "250000",
          totalAuthorizationCount: 2,
          assetCount: 1,
        }),
      ],
    });

    const oss = new FakeOssAdapter();
    oss.putObject(objectKey, Uint8Array.from([1, 2, 3]));
    const purge = createTrashPurgeService({
      database: db,
      oss,
      now: () => purgeTime,
    });
    await expect(
      purge.purgePatterns({
        ownerId,
        operationId: randomUUID(),
        patternIds: [patternId],
      }),
    ).resolves.toEqual({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 0,
    });

    expect(
      await db
        .select()
        .from(authorizations)
        .where(eq(authorizations.patternId, patternId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(changeLog)
        .where(
          and(
            eq(changeLog.ownerId, ownerId),
            eq(changeLog.entityType, "authorization"),
          ),
        ),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.ownerId, ownerId),
            like(operations.kind, "authorization.%"),
          ),
        ),
    ).toEqual([]);
    expect(await db.select().from(assets)).toEqual([]);
    expect(await db.select().from(patternTags)).toEqual([]);
    expect(oss.objects.size).toBe(0);

    const [tombstone] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    expect(tombstone).toMatchObject({
      status: "deleted",
      name: "",
      originalFilename: "",
      extension: "",
      detectedMimeType: null,
      sizeBytes: 0n,
      contentHash: null,
      folderId: null,
      isFavorite: false,
      previewStatus: "unsupported",
      trashBatchId: null,
      preTrashStatus: null,
      trashedAt: null,
      deletedAt: purgeTime,
      commercialVersion: 0,
      version: secondTrash.patterns[0]!.version + 1,
    });

    const afterPurge = await getAuthorizationDashboard({
      ownerId,
      query: { range: "current_year" },
      today,
    });
    expect(afterPurge.metrics).toMatchObject({
      revenueFen: "0",
      count: 0,
      patternCount: 0,
    });
    const remainingPayloads = await db
      .select({ payload: changeLog.payload })
      .from(changeLog)
      .where(eq(changeLog.ownerId, ownerId));
    expect(JSON.stringify(remainingPayloads)).not.toContain("Active customer");
    expect(JSON.stringify(remainingPayloads)).not.toContain(
      "Commercial note that must be removed",
    );
  });
});
