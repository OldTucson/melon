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
      warnings: ["INSPIRATION_WEB_VISUALS_UNAVAILABLE"],
    });
    expect(board.refreshJob).toBeNull();
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
      warnings: ["INSPIRATION_LIBRARY_MATCH_EMPTY"],
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
});
