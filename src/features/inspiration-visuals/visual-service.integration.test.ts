import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  inspirationResultFixture,
  inspirationSourceFixture,
} from "@/features/inspiration/test-fixtures";
import { closeDatabase, db } from "@/lib/db/client";
import {
  assets as storageAssets,
  inspirationAnalyses,
  inspirationVisualAssets,
  inspirationVisualJobs,
  patterns,
  users,
} from "@/lib/db/schema";
import * as environment from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import { resetDatabase } from "@/test/database";

import * as repository from "./visual-repository";
import { importWebEvidence } from "./web-evidence-importer";
import type { WebEvidenceProvider } from "./web-agent-provider";
import { parseVisualObjectKey } from "./visual-object-keys";
import type { VisualObjectStore } from "./visual-object-store";
import {
  createResearchVisuals,
  getInspirationVisualBoard,
} from "./visual-service";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("inspiration visual service", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let analysisId: string;
  let otherAnalysisId: string;

  beforeEach(async () => {
    const env = environment.getServerEnv();
    vi.spyOn(environment, "getServerEnv").mockReturnValue({
      ...env,
      IMAGE_SEARCH_ENABLED: true,
      INSPIRATION_WEB_VISUALS_ENABLED: false,
    });
    await resetDatabase();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    analysisId = randomUUID();
    otherAnalysisId = randomUUID();

    await db.insert(users).values([
      {
        id: ownerId,
        email: "visual-owner@example.test",
        displayName: "Visual owner",
        passwordHash: "hash",
        mustChangePassword: false,
      },
      {
        id: otherOwnerId,
        email: "visual-other@example.test",
        displayName: "Other owner",
        passwordHash: "hash",
        mustChangePassword: false,
      },
    ]);
    await db.insert(inspirationAnalyses).values([
      {
        id: analysisId,
        ownerId,
        operationId: randomUUID(),
        prompt: "分析都市轻通勤女装",
        title: "都市轻通勤",
        status: "completed",
        sources: [inspirationSourceFixture],
        result: inspirationResultFixture,
        searchModel: "qwen-plus",
        structureModel: "qwen3.8-flash",
        completedAt: new Date("2026-10-29T00:00:00.000Z"),
      },
      {
        id: otherAnalysisId,
        ownerId: otherOwnerId,
        operationId: randomUUID(),
        prompt: "分析自然主义家居趋势",
        title: "自然主义家居",
        status: "completed",
        sources: [inspirationSourceFixture],
        result: inspirationResultFixture,
        searchModel: "qwen-plus",
        structureModel: "qwen3.8-flash",
        completedAt: new Date("2026-10-29T00:00:00.000Z"),
      },
    ]);
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(closeDatabase);

  const seedPattern = async () => {
    const patternId = randomUUID();
    const assetId = randomUUID();
    await db.insert(patterns).values({
      id: patternId,
      ownerId,
      name: "旧素材库图案",
      originalFilename: "legacy.png",
      extension: "png",
      sizeBytes: 1024n,
      status: "ready",
      previewStatus: "ready",
    });
    await db.insert(storageAssets).values({
      id: assetId,
      ownerId,
      patternId,
      role: "thumbnail",
      objectKey: `users/${ownerId}/patterns/${patternId}/thumbnail.png`,
      originalFilename: "legacy.png",
      detectedMimeType: "image/png",
      sizeBytes: 1024n,
      width: 640,
      height: 480,
    });
    return { patternId, assetId };
  };

  const seedJob = async (
    overrides: Partial<typeof inspirationVisualJobs.$inferInsert> = {},
  ) => {
    const createdAt = new Date(Date.now() - 2 * 60_000);
    const completedAt = new Date(Date.now() - 90_000);
    const [row] = await db
      .insert(inspirationVisualJobs)
      .values({
        id: randomUUID(),
        ownerId,
        analysisId,
        operationId: randomUUID(),
        kind: "research_visuals",
        directionIndex: null,
        status: "completed",
        warnings: [],
        completedAt,
        createdAt,
        updatedAt: completedAt,
        ...overrides,
      })
      .returning();
    return row!;
  };

  const seedLegacyLibraryAsset = (jobId: string, patternId: string) =>
    db.insert(inspirationVisualAssets).values({
      id: randomUUID(),
      ownerId,
      analysisId,
      jobId,
      kind: "library_match",
      ordinal: 0,
      directionIndex: null,
      title: "旧素材库图案",
      altText: "旧素材库图案预览",
      patternId,
    });

  function webHarness() {
    vi.mocked(environment.getServerEnv).mockReturnValue({
      ...environment.getServerEnv(),
      INSPIRATION_WEB_VISUALS_ENABLED: true,
    });
    const objects = new Map<string, Uint8Array>();
    const deleted: string[][] = [];
    const store: VisualObjectStore = {
      async put({ key, bytes }) {
        objects.set(key, bytes);
      },
      async get(key) {
        return { bytes: objects.get(key)!, contentType: "image/jpeg" };
      },
      async delete(keys) {
        deleted.push([...keys]);
        keys.forEach((key) => objects.delete(key));
      },
    };
    const webProvider: WebEvidenceProvider = {
      search: vi.fn(
        async (input: Parameters<WebEvidenceProvider["search"]>[0]) => ({
          requestId: input.requestId,
          candidates: input.intents
            .filter(({ role }) => role === "hero" || role === "product")
            .map((intent, index) => ({
              query: intent.query,
              title: `Evidence ${index}`,
              imageUrl: `https://images.test/${index}.jpg`,
              sourcePageUrl: inspirationSourceFixture.url,
              sourceSiteName: "Source",
              priceText: "$25",
            })),
        })),
    };
    const importWeb: typeof importWebEvidence = vi.fn(async (input) =>
      importWebEvidence(input, {
        store,
        fetchImage: async (url) => {
          const bytes = Buffer.from([
            0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
            0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0xff, 0x00,
            0x34, 0xff, 0xd9,
          ]);
          bytes[25] = url.includes("/0.") ? 1 : 2;
          return {
            bytes,
            contentType: "image/jpeg",
            extension: "jpg",
            width: 1,
            height: 1,
          };
        },
      }),
    );
    const run = (operationId = randomUUID(), signal?: AbortSignal) =>
      createResearchVisuals(
        { ownerId, analysisId, operationId, signal },
        { webProvider, importWeb, store },
      );
    return { objects, deleted, store, webProvider, importWeb, run };
  }

  it("requires a completed owned analysis before external work", async () => {
    const web = webHarness();
    await db
      .update(inspirationAnalyses)
      .set({
        status: "failed",
        sources: null,
        result: null,
        completedAt: null,
        errorCode: "INSPIRATION_INTERRUPTED",
      })
      .where(eq(inspirationAnalyses.id, analysisId));

    await expect(web.run()).rejects.toMatchObject({
      code: "INSPIRATION_BUSY",
      status: 409,
    });
    await expect(
      createResearchVisuals(
        { ownerId: otherOwnerId, analysisId, operationId: randomUUID() },
        {
          webProvider: web.webProvider,
          importWeb: web.importWeb,
          store: web.store,
        },
      ),
    ).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
    expect(web.webProvider.search).not.toHaveBeenCalled();
    expect(web.importWeb).not.toHaveBeenCalled();
  });

  it("hides legacy private-library rows and does not expose a library-only refresh", async () => {
    const { patternId } = await seedPattern();
    const active = await seedJob();
    await seedLegacyLibraryAsset(active.id, patternId);

    const board = await getInspirationVisualBoard({ ownerId, analysisId });

    expect(board.activeJob?.id).toBe(active.id);
    expect(board.libraryMatches).toEqual([]);
    expect(board.webEvidence).toEqual([]);
    expect(board.refreshAvailable).toBe(false);
    expect(JSON.stringify(board)).not.toContain("旧素材库图案");
  });

  it("repairs stale pending research jobs as interrupted", async () => {
    const stale = new Date(Date.now() - 4 * 60_000);
    const job = await seedJob({
      status: "pending",
      completedAt: null,
      createdAt: stale,
      updatedAt: stale,
    });
    const otherJob = await seedJob({
      ownerId: otherOwnerId,
      analysisId: otherAnalysisId,
      status: "pending",
      completedAt: null,
      createdAt: stale,
      updatedAt: stale,
    });

    const board = await getInspirationVisualBoard({ ownerId, analysisId });

    expect(board.activeJob).toBeNull();
    expect(board.refreshJob).toMatchObject({
      id: job.id,
      status: "failed",
      errorCode: "INSPIRATION_VISUALS_INTERRUPTED",
    });
    expect(board.refreshJob!.completedAt).not.toBeNull();
    expect(
      (await db.select().from(inspirationVisualJobs)).find(
        ({ id }) => id === otherJob.id,
      )?.status,
    ).toBe("pending");
  });

  it("atomically completes external evidence with editorial metadata", async () => {
    const web = webHarness();
    const board = await web.run();

    expect(board.webEvidence.map(({ role }) => role)).toEqual([
      "hero",
      "product",
    ]);
    expect(board.webEvidence[1]).toMatchObject({
      sourceIndexes: [1],
      productName: "棉麻衬衫叠穿",
      brand: null,
      priceText: "$25",
    });
    expect(board.libraryMatches).toEqual([]);
    expect(board.refreshAvailable).toBe(true);
    expect(web.webProvider.search).toHaveBeenCalledTimes(1);

    const keys = await repository.listObjectKeysForJob(
      ownerId,
      board.activeJob!.id,
    );
    expect(keys.sort()).toEqual([...web.objects.keys()].sort());
    for (const asset of board.webEvidence) {
      expect(
        keys.some((key) => parseVisualObjectKey(key).assetId === asset.id),
      ).toBe(true);
      expect(asset.imageUrl).toBe(
        `/api/inspiration-visual-assets/${asset.id}`,
      );
      expect(
        await repository.findOwnedCompletedAsset(otherOwnerId, asset.id),
      ).toBeUndefined();
      expect(
        await repository.findOwnedCompletedAsset(ownerId, asset.id),
      ).toMatchObject({ id: asset.id });
    }
    expect(
      await repository.listObjectKeysForAnalysis(otherOwnerId, analysisId),
    ).toEqual([]);
    expect(JSON.stringify(board)).not.toMatch(
      /objectKey|contentType|providerRequestId|providerTaskId/,
    );
  });

  it("keeps external research independent from image-search availability", async () => {
    const web = webHarness();
    vi.mocked(environment.getServerEnv).mockReturnValue({
      ...environment.getServerEnv(),
      IMAGE_SEARCH_ENABLED: false,
    });

    const board = await web.run();

    expect(board.webEvidence).toHaveLength(2);
    expect(board.libraryMatches).toEqual([]);
    expect(board.activeJob!.warnings).toEqual([]);
  });

  it("commits partial image imports with deduplicated warnings", async () => {
    const web = webHarness();
    const put = web.store.put;
    web.store.put = async (input) => {
      if (input.bytes[25] === 2) throw new Error("write failed");
      await put(input);
    };

    const board = await web.run();

    expect(board.webEvidence).toHaveLength(1);
    expect(board.activeJob!.warnings).toEqual([
      "INSPIRATION_WEB_VISUALS_UNAVAILABLE",
    ]);
    expect(web.objects.size).toBe(1);
  });

  it.each([
    ["empty", "INSPIRATION_VISUALS_EMPTY"],
    ["unavailable", "INSPIRATION_VISUALS_UNAVAILABLE"],
  ] as const)("classifies an external provider result as %s", async (state, code) => {
    const web = webHarness();
    vi.mocked(web.webProvider.search).mockRejectedValue(
      new AppError(
        state === "empty"
          ? "INSPIRATION_VISUALS_EMPTY"
          : "INSPIRATION_VISUALS_UNAVAILABLE",
        503,
        "redacted",
      ),
    );

    await expect(web.run()).rejects.toMatchObject({ code });
    expect(
      (await getInspirationVisualBoard({ ownerId, analysisId })).refreshJob!
        .errorCode,
    ).toBe(code);
    expect(web.importWeb).not.toHaveBeenCalled();
  });

  it("returns only the external-disabled warning without paid calls", async () => {
    const web = webHarness();
    vi.mocked(environment.getServerEnv).mockReturnValue({
      ...environment.getServerEnv(),
      INSPIRATION_WEB_VISUALS_ENABLED: false,
      IMAGE_SEARCH_ENABLED: false,
    });

    await expect(web.run()).rejects.toMatchObject({
      code: "INSPIRATION_VISUALS_EMPTY",
    });
    const board = await getInspirationVisualBoard({ ownerId, analysisId });
    expect(board.refreshAvailable).toBe(false);
    expect(board.refreshJob!.warnings).toEqual([
      "INSPIRATION_WEB_VISUALS_DISABLED",
    ]);
    expect(web.webProvider.search).not.toHaveBeenCalled();
    expect(web.importWeb).not.toHaveBeenCalled();
  });

  it("replays one operation without duplicate external work and rejects another target", async () => {
    const web = webHarness();
    const operationId = randomUUID();
    const board = await web.run(operationId);

    await expect(web.run(operationId)).resolves.toEqual(board);
    expect(web.webProvider.search).toHaveBeenCalledTimes(1);
    expect(web.importWeb).toHaveBeenCalledTimes(1);

    const reused = randomUUID();
    await seedJob({
      operationId: reused,
      kind: "concept_image",
      directionIndex: 0,
    });
    await expect(web.run(reused)).rejects.toMatchObject({
      code: "OPERATION_ID_REUSED",
      status: 409,
    });
    expect(web.webProvider.search).toHaveBeenCalledTimes(1);
  });

  it.each(["transaction throws", "pending ownership lost"] as const)(
    "compensates every written key when %s",
    async (failure) => {
      const web = webHarness();
      if (failure === "transaction throws") {
        vi.spyOn(repository, "completeResearchJob").mockRejectedValue(
          new Error("database failed"),
        );
      } else {
        const originalImport = vi
          .mocked(web.importWeb)
          .getMockImplementation()!;
        vi.mocked(web.importWeb).mockImplementationOnce(async (...args) => {
          const imported = await originalImport(...args);
          const [pending] = await db.select().from(inspirationVisualJobs);
          await repository.failPendingJob(
            ownerId,
            pending!.id,
            "INSPIRATION_VISUALS_INTERRUPTED",
            new Date(),
          );
          return imported;
        });
      }

      await expect(web.run()).rejects.toMatchObject({
        code:
          failure === "transaction throws"
            ? "INSPIRATION_VISUALS_UNAVAILABLE"
            : "INSPIRATION_VISUALS_BUSY",
      });
      expect(web.deleted.flat()).toHaveLength(2);
      expect(web.objects.size).toBe(0);
      expect(await db.select().from(inspirationVisualAssets)).toEqual([]);
    },
  );

  it("compensates imports if the request aborts before completion", async () => {
    const web = webHarness();
    const controller = new AbortController();
    const originalImport = vi.mocked(web.importWeb).getMockImplementation()!;
    vi.mocked(web.importWeb).mockImplementationOnce(async (...args) => {
      const result = await originalImport(...args);
      controller.abort();
      return result;
    });

    await expect(
      web.run(randomUUID(), controller.signal),
    ).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    expect(web.objects.size).toBe(0);
    expect(web.deleted.flat()).toHaveLength(2);
    expect(await db.select().from(inspirationVisualAssets)).toEqual([]);
  });

  it.each([false, true])(
    "deletes superseded keys only after refresh commit, cleanup failure=%s",
    async (cleanupFails) => {
      const web = webHarness();
      const old = await web.run();
      const oldKeys = [...web.objects.keys()];
      const started = deferred();
      const release = deferred();
      const originalImport = vi.mocked(web.importWeb).getMockImplementation()!;
      vi.mocked(web.importWeb).mockImplementationOnce(async (...args) => {
        started.resolve();
        await release.promise;
        return originalImport(...args);
      });
      const remove = web.store.delete;
      web.store.delete = async (keys) => {
        const board = await getInspirationVisualBoard({ ownerId, analysisId });
        expect(board.activeJob!.id).not.toBe(old.activeJob!.id);
        if (cleanupFails) throw new Error("cleanup failed");
        await remove(keys);
      };
      const refresh = web.run();

      try {
        await started.promise;
        const board = await getInspirationVisualBoard({ ownerId, analysisId });
        expect(board.activeJob!.id).toBe(old.activeJob!.id);
        expect(board.webEvidence).toEqual(old.webEvidence);
        expect(oldKeys.every((key) => web.objects.has(key))).toBe(true);
        expect(web.deleted).toEqual([]);
      } finally {
        release.resolve();
      }

      const next = await refresh;
      expect(next.activeJob!.id).not.toBe(old.activeJob!.id);
      if (!cleanupFails) {
        expect(web.deleted.flat().sort()).toEqual(oldKeys.sort());
      }
    },
  );

  it("preserves old web objects and board after a failed refresh", async () => {
    const web = webHarness();
    const old = await web.run();
    const oldKeys = [...web.objects.keys()];
    vi.mocked(web.webProvider.search).mockRejectedValue(
      new Error("provider failed"),
    );

    await expect(web.run()).rejects.toMatchObject({
      code: "INSPIRATION_VISUALS_UNAVAILABLE",
    });
    const board = await getInspirationVisualBoard({ ownerId, analysisId });
    expect(board.activeJob!.id).toBe(old.activeJob!.id);
    expect(board.webEvidence).toEqual(old.webEvidence);
    expect([...web.objects.keys()]).toEqual(oldKeys);
    expect(web.deleted).toEqual([]);
  });

  it("authorizes only completed owner assets", async () => {
    const web = webHarness();
    const board = await web.run();
    await db
      .update(inspirationVisualJobs)
      .set({
        status: "failed",
        errorCode: "INSPIRATION_VISUALS_INTERRUPTED",
      })
      .where(eq(inspirationVisualJobs.id, board.activeJob!.id));

    expect(
      await repository.findOwnedCompletedAsset(
        ownerId,
        board.webEvidence[0]!.id,
      ),
    ).toBeUndefined();
    expect(
      await repository.listVisibleAssets(ownerId, board.activeJob!.id),
    ).toEqual([]);
  });

  it("rolls back state when asset insertion fails and compensates objects", async () => {
    const web = webHarness();
    const originalImport = vi.mocked(web.importWeb).getMockImplementation()!;
    vi.mocked(web.importWeb).mockImplementationOnce(async (...args) => {
      const imported = await originalImport(...args);
      imported.assets[1]!.id = imported.assets[0]!.id;
      return imported;
    });

    await expect(web.run()).rejects.toMatchObject({
      code: "INSPIRATION_VISUALS_UNAVAILABLE",
    });
    const [failed] = await db.select().from(inspirationVisualJobs);
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "INSPIRATION_VISUALS_UNAVAILABLE",
    });
    expect(await db.select().from(inspirationVisualAssets)).toEqual([]);
    expect(web.objects.size).toBe(0);
    expect(web.deleted.flat()).toHaveLength(2);
  });

  it("allows one pending winner and replay without duplicate external work", async () => {
    const web = webHarness();
    const started = deferred();
    const release = deferred();
    const search = vi.mocked(web.webProvider.search).getMockImplementation()!;
    vi.mocked(web.webProvider.search).mockImplementation(async (input) => {
      started.resolve();
      await release.promise;
      return search(input);
    });
    const operationId = randomUUID();
    const winner = web.run(operationId);

    try {
      await started.promise;
      const replay = await web.run(operationId);
      expect(replay.refreshJob!.status).toBe("pending");
      await expect(web.run()).rejects.toMatchObject({
        code: "INSPIRATION_VISUALS_BUSY",
      });
      expect(web.webProvider.search).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }

    expect((await winner).webEvidence).toHaveLength(2);
    expect(web.importWeb).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-owner requests before external work", async () => {
    const web = webHarness();

    await expect(
      createResearchVisuals(
        {
          ownerId: otherOwnerId,
          analysisId,
          operationId: randomUUID(),
        },
        {
          webProvider: web.webProvider,
          importWeb: web.importWeb,
          store: web.store,
        },
      ),
    ).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND" });
    expect(web.webProvider.search).not.toHaveBeenCalled();
    expect(web.importWeb).not.toHaveBeenCalled();
  });
});
