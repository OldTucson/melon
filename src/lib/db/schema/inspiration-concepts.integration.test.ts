import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import {
  inspirationAnalyses,
  inspirationVisualJobs,
  inspirationVisualAssets,
  users,
} from "@/lib/db/schema";
import {
  inspirationConceptSets as sets,
  inspirationConceptReferences as references,
  inspirationConceptTasks as tasks,
  inspirationConceptOutputs as outputs,
  inspirationConceptWorkerHeartbeats as heartbeats,
} from "./inspiration-concepts";
import {
  claimDeletingSet,
  claimNextTask,
  createDerivativeRetry,
  createSetAndSketchTask,
  failTask,
  findSetByOperation,
  listSetsForAnalysis,
  lockConceptAnalysis,
  markTaskSubmitting,
  markTaskSubmitted,
  publishTaskOutput,
  recordWorkerHeartbeat,
  rescheduleTask,
} from "@/features/inspiration-concepts/repository";
import type { InspirationConceptBrief } from "@/features/inspiration-concepts/contracts";
import { resetDatabase } from "@/test/database";

const now = new Date("2026-11-02T00:00:00Z");
const leaseUntil = new Date("2026-11-02T00:01:00Z");
const brief = {
  schemaVersion: "inspiration-concept-brief-v1",
  report: { headline: "Test", summary: "Test", marketSignals: [] },
  directionIndex: 0,
  direction: {
    title: "Test",
    direction: "Test direction",
    silhouette: "Relaxed",
    palette: ["green"],
    materials: ["cotton"],
    details: ["seams"],
    sourceIndexes: [],
  },
  referenceAssetIds: [],
  promptTemplateVersion: "inspiration-concept-prompts-v1",
  model: "qwen-image-3.0-pro",
  sizes: { sketch: "1536*2048", effect: "1536*2048", flat: "2048*1536" },
} as InspirationConceptBrief;
function databaseError(
  error: unknown,
): { code?: string; constraint_name?: string } | undefined {
  if (!error || typeof error !== "object") return;
  if ("code" in error && typeof error.code === "string")
    return error as { code: string; constraint_name?: string };
  return "cause" in error ? databaseError(error.cause) : undefined;
}
async function constraint(
  operation: PromiseLike<unknown>,
  code: string,
  name?: string,
) {
  try {
    await operation;
  } catch (error) {
    expect(databaseError(error)).toMatchObject({
      code,
      ...(name ? { constraint_name: name } : {}),
    });
    return;
  }
  throw new Error("Expected PostgreSQL constraint violation");
}

