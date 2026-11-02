import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, closeDatabase } from "@/lib/db/client";
import {
  users,
  inspirationAnalyses,
  inspirationVisualAssets,
  inspirationVisualJobs,
} from "@/lib/db/schema";
import {
  inspirationConceptSets as sets,
  inspirationConceptTasks as tasks,
  inspirationConceptOutputs as outputs,
  inspirationConceptWorkerHeartbeats as heartbeats,
} from "@/lib/db/schema/inspiration-concepts";
import { resetDatabase } from "@/test/database";
import {
  inspirationResultFixture,
  inspirationSourceFixture,
} from "@/features/inspiration/test-fixtures";
import type { ImageRequestFactory } from "@/features/inspiration-visuals/safe-image-fetch";
import { conceptBriefFixture } from "./test-fixtures";
import { conceptSetObjectPrefix, parseConceptObjectKey } from "./object-keys";
import {
  createSetAndSketchTask,
  createDerivativeRetry,
  markTaskSubmitting,
  claimNextTask,
  softDeleteSet,
} from "./repository";
import {
  QwenImageSubmissionError,
  type QwenImageProvider,
} from "./qwen-image-provider";
import type { ConceptObjectStore } from "./object-store";
import {
  advanceConceptWorkerOnce,
  runConceptWorker,
  type WorkerDependencies,
} from "./worker";

