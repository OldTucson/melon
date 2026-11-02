import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, closeDatabase } from "@/lib/db/client";
import { users, inspirationAnalyses, inspirationVisualAssets as assets, inspirationVisualJobs as jobs } from "@/lib/db/schema";
import { inspirationConceptSets as sets, inspirationConceptTasks as tasks, inspirationConceptReferences as refs, inspirationConceptOutputs as outputs } from "@/lib/db/schema/inspiration-concepts";
import { resetDatabase } from "@/test/database";
import { inspirationResultFixture, inspirationSourceFixture } from "@/features/inspiration/test-fixtures";
import { seedReportConcept, waitForDatabaseBlocker } from "./integration-fixtures";
import { conceptSetObjectPrefix, parseConceptObjectKey } from "./object-keys";
import { parseVisualObjectKey } from "@/features/inspiration-visuals/visual-object-keys";
import { cleanupInspirationConceptObjects } from "./cleanup";
import * as repository from "./repository";
import { getConceptWorkerStatus, recordWorkerHeartbeat, softDeleteSet } from "./repository";
import type { ConceptCleanupStore } from "./object-store";

const day = 86_400_000;
describe("scheduled concept cleanup and status", () => {
  let ownerId: string, analysisId: string, now: Date, old: Date;
  let objects: Map<string, Date>;
  let store: ConceptCleanupStore;
  let fail: "list" | "delete" | undefined;
  let beforeList: (() => Promise<void>) | undefined;
  const run = (dryRun = false) => cleanupInspirationConceptObjects({ now, orphanAgeMs: day, dryRun, store });
  async function seed(directionIndex = 0, deleted = false) {
    const row = await seedReportConcept({ ownerId, analysisId, directionIndex, deleted });
    await db.update(sets).set({ updatedAt: old, completedAt: old, ...(deleted ? { deletedAt: old } : {}) }).where(eq(sets.id, row.setId));
    row.assets.forEach(({ objectKey }) => objects.set(objectKey, old));
    return row;
  }
  function orphan(setId: string, age = old) {
    const key = `${conceptSetObjectPrefix({ ownerId, analysisId, setId })}flat/${randomUUID()}.png`;
    objects.set(key, age); return key;
  }
  beforeEach(async () => {
    await resetDatabase(); ownerId = randomUUID(); analysisId = randomUUID();
    now = new Date("2026-11-05T00:00:00Z"); old = new Date(now.getTime() - 2 * day);
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@example.test`, displayName: "Cleanup", passwordHash: "hash" });
    await db.insert(inspirationAnalyses).values({ id: analysisId, ownerId, operationId: randomUUID(), prompt: "private prompt", title: "Report", status: "completed", sources: [inspirationSourceFixture], result: inspirationResultFixture, searchModel: "qwen-plus", structureModel: "qwen3.8-flash", completedAt: old });
    objects = new Map(); fail = undefined; beforeList = undefined;
    store = {
      async listObjects(prefix) {
        await beforeList?.();
        if (fail === "list") throw Error("private list error");
        return [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, lastModified]) => ({ key, lastModified }));
      },
      async delete(keys) { if (fail === "delete") throw Error("private delete error"); keys.forEach((key) => { parseConceptObjectKey(key); objects.delete(key); }); },
      async researchObjectLastModified(key) { parseVisualObjectKey(key); return objects.get(key) ?? null; },
      async deleteResearchObjects(keys) { if (fail === "delete") throw Error("private research error"); keys.forEach((key) => { parseVisualObjectKey(key); objects.delete(key); }); },
    };
  });
  afterAll(closeDatabase);
  it("deletes old tombstones and superseded orphans, retaining current, fresh and active objects", async () => {
    const terminal = await seed(), deleted = await seed(1, true), active = await seed(2);
    const oldKey = orphan(terminal.setId), freshKey = orphan(terminal.setId, now), activeKey = orphan(active.setId);
    await db.update(sets).set({ status: "generating", completedAt: null }).where(eq(sets.id, active.setId));
    const result = await run();
    expect(result).toEqual({ scannedSets: 2, deletedObjects: 3, deletedSets: 1, skippedActiveSets: 1, deletedResearchObjects: 0, failures: 0, scannedReports: 0, deletedReports: 0 });
    expect(objects.has(oldKey)).toBe(false); expect(objects.has(freshKey)).toBe(true); expect(objects.has(activeKey)).toBe(true);
    terminal.assets.forEach(({ objectKey }) => expect(objects.has(objectKey)).toBe(true));
    expect(await db.select().from(sets).where(eq(sets.id, deleted.setId))).toHaveLength(0);
    expect((await run()).deletedObjects).toBe(0);
  });
  it("dry run leaves every object, row and lease unchanged", async () => {
    await seed(0, true); const terminal = await seed(1); orphan(terminal.setId);
    const before = await db.select().from(sets), saved = [...objects];
    expect(await run(true)).toMatchObject({ deletedObjects: 0, deletedSets: 0, failures: 0 });
    expect(await db.select().from(sets)).toEqual(before); expect([...objects]).toEqual(saved);
  });
  it.each(["list", "delete"] as const)("retains retryable tombstones after %s failure", async (mode) => {
    const row = await seed(0, true); fail = mode;
    expect(await run()).toMatchObject({ failures: 1, deletedSets: 0 });
    expect(await db.select().from(sets)).toHaveLength(1); expect(objects.size).toBe(2);
    fail = undefined; expect(await run()).toMatchObject({ deletedSets: 1, failures: 0 });
    expect(await db.select().from(tasks).where(eq(tasks.setId, row.setId))).toHaveLength(0);
  });
  it("reclaims expired deletion leases but skips live cleanup and task leases", async () => {
    const expired = await seed(0, true), live = await seed(1, true), fresh = await seed(2, true);
    await db.update(sets).set({ deletionLeaseOwner: "crashed", deletionLeaseUntil: old }).where(eq(sets.id, expired.setId));
    await db.update(sets).set({ deletionLeaseOwner: "running", deletionLeaseUntil: new Date(now.getTime() + day) }).where(eq(sets.id, live.setId));
    await db.update(sets).set({ deletedAt: now }).where(eq(sets.id, fresh.setId));
    expect(await run()).toMatchObject({ deletedSets: 1 });
    expect((await db.select().from(sets)).map((row) => row.id).sort()).toEqual([live.setId, fresh.setId].sort());
  });
  it("does not finalize an expired cleanup token after storage completes", async () => {
    await seed(0, true); const clock = Date.now(); const clockSpy = vi.spyOn(Date, "now").mockReturnValue(clock);
    beforeList = async () => { clockSpy.mockReturnValue(clock + 31 * 60_000); };
    try { expect(await run()).toMatchObject({ deletedSets: 0, failures: 1 }); }
    finally { clockSpy.mockRestore(); beforeList = undefined; }
    expect(await db.select().from(sets)).toHaveLength(1);
    expect(await run()).toMatchObject({ deletedSets: 1, failures: 0 });
  });
  it("rejects foreign, unrelated and malformed list keys before any deletion", async () => {
    await seed(0, true); const original = store.listObjects;
    store.listObjects = async (prefix) => [...await original(prefix), { key: [...objects.keys()][0]!.replace(ownerId, randomUUID()), lastModified: old }];
    expect(await run()).toMatchObject({ failures: 1, deletedSets: 0 }); expect(objects.size).toBe(2);
  });
  it("preserves tombstones whose database output key escapes the owned set scope", async () => {
    const row = await seed(0, true); const output = row.assets[0]!;
    const foreign = output.objectKey.replace(ownerId, randomUUID());
    await db.update(outputs).set({ objectKey: foreign }).where(eq(outputs.id, output.id));
    objects.delete(output.objectKey); objects.set(foreign, old);
    expect(await run()).toMatchObject({ deletedSets: 0, failures: 1 });
    expect(await db.select().from(sets)).toHaveLength(1); expect(objects.has(foreign)).toBe(true);
  });
  it("does not hard delete tombstones containing a fresh in-flight object", async () => {
    const row = await seed(0, true); const fresh = orphan(row.setId, now);
    expect(await run()).toMatchObject({ deletedSets: 0 }); expect(objects.has(fresh)).toBe(true);
    expect(await db.select().from(sets)).toHaveLength(1);
  });
  it("rechecks DB state after candidate discovery, before touching storage", async () => {
    const row = await seed(); const key = orphan(row.setId);
    const result = await cleanupInspirationConceptObjects({ now, dryRun: false, store, repository: { ...repository,
      async listConceptCleanupCandidates(cutoff) {
        const found = await repository.listConceptCleanupCandidates(cutoff);
        await db.update(sets).set({ status: "generating", completedAt: null }).where(eq(sets.id, row.setId));
        return found;
      },
    } });
    expect(result).toMatchObject({ scannedSets: 0, deletedObjects: 0 }); expect(objects.has(key)).toBe(true);
  });
  it("waits for a concurrent analysis transaction and rechecks its committed active state", async () => {
    const row = await seed(); const key = orphan(row.setId);
    let unlock!: () => void, announce!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const held = new Promise<number>((resolve) => { announce = resolve; });
    const writer = db.transaction(async (tx) => {
      await repository.lockConceptAnalysis(tx, analysisId);
      const [connection] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.update(sets).set({ status: "generating", completedAt: null }).where(eq(sets.id, row.setId));
      announce(Number(connection!.pid)); await gate;
    });
    const pid = await held; const cleanup = run();
    try { expect(await waitForDatabaseBlocker(pid, "advisory")).toBe(true); }
    finally { unlock(); await writer; }
    expect(await cleanup).toMatchObject({ scannedSets: 0, deletedObjects: 0 }); expect(objects.has(key)).toBe(true);
  });
  it("preserves an old tombstone with an unexpired task lease", async () => {
    const row = await seed(0, true);
    const [task] = await db.select().from(tasks).where(eq(tasks.setId, row.setId));
    await db.update(tasks).set({ status: "submitted", errorCode: null, completedAt: null, submitStartedAt: old, providerTaskId: "private", leaseOwner: "running", leaseUntil: new Date(now.getTime() + day) }).where(eq(tasks.id, task!.id));
    expect(await run()).toMatchObject({ deletedSets: 0, deletedObjects: 0 }); expect(objects.size).toBe(2);
  });
  it("rejects reduced retention before listing or mutating", async () => {
    await seed(0, true);
    await expect(cleanupInspirationConceptObjects({ now, orphanAgeMs: day - 1, dryRun: false, store })).rejects.toThrow("Invalid cleanup retention");
    expect(objects.size).toBe(2); expect(await db.select().from(sets)).toHaveLength(1);
  });
  async function evidence(jobId: string, key?: string, ordinal = 0) {
    const id = randomUUID(); const objectKey = key ?? `users/${ownerId}/inspiration/${analysisId}/research/${jobId}/${id}.png`;
    await db.insert(assets).values({ id, ownerId, analysisId, jobId, kind: "web_evidence", ordinal, title: "Evidence", altText: "Evidence", sourcePageUrl: "https://example.test/evidence", sourceSiteName: "Example", sourceQuery: "private", documentRole: "evidence", sourceIndexes: [1], objectKey, contentType: "image/png", width: 32, height: 32, createdAt: old });
    objects.set(objectKey, old); return { id, objectKey };
  }
  async function job(createdAt: Date) {
    const id = randomUUID(); await db.insert(jobs).values({ id, ownerId, analysisId, operationId: randomUUID(), kind: "research_visuals", status: "completed", createdAt, completedAt: createdAt, updatedAt: createdAt }); return id;
  }
  it("keeps referenced research through tombstoning and removes only after the final hard deletion", async () => {
    const prior = await job(new Date(old.getTime() - day)), ev = await evidence(prior); await job(old);
    const first = await seed(), second = await seed(1);
    for (const row of [first, second]) await db.insert(refs).values({ ownerId, analysisId, setId: row.setId, visualAssetId: ev.id, ordinal: 0 });
    expect((await run()).deletedResearchObjects).toBe(0);
    await softDeleteSet({ ownerId, analysisId, setId: first.setId, now: old });
    await run(); expect(objects.has(ev.objectKey)).toBe(true);
    await softDeleteSet({ ownerId, analysisId, setId: second.setId, now: old });
    fail = "delete"; await run(); expect(objects.has(ev.objectKey)).toBe(true);
    fail = undefined; expect((await run()).deletedResearchObjects).toBe(1); expect(objects.has(ev.objectKey)).toBe(false);
    expect(await db.select().from(assets)).toHaveLength(0);
  });
  it("rechecks references added after research candidate discovery", async () => {
    const prior = await job(new Date(old.getTime() - day)), ev = await evidence(prior); await job(old);
    const row = await seed();
    const result = await cleanupInspirationConceptObjects({ now, dryRun: false, store, repository: { ...repository,
      async listResearchCleanupCandidates(cutoff) {
        const found = await repository.listResearchCleanupCandidates(cutoff);
        await db.insert(refs).values({ ownerId, analysisId, setId: row.setId, visualAssetId: ev.id, ordinal: 0 });
        return found;
      },
    } });
    expect(result.deletedResearchObjects).toBe(0); expect(objects.has(ev.objectKey)).toBe(true);
  });
  it("protects shared-key aliases in the current research job and retains failed research cleanup", async () => {
    const prior = await job(new Date(old.getTime() - day)), ev = await evidence(prior), latest = await job(old);
    await evidence(latest, ev.objectKey);
    expect((await run()).deletedResearchObjects).toBe(0); expect(objects.has(ev.objectKey)).toBe(true);
    await job(new Date(old.getTime() + 1000)); fail = "delete";
    expect((await run()).failures).toBe(1); expect(await db.select().from(assets)).toHaveLength(2);
    fail = undefined; expect((await run()).deletedResearchObjects).toBe(1); expect(await db.select().from(assets)).toHaveLength(0);
  });
  it("preserves fresh research objects and pending-job aliases", async () => {
    const prior = await job(new Date(old.getTime() - day)), ev = await evidence(prior); await job(old);
    objects.set(ev.objectKey, now);
    expect((await run()).deletedResearchObjects).toBe(0);
    objects.set(ev.objectKey, old);
    const pendingId = randomUUID();
    await db.insert(jobs).values({ id: pendingId, ownerId, analysisId, operationId: randomUUID(), kind: "research_visuals", status: "pending", createdAt: old });
    await evidence(pendingId, ev.objectKey);
    expect((await run()).deletedResearchObjects).toBe(0); expect(objects.has(ev.objectKey)).toBe(true);
  });
  it("does not let 25 current research aliases starve a later unreferenced key", async () => {
    const prior = await job(new Date(old.getTime() - day)), latest = await job(old);
    for (let ordinal = 0; ordinal < 25; ordinal++) {
      const id = `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
      const key = `users/${ownerId}/inspiration/${analysisId}/research/${prior}/${id}.png`;
      await evidence(prior, key, ordinal); await evidence(latest, key, ordinal);
    }
    const key = `users/${ownerId}/inspiration/${analysisId}/research/${prior}/ffffffff-ffff-4fff-8fff-ffffffffffff.png`;
    await evidence(prior, key, 25);
    expect((await run()).deletedResearchObjects).toBe(1); expect(objects.has(key)).toBe(false); expect(objects.size).toBe(25);
  });
  it("counts submitting, submitted and failed tasks without exposing provider identities", async () => {
    const row = await seed(); const rows = await db.select().from(tasks).where(eq(tasks.setId, row.setId));
    const completed = rows.filter((task) => task.status === "completed");
    await db.update(tasks).set({ status: "submitting", completedAt: null, providerTaskId: null, providerRequestId: null }).where(eq(tasks.id, completed[0]!.id));
    await db.update(tasks).set({ status: "submitted", completedAt: null }).where(eq(tasks.id, completed[1]!.id));
    const result = await getConceptWorkerStatus({ now, staleAfterMs: 90_000 });
    expect(result).toMatchObject({ counts: { queued: 0, submitting: 1, submitted: 1, failed: 1 }, oldestQueueAgeMs: null });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|users\//);
  });
  it("reports only configured heartbeat health, counts and oldest queued age", async () => {
    const row = await seed();
    await db.update(tasks).set({ status: "queued", completedAt: null, errorCode: null, providerTaskId: null, providerRequestId: null, submitStartedAt: null, createdAt: old }).where(eq(tasks.setId, row.setId));
    await recordWorkerHeartbeat({ workerId: "configured-private", startedAt: old, now });
    expect(await getConceptWorkerStatus({ workerId: "configured-private", now, staleAfterMs: 90_000 })).toEqual({ healthy: true, status: "healthy", heartbeatAgeMs: 0, counts: { queued: 3, submitting: 0, submitted: 0, failed: 0 }, oldestQueueAgeMs: 2 * day });
    expect(await getConceptWorkerStatus({ workerId: "other-private", now, staleAfterMs: 90_000 })).toMatchObject({ healthy: false, status: "missing", heartbeatAgeMs: null });
    expect(await getConceptWorkerStatus({ workerId: "configured-private", now: new Date(now.getTime() + 90_001), staleAfterMs: 90_000 })).toMatchObject({ healthy: false, status: "stale", heartbeatAgeMs: 90_001 });
  });
});