describe("durable concept schema and queue", () => {
  let ownerId: string;
  let otherOwner: string;
  let analysisId: string;
  let otherAnalysis: string;
  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    otherOwner = randomUUID();
    analysisId = randomUUID();
    otherAnalysis = randomUUID();
    await db.insert(users).values(
      [ownerId, otherOwner].map((id) => ({
        id,
        email: `${id}@example.test`,
        displayName: "Designer",
        passwordHash: "hash",
        mustChangePassword: false,
      })),
    );
    await db.insert(inspirationAnalyses).values(
      [
        { id: analysisId, ownerId },
        { id: otherAnalysis, ownerId: otherOwner },
      ].map((identity) => ({
        ...identity,
        operationId: randomUUID(),
        prompt: "Test report",
        title: "Report",
        status: "completed" as const,
        sources: [],
        result: {},
        completedAt: now,
        searchModel: "qwen-plus",
        structureModel: "qwen3.8-flash",
      })),
    );
  });
  afterAll(closeDatabase);
  const setValues = (overrides: Partial<typeof sets.$inferInsert> = {}) => ({
    id: randomUUID(),
    ownerId,
    analysisId,
    operationId: randomUUID(),
    directionIndex: 0,
    version: 1,
    status: "queued" as const,
    briefSnapshot: brief,
    model: brief.model,
    promptTemplateVersion: brief.promptTemplateVersion,
    ...overrides,
  });
  const insertSet = async (overrides: Partial<typeof sets.$inferInsert> = {}) =>
    (await db.insert(sets).values(setValues(overrides)).returning())[0]!;
  const taskValues = (
    setId: string,
    overrides: Partial<typeof tasks.$inferInsert> = {},
  ) => ({
    id: randomUUID(),
    ownerId,
    setId,
    operationId: randomUUID(),
    outputKind: "sketch" as const,
    attempt: 1,
    status: "queued" as const,
    availableAt: now,
    ...overrides,
  });
  const create = (
    overrides: Partial<Parameters<typeof createSetAndSketchTask>[0]> = {},
  ) =>
    createSetAndSketchTask({
      ownerId,
      analysisId,
      operationId: randomUUID(),
      directionIndex: 0,
      briefSnapshot: brief,
      referenceAssetIds: [],
      visualJobId: null,
      now,
      ...overrides,
    });
  const lease = (
    taskId: string,
    overrides: Partial<Parameters<typeof markTaskSubmitting>[0]> = {},
  ) => ({ taskId, workerId: "worker-a", now, leaseUntil, ...overrides });
  const png = (
    kind: "sketch" | "effect" | "flat" = "sketch",
    key = "concept.png",
  ) => ({
    id: randomUUID(),
    title: "Concept",
    altText: "A garment",
    objectKey: key,
    contentType: "image/png" as const,
    width: kind === "flat" ? 2048 : 1536,
    height: kind === "flat" ? 1536 : 2048,
  });
  async function submitted(taskId: string) {
    await db
      .update(tasks)
      .set({ leaseOwner: "worker-a", leaseUntil })
      .where(eq(tasks.id, taskId));
    expect(await markTaskSubmitting(lease(taskId))).toMatchObject({
      status: "submitting",
    });
    expect(
      await markTaskSubmitted({
        ...lease(taskId),
        providerTaskId: "provider-task",
        providerRequestId: "request",
      }),
    ).toMatchObject({ status: "submitted" });
    await db
      .update(tasks)
      .set({ leaseOwner: "worker-a", leaseUntil })
      .where(eq(tasks.id, taskId));
  }

  it("rejects cross-owner analysis and preserves valid analyses", async () => {
    await constraint(
      db.insert(sets).values(setValues({ analysisId: otherAnalysis })),
      "23503",
      "inspiration_concept_sets_owner_analysis_fk",
    );
    await insertSet();
    expect(await db.select().from(inspirationAnalyses)).toHaveLength(2);
  });
  it.each([
    [{ directionIndex: 5 }, "direction"],
    [{ version: 0 }, "version"],
    [{ briefSnapshot: [] }, "brief"],
    [{ status: "completed" }, "state"],
    [{ status: "failed" }, "state"],
    [{ deletedAt: now }, "deletion"],
    [{ deletionLeaseOwner: "worker" }, "deletion_lease"],
    [{ deletionLeaseUntil: leaseUntil }, "deletion_lease"],
    [
      { deletionLeaseOwner: "worker", deletionLeaseUntil: leaseUntil },
      "deletion_lease",
    ],
    [
      {
        status: "deleting",
        deletedAt: now,
        deletionLeaseOwner: "x".repeat(201),
        deletionLeaseUntil: leaseUntil,
      },
      "deletion_lease",
    ],
  ])("rejects invalid set state %j", async (values, name) => {
    await constraint(
      db
        .insert(sets)
        .values(setValues(values as Partial<typeof sets.$inferInsert>)),
      "23514",
      `inspiration_concept_sets_${name}_check`,
    );
  });
  it("enforces active direction and immutable version identities", async () => {
    await insertSet();
    await constraint(
      db.insert(sets).values(setValues({ version: 2 })),
      "23505",
      "inspiration_concept_sets_active_direction_unique",
    );
    await constraint(
      db
        .insert(sets)
        .values(setValues({ status: "completed", completedAt: now })),
      "23505",
      "inspiration_concept_sets_analysis_direction_version_unique",
    );
  });
  it("serializes empty-direction allocation and replays owner operations", async () => {
    const operationId = randomUUID();
    const results = await Promise.allSettled([
      create({ operationId }),
      create(),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "INSPIRATION_CONCEPT_BUSY" },
    });
    const rows = await listSetsForAnalysis({ ownerId, analysisId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
    expect(
      await listSetsForAnalysis({ ownerId: otherOwner, analysisId }),
    ).toEqual([]);
    const existing = rows[0]!;
    expect((await create({ operationId: existing.operationId })).set.id).toBe(
      existing.id,
    );
    expect(
      (await findSetByOperation({ ownerId, operationId: existing.operationId }))
        ?.id,
    ).toBe(existing.id);
    expect(
      await findSetByOperation({
        ownerId: otherOwner,
        operationId: existing.operationId,
      }),
    ).toBeUndefined();
  });
  it("rejects a fourth retained set and keeps versions monotonic after deletion", async () => {
    for (const version of [1, 2, 3])
      await insertSet({ version, status: "completed", completedAt: now });
    await expect(create()).rejects.toMatchObject({
      code: "INSPIRATION_CONCEPT_LIMIT_REACHED",
    });
    await db
      .update(sets)
      .set({ status: "deleting", deletedAt: now })
      .where(eq(sets.version, 1));
    expect((await create()).set.version).toBe(4);
  });
  it("uses a validated analysis-wide transaction lock", async () => {
    await expect(
      db.transaction((tx) => lockConceptAnalysis(tx, "invalid")),
    ).rejects.toThrow();
    const first = await create();
    await db
      .update(sets)
      .set({ status: "failed", completedAt: now })
      .where(eq(sets.id, first.set.id));
    expect((await create()).set.version).toBe(2);
  });

  async function webAsset(owner = ownerId, analysis = analysisId) {
    const jobId = randomUUID();
    const id = randomUUID();
    await db.insert(inspirationVisualJobs).values({
      id: jobId,
      ownerId: owner,
      analysisId: analysis,
      operationId: randomUUID(),
      kind: "research_visuals",
      status: "completed",
      completedAt: now,
    });
    await db.insert(inspirationVisualAssets).values({
      id,
      ownerId: owner,
      analysisId: analysis,
      jobId,
      kind: "web_evidence",
      ordinal: 0,
      title: "Evidence",
      altText: "Evidence",
      sourcePageUrl: "https://example.test",
      sourceSiteName: "Example",
      sourceQuery: "test",
      documentRole: "evidence",
      sourceIndexes: [],
      objectKey: "evidence.webp",
      contentType: "image/webp",
      width: 100,
      height: 100,
    });
    return id;
  }
  it("pins ordered evidence with owner/analysis composite references and restricts deletion", async () => {
    const visualAssetId = await webAsset();
    const foreignAsset = await webAsset(otherOwner, otherAnalysis);
    const [asset] = await db
      .select()
      .from(inspirationVisualAssets)
      .where(eq(inspirationVisualAssets.id, visualAssetId));
    const { set } = await create({
      referenceAssetIds: [visualAssetId],
      visualJobId: asset!.jobId,
    });
    expect(await db.select().from(references)).toMatchObject([
      { setId: set.id, visualAssetId, ordinal: 0 },
    ]);
    await constraint(
      db.insert(references).values({
        ownerId,
        analysisId,
        setId: set.id,
        visualAssetId: foreignAsset,
        ordinal: 1,
      }),
      "23503",
      "inspiration_concept_references_owner_analysis_asset_fk",
    );
    await constraint(
      db.insert(references).values({
        ownerId: otherOwner,
        analysisId: otherAnalysis,
        setId: set.id,
        visualAssetId: foreignAsset,
        ordinal: 1,
      }),
      "23503",
      "inspiration_concept_references_owner_analysis_set_fk",
    );
    await constraint(
      db.insert(references).values({
        ownerId,
        analysisId,
        setId: set.id,
        visualAssetId,
        ordinal: 3,
      }),
      "23514",
      "inspiration_concept_references_ordinal_check",
    );
    await constraint(
      db
        .delete(inspirationVisualAssets)
        .where(eq(inspirationVisualAssets.id, visualAssetId)),
      "23503",
    );
    await db.delete(sets).where(eq(sets.id, set.id));
    await db
      .delete(inspirationVisualAssets)
      .where(eq(inspirationVisualAssets.id, visualAssetId));
    expect(await db.select().from(references)).toEqual([]);
  });
  it("rejects stale research jobs and assets belonging to a different job under the analysis lock", async () => {
    const oldId = await webAsset();
    const old = (
      await db
        .select()
        .from(inspirationVisualAssets)
        .where(eq(inspirationVisualAssets.id, oldId))
    )[0]!;
    await db
      .update(inspirationVisualJobs)
      .set({ createdAt: new Date("2026-10-30T00:00:00Z") })
      .where(eq(inspirationVisualJobs.id, old.jobId));
    const currentId = await webAsset();
    const current = (
      await db
        .select()
        .from(inspirationVisualAssets)
        .where(eq(inspirationVisualAssets.id, currentId))
    )[0]!;
    await expect(
      create({ visualJobId: old.jobId, referenceAssetIds: [oldId] }),
    ).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_REFERENCES_STALE" });
    await expect(
      create({ visualJobId: current.jobId, referenceAssetIds: [oldId] }),
    ).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_REFERENCE_INVALID" });
    await expect(
      create({ referenceAssetIds: [currentId], visualJobId: null }),
    ).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_REFERENCES_STALE" });
    expect(await db.select().from(sets)).toEqual([]);
    expect(
      (
        await create({
          visualJobId: current.jobId,
          referenceAssetIds: [currentId],
        })
      ).set.id,
    ).toBeDefined();
  });
  it("serializes refresh completion with create and rereads the winning research job", async () => {
    const oldId = await webAsset();
    const old = (
      await db
        .select()
        .from(inspirationVisualAssets)
        .where(eq(inspirationVisualAssets.id, oldId))
    )[0]!;
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
        ownerId,
        analysisId,
        operationId: randomUUID(),
        kind: "research_visuals",
        status: "completed",
        createdAt: new Date("2030-01-01T00:00:00Z"),
        completedAt: now,
      });
    });
    await locked;
    const creation = create({
      visualJobId: old.jobId,
      referenceAssetIds: [oldId],
    });
    try {
      await expect
        .poll(
          async () => {
            const [row] = await db.execute<{
              waiting: boolean;
            }>(sql`select exists (
          select 1 from pg_locks where locktype = 'advisory' and not granted
          and database = (select oid from pg_database where datname = current_database())
        ) as waiting`);
            return row!.waiting;
          },
          { timeout: 2000, interval: 10 },
        )
        .toBe(true);
    } finally {
      unlock();
      await refresh;
    }
    await expect(creation).rejects.toMatchObject({
      code: "INSPIRATION_CONCEPT_REFERENCES_STALE",
    });
  });
  it("rejects duplicate reference ordinals and assets", async () => {
    const set = await insertSet();
    const a = await webAsset();
    const b = await webAsset();
    const value = {
      ownerId,
      analysisId,
      setId: set.id,
      visualAssetId: a,
      ordinal: 0,
    };
    await db.insert(references).values(value);
    await constraint(
      db.insert(references).values({ ...value, visualAssetId: b }),
      "23505",
    );
    await constraint(
      db.insert(references).values({ ...value, ordinal: 1 }),
      "23505",
      "inspiration_concept_references_set_asset_unique",
    );
  });
  it("rolls back set and sketch when a reference fails", async () => {
    await expect(
      create({ referenceAssetIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_REFERENCES_STALE" });
    expect(await db.select().from(sets)).toEqual([]);
    expect(await db.select().from(tasks)).toEqual([]);
  });
  it("enforces task attempt, operation, active-slot and tenant identities", async () => {
    const set = await insertSet();
    const value = taskValues(set.id);
    await db.insert(tasks).values(value);
    await constraint(
      db.insert(tasks).values({ ...value, id: randomUUID() }),
      "23505",
    );
    await constraint(
      db.insert(tasks).values(taskValues(set.id, { attempt: 2 })),
      "23505",
      "inspiration_concept_tasks_active_slot_unique",
    );
    await constraint(
      db.insert(tasks).values(
        taskValues(set.id, {
          status: "failed",
          errorCode: "INSPIRATION_CONCEPT_REJECTED",
          completedAt: now,
        }),
      ),
      "23505",
      "inspiration_concept_tasks_set_kind_attempt_unique",
    );
    await constraint(
      db
        .insert(tasks)
        .values(
          taskValues(set.id, { ownerId: otherOwner, outputKind: "flat" }),
        ),
      "23503",
      "inspiration_concept_tasks_owner_set_fk",
    );
    await constraint(
      db
        .insert(tasks)
        .values(taskValues(set.id, { outputKind: "wrong" as "flat" })),
      "22P02",
    );
  });
  it.each([
    [{ attempt: 0 }, "attempt"],
    [{ status: "completed" }, "state"],
    [{ status: "failed", completedAt: now }, "state"],
    [{ status: "submitted" }, "state"],
    [{ status: "submitting" }, "state"],
    [{ leaseOwner: "worker" }, "lease"],
    [{ leaseUntil }, "lease"],
    [{ providerTaskId: "x".repeat(501) }, "metadata_length"],
  ])("rejects invalid task state %j", async (values, name) => {
    const set = await insertSet();
    await constraint(
      db
        .insert(tasks)
        .values(
          taskValues(set.id, values as Partial<typeof tasks.$inferInsert>),
        ),
      "23514",
      `inspiration_concept_tasks_${name}_check`,
    );
  });
  it("claims a due task once under concurrent workers and recovers expired safe leases", async () => {
    const { task } = await create();
    const claims = await Promise.all([
      claimNextTask({ workerId: "worker-a", now, leaseUntil }),
      claimNextTask({ workerId: "worker-b", now, leaseUntil }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.id).toBe(task.id);
    expect(
      await claimNextTask({ workerId: "worker-c", now, leaseUntil }),
    ).toBeUndefined();
    const later = new Date("2026-11-02T00:02:00Z");
    expect(
      await claimNextTask({
        workerId: "worker-c",
        now: later,
        leaseUntil: new Date("2026-11-02T00:03:00Z"),
      }),
    ).toMatchObject({ id: task.id, leaseOwner: "worker-c" });
    expect(await markTaskSubmitting(lease(task.id))).toBeUndefined();
  });
  it("excludes future tasks, ambiguous submitting tasks, and deleted sets from claims", async () => {
    const { set, task } = await create();
    await db
      .update(tasks)
      .set({ availableAt: leaseUntil })
      .where(eq(tasks.id, task.id));
    expect(
      await claimNextTask({ workerId: "worker-a", now, leaseUntil }),
    ).toBeUndefined();
    await db
      .update(tasks)
      .set({ availableAt: now, status: "submitting", submitStartedAt: now })
      .where(eq(tasks.id, task.id));
    expect(
      await claimNextTask({
        workerId: "worker-a",
        now: leaseUntil,
        leaseUntil: new Date(leaseUntil.getTime() + 60000),
      }),
    ).toBeUndefined();
    await db
      .update(tasks)
      .set({ status: "queued", submitStartedAt: null })
      .where(eq(tasks.id, task.id));
    await db
      .update(sets)
      .set({ status: "deleting", deletedAt: now })
      .where(eq(sets.id, set.id));
    expect(
      await claimNextTask({ workerId: "worker-a", now, leaseUntil }),
    ).toBeUndefined();
  });
  it("compares lease ownership on transitions and reschedules persisted provider tasks", async () => {
    const { task } = await create();
    await submitted(task.id);
    expect(
      await rescheduleTask({
        ...lease(task.id),
        workerId: "wrong",
        availableAt: leaseUntil,
      }),
    ).toBeUndefined();
    expect(
      await rescheduleTask({ ...lease(task.id), availableAt: leaseUntil }),
    ).toMatchObject({
      status: "submitted",
      providerTaskId: "provider-task",
      leaseOwner: null,
      leaseUntil: null,
    });
    expect(
      await claimNextTask({ workerId: "worker-b", now, leaseUntil }),
    ).toBeUndefined();
    expect(
      await claimNextTask({
        workerId: "worker-b",
        now: leaseUntil,
        leaseUntil: new Date(leaseUntil.getTime() + 60000),
      }),
    ).toMatchObject({ id: task.id, status: "submitted" });
  });
  it("publishes sketch and enqueues exactly two derivatives atomically", async () => {
    const { set, task } = await create();
    await submitted(task.id);
    const result = await publishTaskOutput({
      ...lease(task.id),
      output: png(),
    });
    expect(result).toMatchObject({
      supersededObjectKey: null,
      output: { outputKind: "sketch" },
      set: { status: "generating" },
    });
    expect(
      await db.select().from(tasks).where(eq(tasks.setId, set.id)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputKind: "sketch",
          status: "completed",
          leaseOwner: null,
        }),
        expect.objectContaining({
          outputKind: "effect",
          status: "queued",
          attempt: 1,
        }),
        expect.objectContaining({
          outputKind: "flat",
          status: "queued",
          attempt: 1,
        }),
      ]),
    );
    expect(await db.select().from(tasks)).toHaveLength(3);
    expect(
      await publishTaskOutput({ ...lease(task.id), output: png() }),
    ).toBeUndefined();
    expect(await db.select().from(tasks)).toHaveLength(3);
  });
  it("rejects a publication after its lease expires or its set is deleted", async () => {
    const { set, task } = await create();
    await submitted(task.id);
    expect(
      await publishTaskOutput({
        ...lease(task.id),
        now: leaseUntil,
        output: png(),
      }),
    ).toBeUndefined();
    await db
      .update(sets)
      .set({ status: "deleting", deletedAt: now })
      .where(eq(sets.id, set.id));
    expect(
      await publishTaskOutput({ ...lease(task.id), output: png() }),
    ).toBeUndefined();
    expect(await db.select().from(outputs)).toEqual([]);
  });
  it("fails sketch terminally and derives a failed set without derivative tasks", async () => {
    const { set, task } = await create();
    await claimNextTask({ workerId: "worker-a", now, leaseUntil });
    expect(
      await failTask({
        ...lease(task.id),
        errorCode: "INSPIRATION_CONCEPT_REJECTED",
      }),
    ).toMatchObject({ status: "failed", leaseOwner: null, completedAt: now });
    expect(
      (await listSetsForAnalysis({ ownerId, analysisId }))[0],
    ).toMatchObject({ id: set.id, status: "failed", completedAt: now });
    expect(await db.select().from(tasks)).toHaveLength(1);
  });
  it("replaces only a published derivative, retains old output during retry, and derives partial/completed", async () => {
    const { set } = await create();
    const sketch = (await db.select().from(tasks))[0]!;
    await submitted(sketch.id);
    await publishTaskOutput({ ...lease(sketch.id), output: png() });
    for (const kind of ["effect", "flat"] as const) {
      const task = (
        await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.setId, set.id), eq(tasks.outputKind, kind)))
      )[0]!;
      await submitted(task.id);
      await publishTaskOutput({
        ...lease(task.id),
        output: png(kind, `${kind}.png`),
      });
    }
    expect(
      (await listSetsForAnalysis({ ownerId, analysisId }))[0]!.status,
    ).toBe("completed");
    const operationId = randomUUID();
    const retry = await createDerivativeRetry({
      ownerId,
      setId: set.id,
      outputKind: "effect",
      operationId,
      now,
    });
    expect(retry).toMatchObject({
      outputKind: "effect",
      attempt: 2,
      status: "queued",
    });
    expect(
      (
        await createDerivativeRetry({
          ownerId,
          setId: set.id,
          outputKind: "effect",
          operationId,
          now,
        })
      ).id,
    ).toBe(retry.id);
    await expect(
      createDerivativeRetry({
        ownerId,
        setId: set.id,
        outputKind: "effect",
        operationId: randomUUID(),
        now,
      }),
    ).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_BUSY" });
    expect(
      (
        await db.select().from(outputs).where(eq(outputs.outputKind, "effect"))
      )[0]!.objectKey,
    ).toBe("effect.png");
    await submitted(retry.id);
    expect(
      await publishTaskOutput({
        ...lease(retry.id),
        output: png("effect", "replacement.png"),
      }),
    ).toMatchObject({
      supersededObjectKey: "effect.png",
      set: { status: "completed" },
    });
    expect(await db.select().from(outputs)).toHaveLength(3);
    const flatRetry = await createDerivativeRetry({
      ownerId,
      setId: set.id,
      outputKind: "flat",
      operationId: randomUUID(),
      now,
    });
    await claimNextTask({ workerId: "worker-a", now, leaseUntil });
    await failTask({
      ...lease(flatRetry.id),
      errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
    });
    expect(
      (await listSetsForAnalysis({ ownerId, analysisId }))[0]!.status,
    ).toBe("completed");
  });
  it("derives partial only when all outstanding derivatives terminate", async () => {
    const { set, task } = await create();
    await submitted(task.id);
    await publishTaskOutput({ ...lease(task.id), output: png() });
    for (const task of await db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "queued"))) {
      await db
        .update(tasks)
        .set({ leaseOwner: "worker-a", leaseUntil })
        .where(eq(tasks.id, task.id));
      await failTask({
        ...lease(task.id),
        errorCode: "INSPIRATION_CONCEPT_REJECTED",
      });
    }
    expect(
      (await listSetsForAnalysis({ ownerId, analysisId }))[0],
    ).toMatchObject({ id: set.id, status: "partial", completedAt: now });
  });
  it("enforces output tenant/source keys, PNG metadata, exact dimensions and unique slots", async () => {
    const { set, task } = await create();
    const value = {
      ...png(),
      ownerId,
      analysisId,
      setId: set.id,
      sourceTaskId: task.id,
      outputKind: "sketch" as const,
    };
    for (const invalid of [
      { ownerId: otherOwner },
      { analysisId: otherAnalysis },
      { sourceTaskId: randomUUID() },
    ])
      await constraint(
        db.insert(outputs).values({ ...value, ...invalid }),
        "23503",
      );
    for (const invalid of [
      { title: " " },
      { altText: "x".repeat(501) },
      { objectKey: "" },
      { contentType: "image/webp" },
      { width: 2048 },
      { outputKind: "flat" as const },
    ])
      await constraint(
        db.insert(outputs).values({ ...value, ...invalid }),
        "23514",
      );
    await db.insert(outputs).values(value);
    await constraint(
      db.insert(outputs).values({ ...value, id: randomUUID() }),
      "23505",
      "inspiration_concept_outputs_set_kind_unique",
    );
    const otherSet = await insertSet({ directionIndex: 1 });
    await constraint(
      db
        .insert(outputs)
        .values({ ...value, id: randomUUID(), setId: otherSet.id }),
      "23503",
      "inspiration_concept_outputs_owner_set_task_fk",
    );
  });
  it("claims deleting sets exclusively and permits recovery after lease expiry", async () => {
    const { set } = await create();
    expect(await claimDeletingSet("worker-a", now, leaseUntil)).toBeUndefined();
    await db
      .update(sets)
      .set({ status: "deleting", deletedAt: now })
      .where(eq(sets.id, set.id));
    const claims = await Promise.all([
      claimDeletingSet("worker-a", now, leaseUntil),
      claimDeletingSet("worker-b", now, leaseUntil),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.id).toBe(set.id);
    expect(await claimDeletingSet("worker-c", now, leaseUntil)).toBeUndefined();
    expect(
      await claimDeletingSet(
        "worker-c",
        new Date("2026-11-02T00:02:00Z"),
        new Date("2026-11-02T00:03:00Z"),
      ),
    ).toMatchObject({ id: set.id, deletionLeaseOwner: "worker-c" });
  });
  it("upserts heartbeat without rewriting worker start time", async () => {
    await recordWorkerHeartbeat({ workerId: "worker-a", startedAt: now, now });
    await recordWorkerHeartbeat({
      workerId: "worker-a",
      startedAt: leaseUntil,
      now: leaseUntil,
    });
    expect(await db.select().from(heartbeats)).toMatchObject([
      { workerId: "worker-a", startedAt: now, updatedAt: leaseUntil },
    ]);
  });
  it("resets worker heartbeats together with all durable concept state", async () => {
    await create();
    await recordWorkerHeartbeat({
      workerId: "worker-reset",
      startedAt: now,
      now,
    });
    await resetDatabase();
    expect(await db.select().from(heartbeats)).toEqual([]);
    expect(await db.select().from(sets)).toEqual([]);
    expect(await db.select().from(tasks)).toEqual([]);
  });
  it("registers an additive generated migration with composite keys and queue constraints", async () => {
    const journal = JSON.parse(
      await readFile("drizzle/meta/_journal.json", "utf8"),
    ) as { entries: { tag: string }[] };
    expect(
      journal.entries.some(
        (e) => e.tag === "0012_melon_inspiration_concept_sets",
      ),
    ).toBe(true);
    const migration = await readFile(
      "drizzle/0012_melon_inspiration_concept_sets.sql",
      "utf8",
    );
    expect(migration).toContain(
      'FOREIGN KEY ("owner_id","analysis_id","visual_asset_id")',
    );
    expect(migration).toContain("inspiration_concept_tasks_state_check");
    expect(migration).toContain(
      "inspiration_concept_sets_active_direction_unique",
    );
    expect(migration).toContain("jsonb_typeof(");
    expect(migration).not.toMatch(
      /(?:DROP|TRUNCATE|DELETE FROM|UPDATE)\s+"?(?:inspiration_visual|inspiration_analyses)/i,
    );
  });
});