describe("durable concept worker", () => {
  let ownerId: string;
  let analysisId: string;
  let now: Date;
  let deps: WorkerDependencies;
  let objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  let provider: QwenImageProvider;
  let writes: string[];
  let afterPut: (() => Promise<void>) | undefined;
  let deleteFails: boolean;
  let png: Buffer;
  let flatPng: Buffer;
  const submissions: Parameters<QwenImageProvider["createTask"]>[0][] = [];
  const queries: string[] = [];
  const events: unknown[] = [];
  const rows = () =>
    db.select().from(tasks).orderBy(tasks.outputKind, tasks.attempt);
  async function create(
    refs: string[] = [],
    visualJobId: string | null = null,
  ) {
    return createSetAndSketchTask({
      ownerId,
      analysisId,
      operationId: randomUUID(),
      directionIndex: 0,
      briefSnapshot: { ...conceptBriefFixture, referenceAssetIds: refs },
      referenceAssetIds: refs,
      visualJobId,
      now,
    });
  }
  async function step() {
    return advanceConceptWorkerOnce(deps);
  }
  async function ready() {
    now = new Date(now.getTime() + 60_000);
  }
  async function completeSketch() {
    const result = await create();
    await step();
    await ready();
    await step();
    return result;
  }
  async function completeAll() {
    const result = await completeSketch();
    await step();
    await step();
    await ready();
    await step();
    await step();
    return result;
  }
  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    analysisId = randomUUID();
    now = new Date("2026-11-02T00:00:00Z");
    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@test.example`,
      displayName: "Worker test",
      passwordHash: "hash",
    });
    await db.insert(inspirationAnalyses).values({
      id: analysisId,
      ownerId,
      operationId: randomUUID(),
      prompt: "Report",
      title: "Report",
      status: "completed",
      sources: [inspirationSourceFixture],
      result: inspirationResultFixture,
      searchModel: "qwen-plus",
      structureModel: "qwen3.8-flash",
      completedAt: now,
    });
    png = await sharp({
      create: { width: 1536, height: 2048, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    flatPng = await sharp({
      create: { width: 2048, height: 1536, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    objects = new Map();
    writes = [];
    afterPut = undefined;
    deleteFails = false;
    submissions.length = 0;
    queries.length = 0;
    events.length = 0;
    const store: ConceptObjectStore = {
      async put({ key, bytes, contentType }) {
        parseConceptObjectKey(key);
        objects.set(key, { bytes, contentType });
        writes.push(key);
        await afterPut?.();
      },
      async get(key) {
        parseConceptObjectKey(key);
        const value = objects.get(key);
        if (!value) throw Error("private key");
        return value;
      },
      async delete(keys) {
        if (deleteFails) throw Error("credentials secret key");
        keys.forEach((key) => {
          parseConceptObjectKey(key);
          objects.delete(key);
        });
      },
      async listObjectKeys(prefix) {
        return [...objects.keys()].filter((key) => key.startsWith(prefix));
      },
    };
    provider = {
      async createTask(input) {
        submissions.push(input);
        return {
          taskId: `provider-${input.kind}-${submissions.length}`,
          requestId: "private-request",
        };
      },
      async queryTask({ taskId }) {
        queries.push(taskId);
        return {
          state: "succeeded",
          taskId,
          requestId: "private-request",
          temporaryImageUrl: `https://results.example/${taskId}.png?secret=1`,
        };
      },
    };
    const request: ImageRequestFactory = (options, onResponse) => {
      const bytes = String(options.path).includes("flat") ? flatPng : png;
      return Object.assign(new EventEmitter(), {
        destroy() {},
        end() {
          queueMicrotask(() => {
            const headers = {
              "content-type": "image/png",
              "content-length": String(bytes.length),
            };
            const response = Object.assign(new PassThrough(), {
              statusCode: 200,
              headers,
              rawHeaders: Object.entries(headers).flat(),
              complete: true,
            });
            onResponse(response as unknown as IncomingMessage);
            response.end(bytes);
          });
        },
      }) as unknown as ClientRequest;
    };
    deps = {
      workerId: "worker-a",
      provider,
      store,
      researchStore: {
        async get(key) {
          const value = objects.get(key);
          if (!value) throw Error("missing reference");
          return value;
        },
      },
      now: () => now,
      random: () => 0.5,
      log: (event) => events.push(event),
      remote: {
        request,
        resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    };
  });
  afterAll(closeDatabase);

  it("commits submission before provider I/O and permits only one concurrent claim", async () => {
    const { task } = await create();
    const original = provider.createTask;
    provider.createTask = async (input) => {
      expect((await rows())[0]).toMatchObject({
        status: "submitting",
        leaseOwner: expect.any(String),
      });
      return original(input);
    };
    const result = await Promise.all([
      step(),
      advanceConceptWorkerOnce({ ...deps, workerId: "worker-b" }),
    ]);
    expect(result.filter((r) => r.state === "advanced")).toHaveLength(1);
    expect(submissions).toHaveLength(1);
    expect(await rows()).toMatchObject([
      {
        id: task.id,
        status: "submitted",
        leaseOwner: null,
        providerTaskId: "provider-sketch-1",
      },
    ]);
  });
  it.each([
    [new QwenImageSubmissionError(true), "INSPIRATION_CONCEPT_UNAVAILABLE"],
    [new QwenImageSubmissionError(true, true), "INSPIRATION_CONCEPT_REJECTED"],
    [
      new QwenImageSubmissionError(false),
      "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
    ],
    [
      new Error("timeout with private provider URL"),
      "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
    ],
  ])(
    "classifies create failure without automatic resubmission: %s",
    async (error, errorCode) => {
      await create();
      provider.createTask = async (input) => {
        submissions.push(input);
        throw error;
      };
      await step();
      await ready();
      await step();
      expect(await rows()).toMatchObject([{ status: "failed", errorCode }]);
      expect(submissions).toHaveLength(1);
      expect((await db.select().from(sets))[0]?.status).toBe("failed");
      expect(JSON.stringify(events)).not.toMatch(
        /private|secret|provider-|users\//,
      );
    },
  );
  it("recovers expired submitting as uncertain without provider I/O", async () => {
    await create();
    const lease = {
      workerId: "crashed",
      now,
      leaseUntil: new Date(now.getTime() + 10),
    };
    const task = await claimNextTask(lease);
    await markTaskSubmitting({ ...lease, taskId: task!.id });
    now = new Date(now.getTime() + 11);
    await step();
    expect(await rows()).toMatchObject([
      {
        status: "failed",
        errorCode: "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
      },
    ]);
    expect(submissions).toHaveLength(0);
  });
  it("does not recover a live submitting lease", async () => {
    await create();
    const lease = {
      workerId: "live",
      now,
      leaseUntil: new Date(now.getTime() + 60_000),
    };
    const task = await claimNextTask(lease);
    await markTaskSubmitting({ ...lease, taskId: task!.id });
    await step();
    expect((await rows())[0]?.status).toBe("submitting");
  });
  it("recovers a crash after queued claim without inventing an uncertain submission", async () => {
    await create();
    await claimNextTask({
      workerId: "crashed",
      now,
      leaseUntil: new Date(now.getTime() + 10),
    });
    now = new Date(now.getTime() + 11);
    await step();
    expect((await rows())[0]?.status).toBe("submitted");
    expect(submissions).toHaveLength(1);
  });
  it("never resubmits when the provider accepted but PostgreSQL could not store its ID", async () => {
    await create();
    await db.execute(
      sql`create function concept_test_reject_submitted() returns trigger language plpgsql as $$ begin if NEW.status = 'submitted' then raise exception 'simulated crash'; end if; return NEW; end $$`,
    );
    await db.execute(
      sql`create trigger concept_test_reject_submitted before update on inspiration_concept_tasks for each row execute function concept_test_reject_submitted()`,
    );
    try {
      await expect(step()).rejects.toThrow();
      expect((await rows())[0]?.status).toBe("submitting");
    } finally {
      await db.execute(
        sql`drop trigger concept_test_reject_submitted on inspiration_concept_tasks`,
      );
      await db.execute(sql`drop function concept_test_reject_submitted()`);
    }
    now = new Date(now.getTime() + 10 * 60_000);
    await step();
    await step();
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
    });
    expect(submissions).toHaveLength(1);
  });
  it("reschedules polling transport errors without creating a second provider job", async () => {
    await create();
    await step();
    await ready();
    provider.queryTask = async ({ taskId }) => {
      queries.push(taskId);
      throw Error("private query timeout");
    };
    await step();
    expect((await rows())[0]?.status).toBe("submitted");
    expect(await step()).toEqual({ state: "idle" });
    await ready();
    await step();
    expect(queries).toHaveLength(2);
    expect(submissions).toHaveLength(1);
  });
  it("rejects success arriving after the thirty-minute task deadline", async () => {
    await create();
    await step();
    now = new Date(now.getTime() + 30 * 60_000 - 1);
    const original = provider.queryTask;
    provider.queryTask = async (input) => {
      now = new Date(now.getTime() + 2);
      return original(input);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await step();
    } finally {
      vi.useRealTimers();
    }
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
    });
    expect(writes).toHaveLength(0);
  });
  it("caps pending backoff at the thirty-minute deadline", async () => {
    await create();
    await step();
    const deadline = new Date(now.getTime() + 30 * 60_000);
    now = new Date(deadline.getTime() - 1);
    provider.queryTask = async ({ taskId }) => ({
      state: "pending",
      taskId,
      requestId: "private",
    });
    await step();
    expect((await rows())[0]!.availableAt).toEqual(deadline);
    now = deadline;
    await step();
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
    });
  });
  it("compensates an import crossing the lifetime deadline before publication under a live lease", async () => {
    await create();
    await step();
    now = new Date(now.getTime() + 30 * 60_000 - 1000);
    afterPut = async () => {
      now = new Date(now.getTime() + 2000);
      expect((await rows())[0]!.leaseUntil!.getTime()).toBeGreaterThan(
        now.getTime(),
      );
    };
    // Freeze timer delivery so this case proves the clock check independently of cancellation.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await step();
    } finally {
      vi.useRealTimers();
    }
    expect(writes).toHaveLength(1);
    expect(objects.has(writes[0]!)).toBe(false);
    expect(await rows()).toMatchObject([
      {
        outputKind: "sketch",
        status: "failed",
        errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
        completedAt: now,
        leaseOwner: null,
        leaseUntil: null,
      },
    ]);
    expect(await db.select().from(sets)).toMatchObject([
      { status: "failed", completedAt: now },
    ]);
    expect(await db.select().from(outputs)).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
    expect(submissions).toHaveLength(1);
    expect(queries).toHaveLength(1);
    expect(await step()).toEqual({ state: "idle" });
    expect(submissions).toHaveLength(1);
    expect(queries).toHaveLength(1);
  });
  it.each(["query", "put"] as const)(
    "clamps external cancellation to remaining lifetime during %s",
    async (boundary) => {
      await create();
      await step();
      now = new Date(now.getTime() + 30 * 60_000 - 1000);
      let operationSignal: AbortSignal | undefined;
      const cancellation: boolean[] = [];
      const reachDeadline = async () => {
        now = new Date(now.getTime() + 999);
        await vi.advanceTimersByTimeAsync(999);
        cancellation.push(operationSignal!.aborted);
        now = new Date(now.getTime() + 1);
        await vi.advanceTimersByTimeAsync(1);
        cancellation.push(operationSignal!.aborted);
      };
      const original = provider.queryTask;
      provider.queryTask = async (input) => {
        operationSignal = input.signal;
        const result = await original(input);
        if (boundary === "query") {
          await reachDeadline();
          input.signal.throwIfAborted();
        }
        return result;
      };
      if (boundary === "put") afterPut = reachDeadline;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await step();
      } finally {
        vi.useRealTimers();
      }
      expect(cancellation).toEqual([false, true]);
      expect(await rows()).toMatchObject([
        {
          outputKind: "sketch",
          status: "failed",
          errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
          completedAt: now,
        },
      ]);
      expect(await rows()).toHaveLength(1);
      expect(await db.select().from(sets)).toMatchObject([
        { status: "failed", completedAt: now },
      ]);
      expect(await db.select().from(outputs)).toHaveLength(0);
      expect(objects.size).toBe(0);
      expect(writes).toHaveLength(boundary === "put" ? 1 : 0);
      expect(submissions).toHaveLength(1);
      expect(queries).toHaveLength(1);
    },
  );
  it("rejects invalid imported image dimensions without scheduling derivatives", async () => {
    await create();
    await step();
    await ready();
    png = flatPng;
    await step();
    expect(await rows()).toMatchObject([
      { status: "failed", errorCode: "INSPIRATION_CONCEPT_IMPORT_FAILED" },
    ]);
    expect(writes).toHaveLength(0);
  });
  it("recovers submitted leases, backs off pending, and times out after thirty minutes", async () => {
    await create();
    await step();
    await ready();
    const claimed = await claimNextTask({
      workerId: "crashed",
      now,
      leaseUntil: new Date(now.getTime() + 10),
    });
    expect(claimed).toBeDefined();
    now = new Date(now.getTime() + 11);
    provider.queryTask = async ({ taskId }) => {
      queries.push(taskId);
      return { state: "pending", taskId, requestId: "private" };
    };
    await step();
    const pending = (await rows())[0]!;
    expect(pending.status).toBe("submitted");
    expect(pending.availableAt.getTime()).toBeGreaterThan(now.getTime());
    expect(pending.availableAt.getTime() - now.getTime()).toBeLessThanOrEqual(
      30_000,
    );
    expect(await step()).toEqual({ state: "idle" });
    now = new Date(pending.submitStartedAt!.getTime() + 30 * 60_000);
    await step();
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
    });
    expect(submissions).toHaveLength(1);
    expect(queries).toHaveLength(1);
  });
  it.each(["rejected", "failed"] as const)(
    "maps terminal provider %s to stable failure",
    async (state) => {
      await create();
      await step();
      await ready();
      provider.queryTask = async ({ taskId }) => ({
        state,
        taskId,
        requestId: "private",
      });
      await step();
      expect((await rows())[0]).toMatchObject({
        status: "failed",
        errorCode:
          state === "rejected"
            ? "INSPIRATION_CONCEPT_REJECTED"
            : "INSPIRATION_CONCEPT_UNAVAILABLE",
      });
    },
  );
  it("persists sketch before exactly two derivatives and submits both before either finishes", async () => {
    await completeSketch();
    expect(await rows()).toMatchObject([
      { outputKind: "sketch", status: "completed" },
      { outputKind: "effect", status: "queued" },
      { outputKind: "flat", status: "queued" },
    ]);
    expect(objects.size).toBe(1);
    await step();
    await step();
    expect(submissions.map((input) => input.kind)).toEqual([
      "sketch",
      expect.any(String),
      expect.any(String),
    ]);
    expect(new Set(submissions.slice(1).map(({ kind }) => kind))).toEqual(
      new Set(["effect", "flat"]),
    );
    expect(
      (await rows()).filter(({ status }) => status === "submitted"),
    ).toHaveLength(2);
    await ready();
    await step();
    await step();
    expect((await db.select().from(sets))[0]?.status).toBe("completed");
    expect(objects.size).toBe(3);
    expect(await rows()).toHaveLength(3);
  });
  it("uses ordered references for sketch, then master plus only the first two references", async () => {
    const jobId = randomUUID();
    await db.insert(inspirationVisualJobs).values({
      id: jobId,
      ownerId,
      analysisId,
      operationId: randomUUID(),
      kind: "research_visuals",
      status: "completed",
      completedAt: now,
    });
    const ids: string[] = [];
    const colors = ["#ff0000", "#00ff00", "#0000ff"];
    for (const [index, color] of colors.entries()) {
      const id = randomUUID();
      ids.push(id);
      const key = `users/${ownerId}/inspiration/${analysisId}/research/${jobId}/${id}.png`;
      await db.insert(inspirationVisualAssets).values({
        id,
        ownerId,
        analysisId,
        jobId,
        kind: "web_evidence",
        ordinal: index,
        title: "Ref",
        altText: "Ref",
        documentRole: "evidence",
        sourceIndexes: [1],
        sourcePageUrl: "https://example.test/ref",
        sourceSiteName: "Example",
        sourceQuery: "garment",
        objectKey: key,
        contentType: "image/png",
        width: 32,
        height: 32,
      });
      objects.set(key, {
        bytes: await sharp({
          create: { width: 32, height: 32, channels: 3, background: color },
        })
          .png()
          .toBuffer(),
        contentType: "image/png",
      });
    }
    await create(ids, jobId);
    await step();
    await ready();
    await step();
    await step();
    await step();
    const sketch = submissions[0]!;
    expect(sketch.images).toHaveLength(3);
    for (const derivative of submissions.slice(1)) {
      expect(derivative.images).toHaveLength(3);
      expect(derivative.images.slice(1)).toEqual(sketch.images.slice(0, 2));
      expect(derivative.images[0]).not.toBe(sketch.images[0]);
    }
    const rgb = await sharp(
      Buffer.from(sketch.images[0]!.split(",")[1]!, "base64"),
    )
      .raw()
      .toBuffer();
    expect(rgb[0]).toBeGreaterThan(240);
    expect(rgb[1]).toBeLessThan(10);
  });
  it("compensates a stale publication after the lease expires during storage", async () => {
    await create();
    await step();
    await ready();
    afterPut = async () => {
      now = new Date(now.getTime() + 10 * 60_000);
    };
    await step();
    expect(writes).toHaveLength(1);
    expect(objects.size).toBe(0);
    expect(await db.select().from(outputs)).toHaveLength(0);
    expect((await rows())[0]?.status).toBe("submitted");
  });
  it("compensates a real PostgreSQL publication error and leaves submitted work recoverable", async () => {
    await create();
    await step();
    await ready();
    await db.execute(
      sql`create function concept_test_reject_output() returns trigger language plpgsql as $$ begin raise exception 'private database failure'; end $$`,
    );
    await db.execute(
      sql`create trigger concept_test_reject_output before insert on inspiration_concept_outputs for each row execute function concept_test_reject_output()`,
    );
    try {
      await expect(step()).rejects.toThrow();
      expect(objects.size).toBe(0);
      expect((await rows())[0]?.status).toBe("submitted");
    } finally {
      await db.execute(
        sql`drop trigger concept_test_reject_output on inspiration_concept_outputs`,
      );
      await db.execute(sql`drop function concept_test_reject_output()`);
    }
  });
  it("preserves siblings and deletes superseded output only after replacement commits", async () => {
    const { set } = await completeAll();
    const before = await db.select().from(outputs);
    const effect = before.find((row) => row.outputKind === "effect")!;
    await createDerivativeRetry({
      ownerId,
      analysisId,
      setId: set.id,
      operationId: randomUUID(),
      outputKind: "effect",
      now,
    });
    await step();
    expect(objects.has(effect.objectKey)).toBe(true);
    await ready();
    await step();
    const after = await db.select().from(outputs);
    expect(after.filter((row) => row.outputKind !== "effect")).toEqual(
      before.filter((row) => row.outputKind !== "effect"),
    );
    expect(objects.has(effect.objectKey)).toBe(false);
    expect(objects.size).toBe(3);
  });
  it("keeps committed replacement when superseded-object deletion fails and later cleans its prefix", async () => {
    const { set } = await completeAll();
    const old = (await db.select().from(outputs)).find(
      (row) => row.outputKind === "effect",
    )!;
    await createDerivativeRetry({
      ownerId,
      analysisId,
      setId: set.id,
      operationId: randomUUID(),
      outputKind: "effect",
      now,
    });
    await step();
    await ready();
    deleteFails = true;
    await step();
    const current = (await db.select().from(outputs)).find(
      (row) => row.outputKind === "effect",
    )!;
    expect(current.id).not.toBe(old.id);
    expect(objects.has(old.objectKey)).toBe(true);
    expect(objects.has(current.objectKey)).toBe(true);
    expect((await db.select().from(sets))[0]?.status).toBe("completed");
    expect(events).toContainEqual({ event: "cleanup_failed", setId: set.id });
    expect(JSON.stringify(events)).not.toMatch(/secret|credentials|users\//);
    await softDeleteSet({ ownerId, analysisId, setId: set.id, now });
    deleteFails = false;
    await step();
    expect(objects.size).toBe(0);
  });
  it("derives partial when derivatives fail while retaining the published sketch", async () => {
    await completeSketch();
    provider.createTask = async () => {
      throw new QwenImageSubmissionError(true);
    };
    await step();
    await step();
    expect((await db.select().from(sets))[0]?.status).toBe("partial");
    expect(objects.size).toBe(1);
  });
  it("retains current output when a replacement fails", async () => {
    const { set } = await completeAll();
    const before = await db.select().from(outputs);
    await createDerivativeRetry({
      ownerId,
      analysisId,
      setId: set.id,
      operationId: randomUUID(),
      outputKind: "flat",
      now,
    });
    provider.createTask = async () => {
      throw new QwenImageSubmissionError(true);
    };
    await step();
    expect(await db.select().from(outputs)).toEqual(before);
    expect((await db.select().from(sets))[0]?.status).toBe("completed");
  });
  it("soft deletion blocks publication, compensates the write, then cleans the prefix", async () => {
    const { set } = await create();
    await step();
    await ready();
    afterPut = async () => {
      await softDeleteSet({ ownerId, analysisId, setId: set.id, now });
    };
    await step();
    expect(objects.size).toBe(0);
    expect(await db.select().from(outputs)).toHaveLength(0);
    afterPut = undefined;
    now = new Date(now.getTime() + 10 * 60_000);
    await step();
    expect(await db.select().from(sets)).toHaveLength(0);
  });
  it("retries failed deletion with a durable lease and removes unreferenced prefix objects", async () => {
    const { set } = await completeAll();
    const orphan = `${conceptSetObjectPrefix({ ownerId, analysisId, setId: set.id })}effect/${randomUUID()}.png`;
    objects.set(orphan, { bytes: png, contentType: "image/png" });
    await softDeleteSet({ ownerId, analysisId, setId: set.id, now });
    deleteFails = true;
    await step();
    expect(await db.select().from(sets)).toHaveLength(1);
    expect(objects.size).toBe(4);
    deleteFails = false;
    now = new Date(now.getTime() + 10 * 60_000);
    await step();
    expect(objects.size).toBe(0);
    expect(await db.select().from(sets)).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    expect(JSON.stringify(events)).not.toMatch(/credentials|secret|users\//);
  });
  it("waits for live task leases before deleting objects", async () => {
    const { set } = await create();
    const lease = {
      workerId: "in-flight",
      now,
      leaseUntil: new Date(now.getTime() + 60_000),
    };
    await claimNextTask(lease);
    await softDeleteSet({ ownerId, analysisId, setId: set.id, now });
    expect(await step()).toEqual({ state: "idle" });
    expect(await db.select().from(sets)).toHaveLength(1);
    now = new Date(now.getTime() + 60_001);
    await step();
    expect(await db.select().from(sets)).toHaveLength(0);
  });
  it("records heartbeat every thirty seconds and exits an idle loop on shutdown", async () => {
    const controller = new AbortController();
    let sleeps = 0;
    await runConceptWorker({
      ...deps,
      signal: controller.signal,
      sleep: async (ms) => {
        expect(ms).toBe(1000);
        sleeps++;
        now = new Date(now.getTime() + 1000);
        if (sleeps === 32) controller.abort();
      },
    });
    const [heartbeat] = await db.select().from(heartbeats);
    expect(
      heartbeat!.updatedAt.getTime() - heartbeat!.startedAt.getTime(),
    ).toBe(30_000);
    expect(sleeps).toBe(32);
  });
  it("continues heartbeats while a provider operation is in flight", async () => {
    await create();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const enteredProvider = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.createTask = async () => {
      entered();
      await pending;
      throw new QwenImageSubmissionError(false);
    };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const running = runConceptWorker({ ...deps, signal: controller.signal });
    try {
      await enteredProvider;
      now = new Date(now.getTime() + 30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect
        .poll(async () =>
          (await db.select().from(heartbeats))[0]?.updatedAt.getTime(),
        )
        .toBe(now.getTime());
      expect((await rows())[0]?.status).toBe("submitting");
    } finally {
      controller.abort();
      release();
      await running;
      vi.useRealTimers();
    }
  });
  it("aborts in-flight create on shutdown and never submits the next queued task", async () => {
    await completeSketch();
    const controller = new AbortController();
    provider.createTask = async ({ signal }) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      throw new QwenImageSubmissionError(false);
    };
    await runConceptWorker({ ...deps, signal: controller.signal });
    const remaining = await rows();
    expect(remaining.filter((row) => row.status === "queued")).toHaveLength(1);
    expect(remaining.find((row) => row.status === "failed")?.errorCode).toBe(
      "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
    );
  });
});
