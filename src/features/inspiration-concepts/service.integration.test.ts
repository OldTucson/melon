import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
  inspirationAnalyses,
  inspirationVisualAssets,
  inspirationVisualJobs,
  patterns,
  users,
} from "@/lib/db/schema";
import {
  inspirationConceptSets as sets,
  inspirationConceptReferences as references,
  inspirationConceptTasks as tasks,
  inspirationConceptOutputs as outputs,
} from "@/lib/db/schema/inspiration-concepts";
import * as environment from "@/lib/env/server";
import { resetDatabase } from "@/test/database";
import * as visualRepository from "@/features/inspiration-visuals/visual-repository";
import { lockConceptAnalysis } from "./repository";
import { conceptSetDtoSchema } from "./contracts";
import {
  createConceptSet,
  listConceptSets,
  retryConceptDerivative,
  regenerateConceptSet,
  deleteConceptSet,
} from "./service";

const now = new Date("2026-11-02T00:00:00Z");

describe("authenticated concept set lifecycle", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let analysisId: string;
  let otherAnalysisId: string;
  const identity = () => ({ ownerId, analysisId });
  const input = () => ({
    ...identity(),
    operationId: randomUUID(),
    directionIndex: 0,
    visualJobId: null as string | null,
    referenceAssetIds: [] as string[],
  });
  beforeEach(async () => {
    const env = environment.getServerEnv();
    vi.spyOn(environment, "getServerEnv").mockReturnValue({
      ...env,
      INSPIRATION_CONCEPT_IMAGES_ENABLED: true,
    });
    await resetDatabase();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    analysisId = randomUUID();
    otherAnalysisId = randomUUID();
    await db.insert(users).values(
      [ownerId, otherOwnerId].map((id) => ({
        id,
        email: `${id}@test.example`,
        displayName: "Designer",
        passwordHash: "hash",
        mustChangePassword: false,
      })),
    );
    await db.insert(inspirationAnalyses).values(
      [
        { id: analysisId, ownerId },
        { id: otherAnalysisId, ownerId: otherOwnerId },
      ].map((row) => ({
        ...row,
        operationId: randomUUID(),
        prompt: "Report",
        title: "Report",
        status: "completed" as const,
        sources: [inspirationSourceFixture],
        result: inspirationResultFixture,
        searchModel: "qwen-plus",
        structureModel: "qwen3.8-flash",
        completedAt: now,
      })),
    );
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(closeDatabase);

  async function pendingAnalysis() {
    const id = randomUUID();
    await db.insert(inspirationAnalyses).values({
      id,
      ownerId,
      operationId: randomUUID(),
      prompt: "Pending report",
      title: "Pending report",
      status: "pending",
      searchModel: "qwen-plus",
      structureModel: "qwen3.8-flash",
    });
    return id;
  }

  async function research(
    overrides: Partial<typeof inspirationVisualJobs.$inferInsert> = {},
  ) {
    const id = randomUUID();
    await db.insert(inspirationVisualJobs).values({
      id,
      ...identity(),
      operationId: randomUUID(),
      kind: "research_visuals",
      status: "completed",
      completedAt: now,
      createdAt: now,
      ...overrides,
    });
    return id;
  }
  async function evidence(
    jobId: string,
    ordinal = 0,
    overrides: Partial<typeof inspirationVisualAssets.$inferInsert> = {},
  ) {
    const id = randomUUID();
    await db.insert(inspirationVisualAssets).values({
      id,
      ...identity(),
      jobId,
      kind: "web_evidence",
      ordinal,
      title: "External garment",
      altText: "External evidence",
      documentRole: "evidence",
      sourceIndexes: [1],
      sourcePageUrl: "https://example.test/evidence",
      sourceSiteName: "Example",
      sourceQuery: "garment",
      objectKey: `private/${id}.png`,
      contentType: "image/png",
      width: 640,
      height: 480,
      ...overrides,
    });
    return id;
  }
  async function finish(
    setId: string,
    kinds: Array<"sketch" | "effect" | "flat"> = [],
  ) {
    await db
      .update(tasks)
      .set({
        status: "failed",
        errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
        completedAt: now,
        leaseOwner: null,
        leaseUntil: null,
      })
      .where(eq(tasks.setId, setId));
    const [sketchTask] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.setId, setId), eq(tasks.outputKind, "sketch")));
    for (const kind of kinds) {
      let taskId = sketchTask!.id;
      if (kind !== "sketch") {
        taskId = randomUUID();
        await db.insert(tasks).values({
          id: taskId,
          ownerId,
          setId,
          operationId: randomUUID(),
          outputKind: kind,
          attempt: 1,
          status: "failed",
          errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
          completedAt: now,
          availableAt: now,
        });
      }
      await db
        .update(tasks)
        .set({
          status: "completed",
          errorCode: null,
          submitStartedAt: now,
          providerTaskId: `private-provider-${taskId}`,
          providerRequestId: "private-request-id",
          completedAt: now,
        })
        .where(eq(tasks.id, taskId));
      await db.insert(outputs).values({
        id: randomUUID(),
        ...identity(),
        setId,
        sourceTaskId: taskId,
        outputKind: kind,
        title: "Concept",
        altText: "Garment",
        objectKey: `private/${kind}.png`,
        contentType: "image/png",
        width: kind === "flat" ? 2048 : 1536,
        height: kind === "flat" ? 1536 : 2048,
      });
    }
    await db
      .update(sets)
      .set({
        status:
          kinds.length === 3
            ? "completed"
            : kinds.length
              ? "partial"
              : "failed",
        completedAt: now,
      })
      .where(eq(sets.id, setId));
  }

  it("queues one sketch and returns three ordered safe slots with zero references", async () => {
    const created = await createConceptSet(input());
    expect(created).toMatchObject({
      directionIndex: 0,
      version: 1,
      status: "queued",
      completedAt: null,
    });
    expect(created.slots).toEqual([
      {
        kind: "sketch",
        asset: null,
        task: { status: "queued", errorCode: null },
      },
      { kind: "effect", asset: null, task: null },
      { kind: "flat", asset: null, task: null },
    ]);
    expect(conceptSetDtoSchema.safeParse(created).success).toBe(true);
    expect(await db.select().from(tasks)).toHaveLength(1);
  });
  it("rejects disabled creation without inserting rows", async () => {
    vi.mocked(environment.getServerEnv).mockReturnValue({
      ...environment.getServerEnv(),
      INSPIRATION_CONCEPT_IMAGES_ENABLED: false,
    });
    await expect(createConceptSet(input())).rejects.toMatchObject({
      code: "INSPIRATION_CONCEPT_DISABLED",
      status: 503,
    });
    expect(await db.select().from(sets)).toHaveLength(0);
  });
  it("rejects incomplete reports and actual out-of-range directions", async () => {
    await expect(
      createConceptSet({ ...input(), directionIndex: 3 }),
    ).rejects.toMatchObject({ code: "INSPIRATION_INVALID_INPUT", status: 400 });
    await db
      .update(inspirationAnalyses)
      .set({ status: "pending", result: null, completedAt: null })
      .where(eq(inspirationAnalyses.id, analysisId));
    await expect(createConceptSet(input())).rejects.toMatchObject({
      code: "INSPIRATION_BUSY",
      status: 409,
    });
  });
  it("strictly parses mutation and identity inputs before writes", async () => {
    for (const invalid of [
      { ...input(), extra: "secret" },
      { ...input(), ownerId: "invalid" },
      { ...input(), referenceAssetIds: [randomUUID()] },
    ]) {
      await expect(createConceptSet(invalid)).rejects.toMatchObject({
        code: "INSPIRATION_INVALID_INPUT",
        status: 400,
      });
    }
    expect(await db.select().from(sets)).toHaveLength(0);
  });
  it("preserves selected external references in request order", async () => {
    const visualJobId = await research();
    const first = await evidence(visualJobId, 0, {
      documentRole: "product",
      productName: "Shirt",
    });
    const second = await evidence(visualJobId, 1);
    const set = await createConceptSet({
      ...input(),
      visualJobId,
      referenceAssetIds: [second, first],
    });
    const stored = await db
      .select()
      .from(references)
      .where(eq(references.setId, set.id))
      .orderBy(references.ordinal);
    expect(stored.map((row) => row.visualAssetId)).toEqual([second, first]);
  });
  it("rejects stale completed visual jobs", async () => {
    const visualJobId = await research();
    const assetId = await evidence(visualJobId);
    await research({ createdAt: new Date(now.getTime() + 1) });
    await expect(
      createConceptSet({
        ...input(),
        visualJobId,
        referenceAssetIds: [assetId],
      }),
    ).rejects.toMatchObject({
      code: "INSPIRATION_CONCEPT_REFERENCES_STALE",
      status: 409,
    });
  });
  it("rejects other-owner, other-job, and missing external references", async () => {
    const foreignJob = await research({
      ownerId: otherOwnerId,
      analysisId: otherAnalysisId,
    });
    const foreign = await evidence(foreignJob, 0, {
      ownerId: otherOwnerId,
      analysisId: otherAnalysisId,
    });
    const oldJob = await research();
    const oldAsset = await evidence(oldJob);
    const visualJobId = await research({
      createdAt: new Date(now.getTime() + 1),
    });
    for (const id of [foreign, oldAsset, randomUUID()])
      await expect(
        createConceptSet({ ...input(), visualJobId, referenceAssetIds: [id] }),
      ).rejects.toMatchObject({
        code: "INSPIRATION_CONCEPT_REFERENCE_INVALID",
        status: 400,
      });
  });
  it("rejects library and legacy generated assets as external evidence", async () => {
    const visualJobId = await research();
    const patternId = randomUUID();
    await db.insert(patterns).values({
      id: patternId,
      ownerId,
      name: "Library",
      originalFilename: "library.png",
      extension: "png",
      sizeBytes: 1n,
      status: "ready",
    });
    const libraryId = randomUUID();
    const generatedId = randomUUID();
    await db.insert(inspirationVisualAssets).values([
      {
        id: libraryId,
        ...identity(),
        jobId: visualJobId,
        kind: "library_match",
        ordinal: 0,
        title: "Library",
        altText: "Library",
        patternId,
      },
      {
        id: generatedId,
        ...identity(),
        jobId: visualJobId,
        kind: "generated_concept",
        ordinal: 0,
        directionIndex: 0,
        title: "Generated",
        altText: "Generated",
        objectKey: "private/legacy.png",
        contentType: "image/png",
        width: 640,
        height: 480,
      },
    ]);
    for (const id of [libraryId, generatedId])
      await expect(
        createConceptSet({ ...input(), visualJobId, referenceAssetIds: [id] }),
      ).rejects.toMatchObject({
        code: "INSPIRATION_CONCEPT_REFERENCE_INVALID",
        status: 400,
      });
  });
  it("replays identical creation before stale evidence validation", async () => {
    const visualJobId = await research();
    const assetId = await evidence(visualJobId);
    const request = { ...input(), visualJobId, referenceAssetIds: [assetId] };
    const first = await createConceptSet(request);
    await research({ createdAt: new Date(now.getTime() + 1) });
    expect(await createConceptSet(request)).toEqual(first);
    expect(await db.select().from(tasks)).toHaveLength(1);
  });
  it("rejects operation reuse for analysis, direction, visual job, reference order, and mutation kind", async () => {
    const visualJobId = await research();
    const a = await evidence(visualJobId);
    const b = await evidence(visualJobId, 1);
    const request = { ...input(), visualJobId, referenceAssetIds: [a, b] };
    const first = await createConceptSet(request);
    const ownedSecondId = randomUUID();
    const [analysis] = await db
      .select()
      .from(inspirationAnalyses)
      .where(eq(inspirationAnalyses.id, analysisId));
    await db
      .insert(inspirationAnalyses)
      .values({ ...analysis!, id: ownedSecondId, operationId: randomUUID() });
    for (const change of [
      { analysisId: ownedSecondId },
      { directionIndex: 1 },
      { visualJobId: randomUUID() },
      { referenceAssetIds: [b, a] },
    ])
      await expect(
        createConceptSet({ ...request, ...change }),
      ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    await expect(
      regenerateConceptSet({
        ...identity(),
        setId: first.id,
        operationId: request.operationId,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    const empty = { ...input(), directionIndex: 1, visualJobId };
    await createConceptSet(empty);
    await expect(
      createConceptSet({ ...empty, visualJobId: null }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
  });
  it("rejects create operation reuse against another owned pending analysis before checking completion", async () => {
    const request = input();
    await createConceptSet(request);
    const pendingId = await pendingAnalysis();
    await expect(
      createConceptSet({ ...request, analysisId: pendingId }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    expect(await db.select().from(sets)).toHaveLength(1);
    expect(await db.select().from(tasks)).toHaveLength(1);
  });
  it.each(["nonexistent", "wrong-analysis"])(
    "rejects retry operation reuse against a %s set under an owned pending analysis before checking completion",
    async (target) => {
      const source = await createConceptSet(input());
      await finish(source.id, ["sketch"]);
      const request = {
        ...identity(),
        setId: source.id,
        outputKind: "effect" as const,
        operationId: randomUUID(),
      };
      await retryConceptDerivative(request);
      const pendingId = await pendingAnalysis();
      await expect(
        retryConceptDerivative({
          ...request,
          analysisId: pendingId,
          setId: target === "nonexistent" ? randomUUID() : source.id,
        }),
      ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
      expect(await db.select().from(tasks)).toHaveLength(2);
    },
  );
  it.each(["nonexistent", "wrong-analysis"])(
    "returns safe not-found for a new retry against a %s set under an owned pending analysis",
    async (target) => {
      const source = await createConceptSet(input());
      const pendingId = await pendingAnalysis();
      await expect(
        retryConceptDerivative({
          ownerId,
          analysisId: pendingId,
          setId: target === "nonexistent" ? randomUUID() : source.id,
          outputKind: "effect",
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
      expect(await db.select().from(tasks)).toHaveLength(1);
    },
  );
  it("serializes concurrent identical operations into one set and task", async () => {
    const request = input();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => createConceptSet(request)),
    );
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(await db.select().from(sets)).toHaveLength(1);
    expect(await db.select().from(tasks)).toHaveLength(1);
  });
  it("rejects conflicting concurrent targets sharing one operation ID", async () => {
    const request = input();
    const results = await Promise.allSettled([
      createConceptSet(request),
      createConceptSet({ ...request, directionIndex: 1 }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "OPERATION_ID_REUSED", status: 409 },
    });
    expect(await db.select().from(sets)).toHaveLength(1);
  });
  it("allows one active version per direction under concurrent distinct creates", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createConceptSet(input())),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: "INSPIRATION_CONCEPT_BUSY",
          status: 409,
        });
  });
  it("limits retained versions to three, sorts direction/version, and never reuses deleted version numbers", async () => {
    const one = await createConceptSet(input());
    await finish(one.id);
    const two = await createConceptSet(input());
    await finish(two.id);
    const three = await createConceptSet(input());
    await finish(three.id);
    await expect(createConceptSet(input())).rejects.toMatchObject({
      code: "INSPIRATION_CONCEPT_LIMIT_REACHED",
      status: 409,
    });
    await createConceptSet({ ...input(), directionIndex: 1 });
    expect(
      (await listConceptSets(identity())).map(({ directionIndex, version }) => [
        directionIndex,
        version,
      ]),
    ).toEqual([
      [0, 3],
      [0, 2],
      [0, 1],
      [1, 1],
    ]);
    await deleteConceptSet({ ...identity(), setId: two.id });
    expect(await createConceptSet(input())).toMatchObject({ version: 4 });
  });
  it("retries a failed derivative without a current output and replays without another attempt", async () => {
    const set = await createConceptSet(input());
    await finish(set.id, ["sketch", "flat"]);
    const request = {
      ...identity(),
      setId: set.id,
      outputKind: "effect" as const,
      operationId: randomUUID(),
    };
    const retried = await retryConceptDerivative(request);
    expect(retried.slots[1]).toEqual({
      kind: "effect",
      asset: null,
      task: { status: "queued", errorCode: null },
    });
    expect(retried.slots[0].asset).not.toBeNull();
    expect(retried.slots[2].asset).not.toBeNull();
    expect(await retryConceptDerivative(request)).toEqual(retried);
    await expect(
      retryConceptDerivative({ ...request, outputKind: "flat" }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    await expect(
      retryConceptDerivative({ ...request, setId: randomUUID() }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    await expect(
      retryConceptDerivative({ ...request, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_BUSY", status: 409 });
  });
  it("retains all successful outputs during a derivative replacement and hides private task data", async () => {
    const set = await createConceptSet(input());
    await finish(set.id, ["sketch", "effect", "flat"]);
    const before = (await listConceptSets(identity()))[0]!;
    const retried = await retryConceptDerivative({
      ...identity(),
      setId: set.id,
      outputKind: "effect",
      operationId: randomUUID(),
    });
    expect(retried.slots.map(({ asset }) => asset)).toEqual(
      before.slots.map(({ asset }) => asset),
    );
    expect(retried.status).toBe("queued");
    const serialized = JSON.stringify(retried);
    for (const secret of [
      ownerId,
      "objectKey",
      "briefSnapshot",
      "providerTaskId",
      "leaseOwner",
      "private/",
      "model",
      "operationId",
    ])
      expect(serialized).not.toContain(secret);
  });
  it("derives public status from outputs and latest tasks despite stale stored set state", async () => {
    const set = await createConceptSet(input());
    await finish(set.id, ["sketch", "effect", "flat"]);
    await db.update(sets).set({ status: "failed" }).where(eq(sets.id, set.id));
    expect((await listConceptSets(identity()))[0]).toMatchObject({
      status: "completed",
    });
    expect(
      (await listConceptSets(identity()))[0]!.slots.every(
        ({ task }) => task === null,
      ),
    ).toBe(true);
    await retryConceptDerivative({
      ...identity(),
      setId: set.id,
      outputKind: "effect",
      operationId: randomUUID(),
    });
    await db
      .update(tasks)
      .set({ status: "submitting", submitStartedAt: now })
      .where(and(eq(tasks.setId, set.id), eq(tasks.status, "queued")));
    expect((await listConceptSets(identity()))[0]).toMatchObject({
      status: "generating",
    });
  });
  it("rejects sketch retries and derivative retries without a sketch", async () => {
    const set = await createConceptSet(input());
    await finish(set.id);
    await expect(
      retryConceptDerivative({
        ...identity(),
        setId: set.id,
        outputKind: "sketch" as "effect",
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "INSPIRATION_INVALID_INPUT", status: 400 });
    await expect(
      retryConceptDerivative({
        ...identity(),
        setId: set.id,
        outputKind: "effect",
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "INSPIRATION_CONCEPT_REJECTED",
      status: 400,
    });
  });
  it("regenerates copied references as a new version with a fresh frozen brief", async () => {
    const visualJobId = await research();
    const asset = await evidence(visualJobId);
    const first = await createConceptSet({
      ...input(),
      visualJobId,
      referenceAssetIds: [asset],
    });
    await finish(first.id, ["sketch"]);
    await db
      .update(inspirationAnalyses)
      .set({
        result: { ...inspirationResultFixture, headline: "Updated report" },
      })
      .where(eq(inspirationAnalyses.id, analysisId));
    const request = {
      ...identity(),
      setId: first.id,
      operationId: randomUUID(),
    };
    const next = await regenerateConceptSet(request);
    expect(next).toMatchObject({
      version: 2,
      directionIndex: 0,
      status: "queued",
    });
    expect(next.id).not.toBe(first.id);
    const [stored] = await db.select().from(sets).where(eq(sets.id, next.id));
    expect(stored!.briefSnapshot).toMatchObject({
      report: { headline: "Updated report" },
      referenceAssetIds: [asset],
    });
    expect(await regenerateConceptSet(request)).toEqual(next);
    await expect(
      regenerateConceptSet({ ...request, setId: next.id }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
  });
  it("replays regeneration after its source is deleted, while rejecting a different source identity", async () => {
    const source = await createConceptSet(input());
    await finish(source.id, ["sketch"]);
    const request = {
      ...identity(),
      setId: source.id,
      operationId: randomUUID(),
    };
    const next = await regenerateConceptSet(request);
    await deleteConceptSet({ ...identity(), setId: source.id });
    expect(await regenerateConceptSet(request)).toEqual(next);
    await expect(
      regenerateConceptSet({ ...request, setId: randomUUID() }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
  });
  it("soft deletes idempotently, cancels only unclaimed queued tasks, and keeps output rows", async () => {
    const set = await createConceptSet(input());
    await finish(set.id, ["sketch", "flat"]);
    await retryConceptDerivative({
      ...identity(),
      setId: set.id,
      outputKind: "effect",
      operationId: randomUUID(),
    });
    await db.insert(tasks).values({
      id: randomUUID(),
      ownerId,
      setId: set.id,
      operationId: randomUUID(),
      outputKind: "flat",
      attempt: 2,
      status: "submitted",
      submitStartedAt: now,
      providerTaskId: "private-provider-id",
      availableAt: now,
    });
    expect(await deleteConceptSet({ ...identity(), setId: set.id })).toEqual({
      id: set.id,
      deleted: true,
    });
    expect(await deleteConceptSet({ ...identity(), setId: set.id })).toEqual({
      id: set.id,
      deleted: true,
    });
    const [stored] = await db.select().from(sets).where(eq(sets.id, set.id));
    expect(stored).toMatchObject({
      status: "deleting",
      deletedAt: expect.any(Date),
    });
    const remaining = await db
      .select()
      .from(tasks)
      .where(eq(tasks.setId, set.id));
    expect(remaining.find((row) => row.outputKind === "effect")?.status).toBe(
      "failed",
    );
    expect(
      remaining.find((row) => row.outputKind === "flat" && row.attempt === 2)
        ?.status,
    ).toBe("submitted");
    expect(await db.select().from(outputs)).toHaveLength(2);
    expect(await listConceptSets(identity())).toEqual([]);
  });
  it("returns the same not-found error for every cross-owner lifecycle action", async () => {
    const set = await createConceptSet(input());
    const foreign = {
      ownerId: otherOwnerId,
      analysisId,
      setId: set.id,
      operationId: randomUUID(),
    };
    for (const action of [
      () => createConceptSet({ ...input(), ownerId: otherOwnerId }),
      () => listConceptSets({ ownerId: otherOwnerId, analysisId }),
      () => retryConceptDerivative({ ...foreign, outputKind: "effect" }),
      () => regenerateConceptSet(foreign),
      () =>
        deleteConceptSet({ ownerId: otherOwnerId, analysisId, setId: set.id }),
    ])
      await expect(action()).rejects.toMatchObject({
        code: "INSPIRATION_NOT_FOUND",
        status: 404,
      });
  });
  it("does not expose a set under the wrong owned analysis", async () => {
    const set = await createConceptSet(input());
    const secondId = randomUUID();
    const [analysis] = await db
      .select()
      .from(inspirationAnalyses)
      .where(eq(inspirationAnalyses.id, analysisId));
    await db
      .insert(inspirationAnalyses)
      .values({ ...analysis!, id: secondId, operationId: randomUUID() });
    await expect(
      deleteConceptSet({ ...identity(), analysisId: secondId, setId: set.id }),
    ).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
  });

  it("rereads the current research job after waiting for the authoritative analysis lock", async () => {
    const visualJobId = await research();
    const asset = await evidence(visualJobId);
    let unlock!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const refresh = db.transaction(async (tx) => {
      await lockConceptAnalysis(tx, analysisId);
      acquired();
      await release;
      await tx.insert(inspirationVisualJobs).values({
        id: randomUUID(),
        ...identity(),
        operationId: randomUUID(),
        kind: "research_visuals",
        status: "completed",
        createdAt: new Date(now.getTime() + 1),
        completedAt: now,
      });
    });
    await locked;
    const creation = createConceptSet({
      ...input(),
      visualJobId,
      referenceAssetIds: [asset],
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await expect
        .poll(
          async () => {
            const [row] = await db.execute<{ waiting: boolean }>(
              sql`select exists (select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())) as waiting`,
            );
            return row!.waiting;
          },
          { timeout: 2000, interval: 10 },
        )
        .toBe(true);
    } finally {
      unlock();
      await refresh;
    }
    expect(await creation).toMatchObject({
      error: { code: "INSPIRATION_CONCEPT_REFERENCES_STALE", status: 409 },
    });
    expect(await db.select().from(sets)).toHaveLength(0);
  });
  it("rereads every selected asset under the lock instead of trusting the preflight", async () => {
    const visualJobId = await research();
    const asset = await evidence(visualJobId);
    let unlock!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const retirement = db.transaction(async (tx) => {
      await lockConceptAnalysis(tx, analysisId);
      acquired();
      await release;
      await tx
        .delete(inspirationVisualAssets)
        .where(eq(inspirationVisualAssets.id, asset));
    });
    await locked;
    const creation = createConceptSet({
      ...input(),
      visualJobId,
      referenceAssetIds: [asset],
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await expect
        .poll(
          async () => {
            const [row] = await db.execute<{ waiting: boolean }>(
              sql`select exists (select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())) as waiting`,
            );
            return row!.waiting;
          },
          { timeout: 2000, interval: 10 },
        )
        .toBe(true);
    } finally {
      unlock();
      await retirement;
    }
    expect(await creation).toMatchObject({
      error: { code: "INSPIRATION_CONCEPT_REFERENCE_INVALID", status: 400 },
    });
    expect(await db.select().from(sets)).toHaveLength(0);
  });
  it("uses owner-scoped operation identities without sharing results", async () => {
    const request = input();
    const [mine, theirs] = await Promise.all([
      createConceptSet(request),
      createConceptSet({
        ...request,
        ownerId: otherOwnerId,
        analysisId: otherAnalysisId,
      }),
    ]);
    expect(mine.id).not.toBe(theirs.id);
    expect((await listConceptSets(identity())).map(({ id }) => id)).toEqual([
      mine.id,
    ]);
  });
  it("does not exceed three retained versions when concurrent requests compete for the last version", async () => {
    const first = await createConceptSet(input());
    await finish(first.id);
    const second = await createConceptSet(input());
    await finish(second.id);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createConceptSet(input())),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: "INSPIRATION_CONCEPT_LIMIT_REACHED",
          status: 409,
        });
    expect(await db.select().from(sets)).toHaveLength(3);
  });
  it("serializes concurrent derivative replay into one new attempt", async () => {
    const set = await createConceptSet(input());
    await finish(set.id, ["sketch"]);
    const request = {
      ...identity(),
      setId: set.id,
      outputKind: "effect" as const,
      operationId: randomUUID(),
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => retryConceptDerivative(request)),
    );
    expect(new Set(results.map(({ id }) => id))).toEqual(new Set([set.id]));
    const retries = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.setId, set.id), eq(tasks.outputKind, "effect")));
    expect(retries).toHaveLength(1);
  });
  it("preserves output and successful siblings after a failed replacement", async () => {
    const set = await createConceptSet(input());
    await finish(set.id, ["sketch", "effect", "flat"]);
    const before = (await listConceptSets(identity()))[0]!;
    await retryConceptDerivative({
      ...identity(),
      setId: set.id,
      outputKind: "effect",
      operationId: randomUUID(),
    });
    await db
      .update(tasks)
      .set({
        status: "failed",
        errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
        completedAt: now,
      })
      .where(
        and(
          eq(tasks.setId, set.id),
          eq(tasks.outputKind, "effect"),
          eq(tasks.status, "queued"),
        ),
      );
    const after = (await listConceptSets(identity()))[0]!;
    expect(after.status).toBe("completed");
    expect(after.slots.map(({ asset }) => asset)).toEqual(
      before.slots.map(({ asset }) => asset),
    );
    expect(after.slots[1].task).toEqual({
      status: "failed",
      errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
    });
  });
  it("leaves claimed queued tasks untouched during soft deletion", async () => {
    const set = await createConceptSet(input());
    await db
      .update(tasks)
      .set({
        leaseOwner: "worker-private",
        leaseUntil: new Date("2030-01-01T00:00:00Z"),
      })
      .where(eq(tasks.setId, set.id));
    await deleteConceptSet({ ...identity(), setId: set.id });
    const [task] = await db.select().from(tasks).where(eq(tasks.setId, set.id));
    expect(task).toMatchObject({
      status: "queued",
      leaseOwner: "worker-private",
    });
    await expect(
      createConceptSet({
        ...input(),
        operationId: (await db.select().from(sets))[0]!.operationId,
      }),
    ).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
  });
  it("allows reads and deletion while disabling paid mutations", async () => {
    const set = await createConceptSet(input());
    await finish(set.id, ["sketch"]);
    vi.mocked(environment.getServerEnv).mockReturnValue({
      ...environment.getServerEnv(),
      INSPIRATION_CONCEPT_IMAGES_ENABLED: false,
    });
    expect(await listConceptSets(identity())).toHaveLength(1);
    await expect(
      retryConceptDerivative({
        ...identity(),
        setId: set.id,
        outputKind: "effect",
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "INSPIRATION_CONCEPT_DISABLED",
      status: 503,
    });
    await expect(
      regenerateConceptSet({
        ...identity(),
        setId: set.id,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "INSPIRATION_CONCEPT_DISABLED",
      status: 503,
    });
    await expect(
      deleteConceptSet({ ...identity(), setId: set.id }),
    ).resolves.toEqual({ id: set.id, deleted: true });
  });

  it("retains referenced research objects during refresh cleanup, including soft-deleted sets", async () => {
    const job = await research();
    const selected = await evidence(job);
    const unselected = await evidence(job, 1);
    const set = await createConceptSet({
      ...input(),
      visualJobId: job,
      referenceAssetIds: [selected],
    });
    expect(
      await visualRepository.listObjectKeysForAnalysis(ownerId, analysisId),
    ).toEqual([`private/${unselected}.png`]);
    await deleteConceptSet({ ...identity(), setId: set.id });
    expect(
      await visualRepository.listObjectKeysForAnalysis(ownerId, analysisId),
    ).toEqual([`private/${unselected}.png`]);
    await db.delete(sets).where(eq(sets.id, set.id));
    expect(
      (
        await visualRepository.listObjectKeysForAnalysis(ownerId, analysisId)
      ).sort(),
    ).toEqual([`private/${selected}.png`, `private/${unselected}.png`].sort());
  });
});
