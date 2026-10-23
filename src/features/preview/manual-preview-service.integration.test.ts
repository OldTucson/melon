import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db, closeDatabase } from "@/lib/db/client";
import {
  assets,
  operations,
  patterns,
  uploadSessions,
  users,
  visualSearchDocuments,
  visualSearchEmbeddings,
  visualSearchJobs,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";
import { FakeCredentialIssuer, FakeOssAdapter } from "@/test/fake-oss";

import { createManualPreviewService } from "./manual-preview-service";

const pngHeader = (width: number, height: number) => {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13,
    0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

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

async function seedVisualSearchIndex(input: {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
}) {
  const documentId = randomUUID();
  await db.insert(visualSearchDocuments).values({
    id: documentId,
    ownerId: input.ownerId,
    patternId: input.patternId,
    previewAssetId: input.previewAssetId,
    previewHash: "a".repeat(64),
    indexVersion: "visual-search-v1",
    status: "ready",
  });
  await db.insert(visualSearchEmbeddings).values({
    documentId,
    ownerId: input.ownerId,
    patternId: input.patternId,
    regionIndex: 0,
    regionKind: "global",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    embedding: Array.from({ length: 384 }, () => 0),
  });
  await db.insert(visualSearchJobs).values({
    id: randomUUID(),
    ownerId: input.ownerId,
    patternId: input.patternId,
    previewAssetId: input.previewAssetId,
    indexVersion: "visual-search-v1",
    status: "complete",
  });
  return documentId;
}

async function installRejectVisualSearchJobTrigger() {
  await db.execute(sql.raw(`
    create or replace function test_reject_manual_visual_search_job_insert()
    returns trigger language plpgsql as $$
    begin
      raise exception 'TEST_MANUAL_VISUAL_SEARCH_ENQUEUE_FAILED';
    end;
    $$
  `));
  await db.execute(sql.raw(`
    create trigger test_reject_manual_visual_search_job_insert
    before insert on visual_search_jobs
    for each row execute function test_reject_manual_visual_search_job_insert()
  `));
}

async function removeRejectVisualSearchJobTrigger() {
  await db.execute(
    sql.raw(
      "drop trigger if exists test_reject_manual_visual_search_job_insert on visual_search_jobs",
    ),
  );
  await db.execute(
    sql.raw(
      "drop function if exists test_reject_manual_visual_search_job_insert()",
    ),
  );
}

describe("manual preview service", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let patternId: string;
  let sourceAssetId: string;
  let oldPreviewAssetId: string;
  let oldPreviewKey: string;
  let oldThumbnailKey: string;
  let oss: FakeOssAdapter;
  let credentialIssuer: FakeCredentialIssuer;
  let service: ReturnType<typeof createManualPreviewService>;

  beforeEach(async () => {
    await resetDatabase();
    ownerId = await seedUser("manual-preview@example.test");
    otherOwnerId = await seedUser("other@example.test");
    patternId = randomUUID();
    sourceAssetId = randomUUID();
    oldPreviewAssetId = randomUUID();
    oldPreviewKey = `users/${ownerId}/patterns/${patternId}/derived/${randomUUID()}.png`;
    oldThumbnailKey = `users/${ownerId}/patterns/${patternId}/derived/${randomUUID()}.png`;
    await db.insert(patterns).values({
      id: patternId,
      ownerId,
      name: "Floral",
      originalFilename: "floral.psd",
      extension: "psd",
      sizeBytes: 1024n,
      status: "ready",
      previewStatus: "ready",
    });
    await db.insert(assets).values([
      {
        id: sourceAssetId,
        ownerId,
        patternId,
        role: "source",
        objectKey: `users/${ownerId}/patterns/${patternId}/source/${sourceAssetId}.psd`,
        originalFilename: "floral.psd",
        sizeBytes: 1024n,
      },
      {
        id: oldPreviewAssetId, ownerId, patternId, role: "preview",
        objectKey: oldPreviewKey, originalFilename: "preview.png",
        detectedMimeType: "image/png", sizeBytes: 24n, width: 800, height: 600,
      },
      {
        id: randomUUID(), ownerId, patternId, role: "thumbnail",
        objectKey: oldThumbnailKey, originalFilename: "thumbnail.png",
        detectedMimeType: "image/png", sizeBytes: 24n, width: 400, height: 300,
      },
    ]);
    oss = new FakeOssAdapter();
    oss.putObject(oldPreviewKey, pngHeader(800, 600));
    oss.putObject(oldThumbnailKey, pngHeader(400, 300));
    credentialIssuer = new FakeCredentialIssuer({
      now: () => new Date("2026-10-20T05:00:00.000Z"),
    });
    service = createManualPreviewService({
      database: db,
      oss,
      credentialIssuer,
      now: () => new Date("2026-10-20T05:00:00.000Z"),
    });
  });

  afterAll(async () => closeDatabase());

  it("atomically replaces derived assets while preserving the source", async () => {
    await seedVisualSearchIndex({
      ownerId,
      patternId,
      previewAssetId: oldPreviewAssetId,
    });
    const operationId = randomUUID();
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId, version: 0, extension: "png" },
    });
    const previewBytes = pngHeader(1200, 800);
    const thumbnailBytes = pngHeader(480, 320);
    oss.putObject(initialized.assets.preview.objectKey, previewBytes);
    oss.putObject(initialized.assets.thumbnail.objectKey, thumbnailBytes);
    const input = {
      operationId,
      version: 0,
      assets: [
        {
          ...initialized.assets.preview,
          sizeBytes: previewBytes.byteLength,
          width: 1200,
          height: 800,
        },
        {
          ...initialized.assets.thumbnail,
          sizeBytes: thumbnailBytes.byteLength,
          width: 480,
          height: 320,
        },
      ],
    };

    const completed = await service.complete({ ownerId, patternId, input });
    const replay = await service.complete({ ownerId, patternId, input });
    const rows = await db
      .select()
      .from(assets)
      .where(and(eq(assets.ownerId, ownerId), eq(assets.patternId, patternId)));

    expect(replay).toEqual(completed);
    expect(completed.pattern).toMatchObject({
      id: patternId,
      version: 1,
      previewStatus: "manual",
    });
    expect(rows.find((row) => row.role === "source")?.id).toBe(sourceAssetId);
    expect(rows.map((row) => row.role).sort()).toEqual([
      "preview",
      "source",
      "thumbnail",
    ]);
    const preview = rows.find((row) => row.role === "preview")!;
    expect(await db.select().from(visualSearchDocuments)).toEqual([]);
    expect(await db.select().from(visualSearchEmbeddings)).toEqual([]);
    expect(await db.select().from(visualSearchJobs)).toEqual([
      expect.objectContaining({
        ownerId,
        patternId,
        previewAssetId: preview.id,
        indexVersion: "visual-search-v2",
        status: "pending",
        attemptCount: 0,
        maxAttempts: 5,
      }),
    ]);
    expect(oss.deleteCalls.flat()).toEqual(
      expect.arrayContaining([oldPreviewKey, oldThumbnailKey]),
    );
  });

  it("rolls back manual replacement when indexing cannot be enqueued", async () => {
    const oldDocumentId = await seedVisualSearchIndex({
      ownerId,
      patternId,
      previewAssetId: oldPreviewAssetId,
    });
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId: randomUUID(), version: 0, extension: "png" },
    });
    const previewBytes = pngHeader(1200, 800);
    const thumbnailBytes = pngHeader(480, 320);
    oss.putObject(initialized.assets.preview.objectKey, previewBytes);
    oss.putObject(initialized.assets.thumbnail.objectKey, thumbnailBytes);

    await installRejectVisualSearchJobTrigger();
    try {
      await expect(
        service.complete({
          ownerId,
          patternId,
          input: {
            operationId: initialized.operationId,
            version: 0,
            assets: [
              {
                ...initialized.assets.preview,
                sizeBytes: previewBytes.byteLength,
                width: 1200,
                height: 800,
              },
              {
                ...initialized.assets.thumbnail,
                sizeBytes: thumbnailBytes.byteLength,
                width: 480,
                height: 320,
              },
            ],
          },
        }),
      ).rejects.toBeDefined();
    } finally {
      await removeRejectVisualSearchJobTrigger();
    }

    const rows = await db
      .select()
      .from(assets)
      .where(and(eq(assets.ownerId, ownerId), eq(assets.patternId, patternId)));
    expect(rows.map((row) => row.id)).toContain(oldPreviewAssetId);
    expect(rows.map((row) => row.id)).not.toContain(
      initialized.assets.preview.assetId,
    );
    expect(await db.select().from(visualSearchDocuments)).toEqual([
      expect.objectContaining({ id: oldDocumentId, previewAssetId: oldPreviewAssetId }),
    ]);
    expect(await db.select().from(visualSearchEmbeddings)).toHaveLength(1);
    expect(await db.select().from(visualSearchJobs)).toEqual([
      expect.objectContaining({
        previewAssetId: oldPreviewAssetId,
        status: "complete",
      }),
    ]);
    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    expect(pattern).toMatchObject({ version: 0, previewStatus: "ready" });
  });

  it("records a credential lease for permanent-deletion fencing", async () => {
    const operationId = randomUUID();

    await service.initialize({
      ownerId,
      patternId,
      input: { operationId, version: 0, extension: "png" },
    });

    const [lease] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.operationId, operationId));
    expect(lease).toMatchObject({
      id: operationId,
      ownerId,
      patternId,
      operationId,
      status: "uploading",
      credentialIssueFenceAt: null,
    });
    expect(lease?.credentialsExpireAt?.toISOString()).toBe(
      "2026-10-20T05:15:00.000Z",
    );
    expect(credentialIssuer.issues[0]?.objectKeys).toEqual([
      expect.stringMatching(/\/derived\/[0-9a-f-]+\.png$/),
      expect.stringMatching(/\/derived\/[0-9a-f-]+\.png$/),
    ]);
    expect(credentialIssuer.issues[0]?.objectKeys).not.toContain(
      `users/${ownerId}/patterns/${patternId}/source/${sourceAssetId}.psd`,
    );
  });

  it("does not issue new credentials after the manual preview completes", async () => {
    const operationId = randomUUID();
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId, version: 0, extension: "png" },
    });
    const previewBytes = pngHeader(1200, 800);
    const thumbnailBytes = pngHeader(480, 320);
    oss.putObject(initialized.assets.preview.objectKey, previewBytes);
    oss.putObject(initialized.assets.thumbnail.objectKey, thumbnailBytes);
    await service.complete({
      ownerId,
      patternId,
      input: {
        operationId,
        version: 0,
        assets: [
          {
            ...initialized.assets.preview,
            sizeBytes: previewBytes.byteLength,
            width: 1200,
            height: 800,
          },
          {
            ...initialized.assets.thumbnail,
            sizeBytes: thumbnailBytes.byteLength,
            width: 480,
            height: 320,
          },
        ],
      },
    });

    await expect(
      service.initialize({
        ownerId,
        patternId,
        input: { operationId, version: 0, extension: "png" },
      }),
    ).rejects.toMatchObject({ code: "PATTERN_STATE_CHANGED", status: 409 });
    expect(credentialIssuer.issues).toHaveLength(1);
  });

  it("allows only one completion verifier for an operation", async () => {
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId: randomUUID(), version: 0, extension: "png" },
    });
    const previewBytes = pngHeader(1200, 800);
    const thumbnailBytes = pngHeader(480, 320);
    oss.putObject(initialized.assets.preview.objectKey, previewBytes);
    oss.putObject(initialized.assets.thumbnail.objectKey, thumbnailBytes);
    const completionInput = {
      operationId: initialized.operationId,
      version: 0,
      assets: [
        {
          ...initialized.assets.preview,
          sizeBytes: previewBytes.byteLength,
          width: 1200,
          height: 800,
        },
        {
          ...initialized.assets.thumbnail,
          sizeBytes: thumbnailBytes.byteLength,
          width: 480,
          height: 320,
        },
      ],
    };
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalHead = oss.headObject.bind(oss);
    let headCalls = 0;
    vi.spyOn(oss, "headObject").mockImplementation(async (key) => {
      headCalls += 1;
      if (headCalls === 1) {
        signalFirst();
        await release;
      }
      if (headCalls === 3) throw new Error("SECOND_VERIFIER_FAILED");
      return originalHead(key);
    });

    const first = service.complete({
      ownerId,
      patternId,
      input: completionInput,
    });
    await firstBlocked;
    const cancellation = await service.cancel({
      ownerId,
      patternId,
      input: { operationId: initialized.operationId },
    });
    const second = service.complete({
      ownerId,
      patternId,
      input: completionInput,
    });
    const secondOutcome = await second.then(
      () => ({ code: "resolved" }),
      (error: unknown) => ({
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "unknown",
      }),
    );
    releaseFirst();
    await first;

    expect(cancellation).toEqual({ state: "verifying" });
    expect(secondOutcome).toEqual({ code: "PATTERN_STATE_CHANGED" });
    expect(oss.objects.has(initialized.assets.preview.objectKey)).toBe(true);
    expect(oss.objects.has(initialized.assets.thumbnail.objectKey)).toBe(true);
  });

  it("persists and retries cleanup after cancellation", async () => {
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId: randomUUID(), version: 0, extension: "png" },
    });
    oss.putObject(initialized.assets.preview.objectKey, pngHeader(1200, 800));
    oss.failDeleteCall = 1;

    await expect(
      service.cancel({
        ownerId,
        patternId,
        input: { operationId: initialized.operationId },
      }),
    ).resolves.toEqual({ state: "cleanup_pending" });
    expect(oss.objects.has(initialized.assets.preview.objectKey)).toBe(true);

    oss.failDeleteCall = null;
    await expect(service.cleanupPending({ limit: 50 })).resolves.toEqual({
      cleaned: 1,
      pending: 0,
    });
    expect(oss.objects.has(initialized.assets.preview.objectKey)).toBe(false);
    const [lease] = await db
      .select({ status: uploadSessions.status })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.operationId));
    expect(lease?.status).toBe("aborted");
  });

  it("persists old derived objects when post-commit deletion must retry", async () => {
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId: randomUUID(), version: 0, extension: "png" },
    });
    const previewBytes = pngHeader(1200, 800);
    const thumbnailBytes = pngHeader(480, 320);
    oss.putObject(initialized.assets.preview.objectKey, previewBytes);
    oss.putObject(initialized.assets.thumbnail.objectKey, thumbnailBytes);
    oss.failDeleteCall = 1;

    await expect(
      service.complete({
        ownerId,
        patternId,
        input: {
          operationId: initialized.operationId,
          version: 0,
          assets: [
            {
              ...initialized.assets.preview,
              sizeBytes: previewBytes.byteLength,
              width: 1200,
              height: 800,
            },
            {
              ...initialized.assets.thumbnail,
              sizeBytes: thumbnailBytes.byteLength,
              width: 480,
              height: 320,
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ pattern: { previewStatus: "manual" } });
    expect(oss.objects.has(oldPreviewKey)).toBe(true);

    oss.failDeleteCall = null;
    await expect(service.cleanupPending({ limit: 50 })).resolves.toEqual({
      cleaned: 1,
      pending: 0,
    });
    expect(oss.objects.has(oldPreviewKey)).toBe(false);
    expect(oss.objects.has(oldThumbnailKey)).toBe(false);
  });

  it("reclaims an abandoned object after its browser credential drains", async () => {
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId: randomUUID(), version: 0, extension: "png" },
    });
    oss.putObject(initialized.assets.preview.objectKey, pngHeader(1200, 800));
    const cleanupService = createManualPreviewService({
      database: db,
      oss,
      credentialIssuer,
      now: () => new Date("2026-10-20T05:20:00.000Z"),
    });

    await expect(cleanupService.cleanupPending({ limit: 50 })).resolves.toEqual({
      cleaned: 1,
      pending: 0,
    });
    expect(oss.objects.has(initialized.assets.preview.objectKey)).toBe(false);
    const [lease] = await db
      .select({ status: uploadSessions.status })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.operationId));
    expect(lease?.status).toBe("expired");
  });

  it("reclaims a stale verification claim only after its credential drains", async () => {
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId: randomUUID(), version: 0, extension: "png" },
    });
    oss.putObject(initialized.assets.preview.objectKey, pngHeader(1200, 800));
    const [operation] = await db
      .select({ result: operations.result })
      .from(operations)
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.operationId, initialized.operationId),
        ),
      );
    if (!operation) throw new Error("MANUAL_PREVIEW_OPERATION_NOT_FOUND");
    await db
      .update(operations)
      .set({
        result: {
          ...operation.result,
          completion: {
            fingerprint: "stale-verification",
            claimId: randomUUID(),
            state: "verifying",
          },
        },
      })
      .where(
        and(
          eq(operations.ownerId, ownerId),
          eq(operations.operationId, initialized.operationId),
        ),
      );

    await expect(service.cleanupPending({ limit: 50 })).resolves.toEqual({
      cleaned: 0,
      pending: 0,
    });
    expect(oss.objects.has(initialized.assets.preview.objectKey)).toBe(true);

    const cleanupService = createManualPreviewService({
      database: db,
      oss,
      credentialIssuer,
      now: () => new Date("2026-10-20T05:20:00.000Z"),
    });
    await expect(cleanupService.cleanupPending({ limit: 50 })).resolves.toEqual({
      cleaned: 1,
      pending: 0,
    });
    expect(oss.objects.has(initialized.assets.preview.objectKey)).toBe(false);
  });

  it("does not reveal another owner's pattern", async () => {
    await expect(
      service.initialize({
        ownerId: otherOwnerId,
        patternId,
        input: { operationId: randomUUID(), version: 0, extension: "png" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("rejects mismatched dimensions without replacing current assets", async () => {
    const initialized = await service.initialize({
      ownerId,
      patternId,
      input: { operationId: randomUUID(), version: 0, extension: "png" },
    });
    const previewBytes = pngHeader(100, 100);
    const thumbnailBytes = pngHeader(50, 50);
    oss.putObject(initialized.assets.preview.objectKey, previewBytes);
    oss.putObject(initialized.assets.thumbnail.objectKey, thumbnailBytes);

    await expect(
      service.complete({
        ownerId,
        patternId,
        input: {
          operationId: initialized.operationId,
          version: 0,
          assets: [
            { ...initialized.assets.preview, sizeBytes: 24, width: 101, height: 100 },
            { ...initialized.assets.thumbnail, sizeBytes: 24, width: 50, height: 50 },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "MANUAL_PREVIEW_INVALID", status: 422 });

    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, patternId));
    expect(pattern).toMatchObject({ version: 0, previewStatus: "ready" });
  });
});
