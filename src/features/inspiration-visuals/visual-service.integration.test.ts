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
import { resetDatabase } from "@/test/database";
import * as environment from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import * as repository from "./visual-repository";
import { importWebEvidence } from "./web-evidence-importer";
import type { WebEvidenceProvider } from "./web-agent-provider";
import type { VisualObjectStore } from "./visual-object-store";
import { parseVisualObjectKey } from "./visual-object-keys";

import type {
  LibraryMatchCandidate,
  LibraryMatchResult,
  matchLibraryPatterns,
} from "./library-matcher";
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
    vi.spyOn(environment, "getServerEnv").mockReturnValue({ ...env, IMAGE_SEARCH_ENABLED: true, INSPIRATION_WEB_VISUALS_ENABLED: false });
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

  const seedPattern = async (
    input: {
      ownerId?: string;
      status?: typeof patterns.$inferInsert.status;
      name?: string;
    } = {},
  ) => {
    const patternId = randomUUID();
    const assetId = randomUUID();
    const patternOwnerId = input.ownerId ?? ownerId;
    await db.insert(patterns).values({
      id: patternId,
      ownerId: patternOwnerId,
      name: input.name ?? "雨后花园",
      originalFilename: "garden.png",
      extension: "png",
      sizeBytes: 1024n,
      status: input.status ?? "ready",
      previewStatus: "ready",
    });
    await db.insert(storageAssets).values({
      id: assetId,
      ownerId: patternOwnerId,
      patternId,
      role: "thumbnail",
      objectKey: `users/${patternOwnerId}/patterns/${patternId}/thumbnail.png`,
      originalFilename: "garden.png",
      detectedMimeType: "image/png",
      sizeBytes: 1024n,
      width: 640,
      height: 480,
    });
    return { patternId, assetId };
  };

  const candidate = (
    patternId: string,
    overrides: Partial<LibraryMatchCandidate> = {},
  ): LibraryMatchCandidate => ({
    kind: "library_match",
    ordinal: 0,
    directionIndex: null,
    title: "雨后花园",
    altText: "雨后花园的图库图案预览",
    patternId,
    ...overrides,
  });

  const create = (
    operationId = randomUUID(),
    matchLibrary: typeof matchLibraryPatterns = vi.fn(
      async (): Promise<LibraryMatchResult> => ({ assets: [], warnings: [] }),
    ),
  ) =>
    createResearchVisuals(
      { ownerId, analysisId, operationId },
      { matchLibrary },
    );

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

  const seedVisualAsset = (
    jobId: string,
    patternId: string,
    overrides: Partial<typeof inspirationVisualAssets.$inferInsert> = {},
  ) =>
    db.insert(inspirationVisualAssets).values({
      id: randomUUID(),
      ownerId,
      analysisId,
      jobId,
      kind: "library_match",
      ordinal: 0,
      directionIndex: null,
      title: "雨后花园",
      altText: "雨后花园的图库图案预览",
      patternId,
      ...overrides,
    });

  it("requires a completed owned analysis before running the matcher", async () => {
    const matchLibrary = vi.fn();
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

    await expect(create(randomUUID(), matchLibrary)).rejects.toMatchObject({
      code: "INSPIRATION_BUSY",
      status: 409,
    });
    await expect(
      createResearchVisuals({
        ownerId: otherOwnerId,
        analysisId,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
    expect(matchLibrary).not.toHaveBeenCalled();
  });

  it("completes with partial library success and returns a browser-safe board", async () => {
    const { patternId, assetId } = await seedPattern();
    const operationId = randomUUID();
    const matchLibrary = vi.fn(async () => ({
      assets: [candidate(patternId)],
      warnings: ["INSPIRATION_WEB_VISUALS_UNAVAILABLE" as const],
    }));

    const board = await create(operationId, matchLibrary);

    expect(matchLibrary).toHaveBeenCalledWith({
      ownerId,
      result: inspirationResultFixture,
      signal: expect.any(AbortSignal),
    });
    expect(board.activeJob).toMatchObject({
      kind: "research_visuals",
      status: "completed",
      warnings: ["INSPIRATION_WEB_VISUALS_DISABLED", "INSPIRATION_WEB_VISUALS_UNAVAILABLE"],
    });
    expect(board.refreshJob).toBeNull();
    expect(board.refreshAvailable).toBe(true);
    expect(board.libraryMatches).toEqual([
      {
        id: expect.any(String),
        kind: "library_match",
        ordinal: 0,
        directionIndex: null,
        title: "雨后花园",
        altText: "雨后花园的图库图案预览",
        imageUrl: `/api/assets/${assetId}/view`,
        libraryHref: `/library?selected=${patternId}`,
        patternId,
        palette: [],
      },
    ]);
    expect(board).toMatchObject({
      webEvidence: [],
      conceptJobs: [],
      concepts: [],
    });
    expect(JSON.stringify(board)).not.toMatch(
      /ownerId|objectKey|providerTaskId|providerRequestId/i,
    );
    expect(
      (await db.select().from(inspirationAnalyses))[0]!.result,
    ).toEqual(inspirationResultFixture);
  });

  it("replays one operation without another match and rejects a different target", async () => {
    const { patternId } = await seedPattern();
    const operationId = randomUUID();
    const matchLibrary = vi.fn(async () => ({
      assets: [candidate(patternId)],
      warnings: [],
    }));

    const first = await create(operationId, matchLibrary);
    await expect(create(operationId, matchLibrary)).resolves.toEqual(first);
    expect(matchLibrary).toHaveBeenCalledTimes(1);

    const reused = randomUUID();
    await seedJob({
      operationId: reused,
      kind: "concept_image",
      directionIndex: 0,
    });
    await expect(create(reused, matchLibrary)).rejects.toMatchObject({
      code: "OPERATION_ID_REUSED",
      status: 409,
    });
    expect(matchLibrary).toHaveBeenCalledTimes(1);
  });

  it("lets exactly one concurrent operation own a pending target", async () => {
    const { patternId } = await seedPattern();
    const started = deferred();
    const release = deferred();
    const matchLibrary = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return { assets: [candidate(patternId)], warnings: [] };
    });
    const winner = create(randomUUID(), matchLibrary);

    try {
      await started.promise;
      await expect(create(randomUUID(), matchLibrary)).rejects.toMatchObject({
        code: "INSPIRATION_VISUALS_BUSY",
        status: 409,
      });
      expect(matchLibrary).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }

    await expect(winner).resolves.toMatchObject({
      activeJob: { status: "completed" },
    });
  });

  it("keeps the completed mosaic visible while a refresh is pending", async () => {
    const oldPattern = await seedPattern({ name: "旧图案" });
    const nextPattern = await seedPattern({ name: "新图案" });
    const active = await seedJob();
    await seedVisualAsset(active.id, oldPattern.patternId);
    const started = deferred();
    const release = deferred();
    const request = create(
      randomUUID(),
      vi.fn(async () => {
        started.resolve();
        await release.promise;
        return {
          assets: [candidate(nextPattern.patternId)],
          warnings: [],
        };
      }),
    );

    try {
      await started.promise;
      const pending = await getInspirationVisualBoard({ ownerId, analysisId });
      expect(pending.activeJob?.id).toBe(active.id);
      expect(pending.refreshJob).toMatchObject({ status: "pending" });
      expect(pending.libraryMatches.map(({ patternId }) => patternId)).toEqual([
        oldPattern.patternId,
      ]);
    } finally {
      release.resolve();
    }
    await request;
  });

  it.each(["trashed", "missing preview"] as const)(
    "rejects a refresh whose matched pattern becomes %s before completion",
    async (failure) => {
      const previous = await seedPattern({ name: "旧图案" });
      const candidatePattern = await seedPattern({ name: "失效图案" });
      const active = await seedJob();
      await seedVisualAsset(active.id, previous.patternId);
      const started = deferred();
      const release = deferred();
      const request = create(
        randomUUID(),
        vi.fn(async () => {
          started.resolve();
          await release.promise;
          return {
            assets: [candidate(candidatePattern.patternId)],
            warnings: [],
          };
        }),
      );

      await started.promise;
      if (failure === "trashed") {
        await db
          .update(patterns)
          .set({ status: "trashed", trashedAt: new Date() })
          .where(eq(patterns.id, candidatePattern.patternId));
      } else {
        await db
          .delete(storageAssets)
          .where(eq(storageAssets.id, candidatePattern.assetId));
      }
      release.resolve();

      await expect(request).rejects.toMatchObject({
        code: "INSPIRATION_VISUALS_EMPTY",
        status: 503,
      });
      const board = await getInspirationVisualBoard({ ownerId, analysisId });
      expect(board.activeJob?.id).toBe(active.id);
      expect(board.libraryMatches.map(({ patternId }) => patternId)).toEqual([
        previous.patternId,
      ]);
      expect(board.refreshJob).toMatchObject({
        status: "failed",
        errorCode: "INSPIRATION_VISUALS_EMPTY",
      });
    },
  );

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

  it("keeps the last completed board when a refresh produces no assets", async () => {
    const { patternId } = await seedPattern();
    const active = await seedJob();
    await seedVisualAsset(active.id, patternId);

    const error = await create(
      randomUUID(),
      vi.fn(async () => ({
        assets: [],
        warnings: ["INSPIRATION_LIBRARY_MATCH_EMPTY" as const],
      })),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "INSPIRATION_VISUALS_EMPTY",
      status: 503,
      details: { jobId: expect.any(String) },
    });

    const board = await getInspirationVisualBoard({ ownerId, analysisId });
    expect(board.activeJob?.id).toBe(active.id);
    expect(board.libraryMatches).toHaveLength(1);
    expect(board.refreshJob).toMatchObject({
      id: (error as { details: { jobId: string } }).details.jobId,
      status: "failed",
      errorCode: "INSPIRATION_VISUALS_EMPTY",
      warnings: ["INSPIRATION_WEB_VISUALS_DISABLED", "INSPIRATION_LIBRARY_MATCH_EMPTY"],
    });
  });

  it("switches to a successful refresh and hides older failed refresh state", async () => {
    const oldPattern = await seedPattern({ name: "旧图案" });
    const nextPattern = await seedPattern({ name: "新图案" });
    const old = await seedJob({
      createdAt: new Date(Date.now() - 6 * 60_000),
      completedAt: new Date(Date.now() - 5 * 60_000),
      updatedAt: new Date(Date.now() - 5 * 60_000),
    });
    await seedVisualAsset(old.id, oldPattern.patternId);
    await seedJob({
      status: "failed",
      errorCode: "INSPIRATION_VISUALS_UNAVAILABLE",
      createdAt: new Date(Date.now() - 4 * 60_000),
      completedAt: new Date(Date.now() - 3 * 60_000),
      updatedAt: new Date(Date.now() - 3 * 60_000),
    });

    const board = await create(
      randomUUID(),
      vi.fn(async () => ({
        assets: [candidate(nextPattern.patternId, { title: "新图案", altText: "新图案的图库图案预览" })],
        warnings: [],
      })),
    );

    expect(board.activeJob?.id).not.toBe(old.id);
    expect(board.refreshJob).toBeNull();
    expect(board.libraryMatches.map(({ patternId }) => patternId)).toEqual([
      nextPattern.patternId,
    ]);
  });

  it("hides library references after patterns enter trash or deleted states", async () => {
    const first = await seedPattern({ name: "回收图案" });
    const second = await seedPattern({ name: "删除图案" });
    const board = await create(
      randomUUID(),
      vi.fn(async () => ({
        assets: [
          candidate(first.patternId),
          candidate(second.patternId, { ordinal: 1 }),
        ],
        warnings: [],
      })),
    );
    expect(board.libraryMatches).toHaveLength(2);

    await db
      .update(patterns)
      .set({ status: "trashed", trashedAt: new Date() })
      .where(eq(patterns.id, first.patternId));
    await db
      .update(patterns)
      .set({ status: "deleted", deletedAt: new Date() })
      .where(eq(patterns.id, second.patternId));

    expect(
      (await getInspirationVisualBoard({ ownerId, analysisId }))
        .libraryMatches,
    ).toEqual([]);
  });

  it("sanitizes matcher failures and fences the failed pending job", async () => {
    const error = await create(
      randomUUID(),
      vi.fn(async () => {
        throw new Error("private search transport response");
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "INSPIRATION_VISUALS_UNAVAILABLE",
      status: 503,
      details: { jobId: expect.any(String) },
    });
    expect((error as Error).message).not.toContain("private");
    const [job] = await db.select().from(inspirationVisualJobs);
    expect(job).toMatchObject({
      status: "failed",
      errorCode: "INSPIRATION_VISUALS_UNAVAILABLE",
    });
    expect(await db.select().from(inspirationVisualAssets)).toEqual([]);
  });
  function webHarness() {
    vi.mocked(environment.getServerEnv).mockReturnValue({ ...environment.getServerEnv(), INSPIRATION_WEB_VISUALS_ENABLED: true });
    const objects = new Map<string, Uint8Array>();
    const deleted: string[][] = [];
    const store: VisualObjectStore = {
      async put({ key, bytes }) { objects.set(key, bytes); },
      async get(key) { return { bytes: objects.get(key)!, contentType: "image/jpeg" }; },
      async delete(keys) { deleted.push([...keys]); keys.forEach((key) => objects.delete(key)); },
    };
    const webProvider: WebEvidenceProvider = { search: vi.fn(async (input: Parameters<WebEvidenceProvider["search"]>[0]) => ({
      requestId: input.requestId,
      candidates: input.intents.filter(({ role }) => role === "hero" || role === "product").map((intent, index) => ({
        query: intent.query, title: `Evidence ${index}`, imageUrl: `https://images.test/${index}.jpg`,
        sourcePageUrl: inspirationSourceFixture.url, sourceSiteName: "Source", priceText: "$25",
      })),
    })) };
    const importWeb: typeof importWebEvidence = vi.fn(async (input) => importWebEvidence(input, {
      store,
      fetchImage: async (url) => {
        const bytes = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0x12,0xff,0x00,0x34,0xff,0xd9]);
        bytes[25] = url.includes("/0.") ? 1 : 2;
        return { bytes, contentType: "image/jpeg", extension: "jpg", width: 1, height: 1 };
      },
    }));
    const matchLibrary = vi.fn<typeof matchLibraryPatterns>(async () => ({ assets: [], warnings: [] }));
    const run = (operationId = randomUUID(), signal?: AbortSignal) => createResearchVisuals(
      { ownerId, analysisId, operationId, signal }, { webProvider, importWeb, store, matchLibrary },
    );
    return { objects, deleted, store, webProvider, importWeb, matchLibrary, run };
  }

  it("atomically completes web and library branches preserving image IDs and editorial metadata", async () => {
    const { patternId } = await seedPattern();
    const web = webHarness();
    web.matchLibrary.mockResolvedValue({ assets: [candidate(patternId, { ordinal: 9 })], warnings: [] });
    const board = await web.run();
    expect(board.webEvidence.map(({ role }) => role)).toEqual(["hero", "product"]);
    expect(board.webEvidence[1]).toMatchObject({ sourceIndexes: [1], productName: "棉麻衬衫叠穿", brand: null, priceText: "$25" });
    expect(board.libraryMatches[0]).toMatchObject({ patternId, ordinal: 0 });
    expect(web.webProvider.search).toHaveBeenCalledTimes(1);
    const keys = await repository.listObjectKeysForJob(ownerId, board.activeJob!.id);
    expect(keys.sort()).toEqual([...web.objects.keys()].sort());
    for (const asset of board.webEvidence) {
      expect(keys.some((key) => parseVisualObjectKey(key).assetId === asset.id)).toBe(true);
      expect(asset.imageUrl).toBe(`/api/inspiration-visual-assets/${asset.id}`);
      expect(await repository.findOwnedCompletedAsset(otherOwnerId, asset.id)).toBeUndefined();
      expect(await repository.findOwnedCompletedAsset(ownerId, asset.id)).toMatchObject({ id: asset.id });
    }
    expect(await repository.listObjectKeysForAnalysis(otherOwnerId, analysisId)).toEqual([]);
    expect(JSON.stringify(board)).not.toMatch(/objectKey|contentType|providerRequestId|providerTaskId/);
  });

  it.each(["empty", "unavailable", "disabled"] as const)("completes web evidence when library is %s", async (state) => {
    const web = webHarness();
    if (state === "unavailable") web.matchLibrary.mockRejectedValue(new Error("private library failure"));
    if (state === "disabled") vi.mocked(environment.getServerEnv).mockReturnValue({ ...environment.getServerEnv(), IMAGE_SEARCH_ENABLED: false });
    const board = await web.run();
    expect(board.webEvidence).toHaveLength(2);
    expect(board.libraryMatches).toEqual([]);
    expect(board.refreshAvailable).toBe(true);
    if (state !== "empty") expect(board.activeJob!.warnings).toContain(state === "disabled" ? "INSPIRATION_LIBRARY_MATCH_DISABLED" : "INSPIRATION_LIBRARY_MATCH_UNAVAILABLE");
    if (state === "disabled") expect(web.matchLibrary).not.toHaveBeenCalled();
  });

  it("retains library matches when the web provider is unavailable", async () => {
    const { patternId } = await seedPattern();
    const web = webHarness();
    vi.mocked(web.webProvider.search).mockRejectedValue(new Error("private upstream response"));
    web.matchLibrary.mockResolvedValue({ assets: [candidate(patternId)], warnings: [] });
    const board = await web.run();
    expect(board.libraryMatches).toHaveLength(1);
    expect(board.activeJob!.warnings).toEqual(["INSPIRATION_WEB_VISUALS_UNAVAILABLE"]);
    expect(web.importWeb).not.toHaveBeenCalled();
  });

  it("commits partial image imports with deduplicated warnings", async () => {
    const web = webHarness();
    const put = web.store.put;
    web.store.put = async (input) => { if (input.bytes[25] === 2) throw new Error("write failed"); await put(input); };
    const board = await web.run();
    expect(board.webEvidence).toHaveLength(1);
    expect(board.activeJob!.warnings).toEqual(["INSPIRATION_WEB_VISUALS_UNAVAILABLE"]);
    expect(web.objects.size).toBe(1);
  });

  it.each([
    ["empty", false, "INSPIRATION_VISUALS_EMPTY"],
    ["unavailable", true, "INSPIRATION_VISUALS_UNAVAILABLE"],
    ["empty", true, "INSPIRATION_VISUALS_UNAVAILABLE"],
  ] as const)("classifies no assets with web %s and library failure %s", async (state, libraryFailure, code) => {
    const web = webHarness();
    vi.mocked(web.webProvider.search).mockRejectedValue(new AppError(state === "empty" ? "INSPIRATION_VISUALS_EMPTY" : "INSPIRATION_VISUALS_UNAVAILABLE", 503, "redacted"));
    if (libraryFailure) web.matchLibrary.mockResolvedValue({ assets: [], warnings: ["INSPIRATION_LIBRARY_MATCH_UNAVAILABLE"] });
    await expect(web.run()).rejects.toMatchObject({ code });
    expect((await getInspirationVisualBoard({ ownerId, analysisId })).refreshJob!.errorCode).toBe(code);
  });

  it("returns stable disabled warnings without paid calls", async () => {
    const web = webHarness();
    vi.mocked(environment.getServerEnv).mockReturnValue({ ...environment.getServerEnv(), INSPIRATION_WEB_VISUALS_ENABLED: false, IMAGE_SEARCH_ENABLED: false });
    await expect(web.run()).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_EMPTY" });
    const board = await getInspirationVisualBoard({ ownerId, analysisId });
    expect(board.refreshAvailable).toBe(false);
    expect(board.refreshJob!.warnings).toEqual(["INSPIRATION_WEB_VISUALS_DISABLED", "INSPIRATION_LIBRARY_MATCH_DISABLED"]);
    expect(web.webProvider.search).not.toHaveBeenCalled();
    expect(web.importWeb).not.toHaveBeenCalled();
    expect(web.matchLibrary).not.toHaveBeenCalled();
  });

  it("replays a web operation without provider, importer or matcher calls", async () => {
    const web = webHarness();
    const operationId = randomUUID();
    const board = await web.run(operationId);
    await expect(web.run(operationId)).resolves.toEqual(board);
    expect(web.webProvider.search).toHaveBeenCalledTimes(1);
    expect(web.importWeb).toHaveBeenCalledTimes(1);
    expect(web.matchLibrary).toHaveBeenCalledTimes(1);
  });

  it.each(["transaction throws", "pending ownership lost"] as const)("compensates every written key when %s", async (failure) => {
    const web = webHarness();
    if (failure === "transaction throws") vi.spyOn(repository, "completeResearchJob").mockRejectedValue(new Error("database failed"));
    else web.matchLibrary.mockImplementation(async () => {
      const [pending] = await db.select().from(inspirationVisualJobs);
      await repository.failPendingJob(ownerId, pending!.id, "INSPIRATION_VISUALS_INTERRUPTED", new Date());
      return { assets: [], warnings: [] };
    });
    await expect(web.run()).rejects.toMatchObject({ code: failure === "transaction throws" ? "INSPIRATION_VISUALS_UNAVAILABLE" : "INSPIRATION_VISUALS_BUSY" });
    expect(web.deleted.flat()).toHaveLength(2);
    expect(web.objects.size).toBe(0);
    expect(await db.select().from(inspirationVisualAssets)).toEqual([]);
  });

  it("compensates normal import results if the shared request aborts before completion", async () => {
    const web = webHarness();
    const controller = new AbortController();
    const imported = deferred();
    const importWeb = web.importWeb;
    vi.mocked(importWeb).mockImplementationOnce(async (input, dependencies) => {
      const result = await importWebEvidence(input, { ...dependencies, store: web.store, fetchImage: async () => ({ bytes: Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0x12,0xff,0x00,0x34,0xff,0xd9]), contentType: "image/jpeg", extension: "jpg", width: 1, height: 1 }) });
      imported.resolve();
      return result;
    });
    web.matchLibrary.mockImplementation(async ({ signal }) => { await imported.promise; expect(signal).toBe(controller.signal); controller.abort(); return { assets: [], warnings: [] }; });
    await expect(web.run(randomUUID(), controller.signal)).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    expect(web.objects.size).toBe(0);
    expect(web.deleted.flat()).toHaveLength(1);
    expect(await db.select().from(inspirationVisualAssets)).toEqual([]);
  });

  it.each([false, true])("deletes superseded keys only after refresh commit, cleanup failure=%s", async (cleanupFails) => {
    const web = webHarness();
    const old = await web.run();
    const oldKeys = [...web.objects.keys()];
    const started = deferred();
    const release = deferred();
    web.matchLibrary.mockImplementation(async () => { started.resolve(); await release.promise; return { assets: [], warnings: [] }; });
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
    } finally { release.resolve(); }
    const next = await refresh;
    expect(next.activeJob!.id).not.toBe(old.activeJob!.id);
    if (!cleanupFails) expect(web.deleted.flat().sort()).toEqual(oldKeys.sort());
  });

  it("preserves old web objects and board after a failed refresh", async () => {
    const web = webHarness();
    const old = await web.run();
    const oldKeys = [...web.objects.keys()];
    vi.mocked(web.webProvider.search).mockRejectedValue(new Error("provider failed"));
    await expect(web.run()).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    const board = await getInspirationVisualBoard({ ownerId, analysisId });
    expect(board.activeJob!.id).toBe(old.activeJob!.id);
    expect(board.webEvidence).toEqual(old.webEvidence);
    expect([...web.objects.keys()]).toEqual(oldKeys);
    expect(web.deleted).toEqual([]);
  });

  it("authorizes only completed owner assets", async () => {
    const web = webHarness();
    const board = await web.run();
    await db.update(inspirationVisualJobs).set({ status: "failed", errorCode: "INSPIRATION_VISUALS_INTERRUPTED" }).where(eq(inspirationVisualJobs.id, board.activeJob!.id));
    expect(await repository.findOwnedCompletedAsset(ownerId, board.webEvidence[0]!.id)).toBeUndefined();
    expect(await repository.listVisibleAssets(ownerId, board.activeJob!.id)).toEqual([]);
  });

  it("rolls back the completed state when asset insertion fails and compensates both objects", async () => {
    const web = webHarness();
    const originalImport = vi.mocked(web.importWeb).getMockImplementation()!;
    vi.mocked(web.importWeb).mockImplementationOnce(async (...args) => {
      const imported = await originalImport(...args);
      // Force a real PostgreSQL unique-key failure after the pending -> completed update.
      imported.assets[1]!.id = imported.assets[0]!.id;
      return imported;
    });
    await expect(web.run()).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    const [failed] = await db.select().from(inspirationVisualJobs);
    expect(failed).toMatchObject({ status: "failed", errorCode: "INSPIRATION_VISUALS_UNAVAILABLE" });
    expect(await db.select().from(inspirationVisualAssets)).toEqual([]);
    expect(web.objects.size).toBe(0);
    expect(web.deleted.flat()).toHaveLength(2);
  });

  it("classifies in-transaction library invalidation as unavailable when web failed", async () => {
    const { patternId } = await seedPattern();
    const web = webHarness();
    vi.mocked(web.webProvider.search).mockRejectedValue(new Error("web failed"));
    web.matchLibrary.mockImplementation(async () => {
      await db.update(patterns).set({ status: "trashed", trashedAt: new Date() }).where(eq(patterns.id, patternId));
      return { assets: [candidate(patternId)], warnings: [] };
    });
    await expect(web.run()).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_UNAVAILABLE" });
    expect((await getInspirationVisualBoard({ ownerId, analysisId })).refreshJob!.errorCode).toBe("INSPIRATION_VISUALS_UNAVAILABLE");
  });

  it("allows one pending winner and pending replay without duplicate web work", async () => {
    const web = webHarness();
    const started = deferred(), release = deferred();
    const search = vi.mocked(web.webProvider.search).getMockImplementation()!;
    vi.mocked(web.webProvider.search).mockImplementation(async (input) => { started.resolve(); await release.promise; return search(input); });
    const operationId = randomUUID();
    const winner = web.run(operationId);
    try {
      await started.promise;
      const replay = await web.run(operationId);
      expect(replay.refreshJob!.status).toBe("pending");
      await expect(web.run()).rejects.toMatchObject({ code: "INSPIRATION_VISUALS_BUSY" });
      expect(web.webProvider.search).toHaveBeenCalledTimes(1);
      expect(web.matchLibrary).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); }
    expect((await winner).webEvidence).toHaveLength(2);
    expect(web.importWeb).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-owner requests before every external branch", async () => {
    const web = webHarness();
    await expect(createResearchVisuals({ ownerId: otherOwnerId, analysisId, operationId: randomUUID() }, web)).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND" });
    expect(web.webProvider.search).not.toHaveBeenCalled();
    expect(web.importWeb).not.toHaveBeenCalled();
    expect(web.matchLibrary).not.toHaveBeenCalled();
  });

});
