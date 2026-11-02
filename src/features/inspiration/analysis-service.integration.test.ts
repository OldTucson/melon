import type OSS from "ali-oss";
import * as conceptObjectStore from "@/features/inspiration-concepts/object-store";
import { lockConceptAnalysis } from "@/features/inspiration-concepts/repository";
import { conceptOutputObjectKey } from "@/features/inspiration-concepts/object-keys";
import { seedReportConcept, waitForDatabaseBlocker } from "@/features/inspiration-concepts/integration-fixtures";
import { inspirationConceptReferences, inspirationConceptOutputs, inspirationConceptSets } from "@/lib/db/schema/inspiration-concepts";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/lib/db/client";
import { inspirationAnalyses, inspirationVisualAssets, inspirationVisualJobs, patterns, assets as storageAssets, users } from "@/lib/db/schema";
import { AppError } from "@/lib/http/app-error";
import { resetDatabase } from "@/test/database";
import * as repository from "./analysis-repository";
import * as visualService from "@/features/inspiration-visuals/visual-service";
import * as visualObjectStore from "@/features/inspiration-visuals/visual-object-store";
import * as environment from "@/lib/env/server";
import { authorizeOwnedVisualResource, authorizeSharedVisualResource } from "@/features/inspiration-visuals/visual-resource-service";
import { researchVisualObjectKey } from "@/features/inspiration-visuals/visual-object-keys";
import { createInspirationAnalysis, retryInspirationAnalysis, listInspirationAnalyses, getInspirationAnalysis, renameInspirationAnalysis, deleteInspirationAnalysis } from "./analysis-service";
import { decodeInspirationCursor, encodeInspirationCursor } from "./inspiration-cursor";
import type { InspirationProvider, InspirationProviderOutput } from "./qwen-provider";
import { inspirationResultFixture, inspirationSourceFixture } from "./test-fixtures";

const output: InspirationProviderOutput = { sources: [inspirationSourceFixture], result: inspirationResultFixture, searchRequestId: "private-search", structureRequestId: "private-structure" };
const prompt = "分析都市轻通勤女装";
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

// Doubles replace only the external paid provider; all persistence uses PostgreSQL.
describe("inspiration analysis lifecycle", () => {
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  let provider: InspirationProvider;
  beforeEach(async () => {
    await resetDatabase();
    await db.insert(users).values([ownerId, otherOwnerId].map((id) => ({ id, email: `${id}@example.test`, displayName: "Designer", passwordHash: "hash", mustChangePassword: false })));
    provider = { analyze: vi.fn(async () => structuredClone(output)) };
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(closeDatabase);
  const create = (overrides = {}) => createInspirationAnalysis({ ownerId, operationId: randomUUID(), prompt, ...overrides }, provider);
  const seed = async (overrides: Partial<typeof inspirationAnalyses.$inferInsert> = {}) => {
    const [row] = await db.insert(inspirationAnalyses).values({ id: randomUUID(), ownerId, operationId: randomUUID(), prompt, title: prompt, status: "pending", searchModel: "qwen-plus", structureModel: "qwen3.8-flash", ...overrides }).returning();
    return row!;
  };

  it("auto-saves a validated snapshot and replays normalized operations without another charge", async () => {
    const operationId = randomUUID();
    const first = await create({ operationId, prompt: "  分析都市轻通勤女装 e\u0301  " });
    expect(first).toMatchObject({ status: "completed", title: "分析都市轻通勤女装 é", version: 1, sources: output.sources, result: output.result });
    expect(await create({ operationId, prompt: "分析都市轻通勤女装 é" })).toEqual(first);
    expect(provider.analyze).toHaveBeenCalledTimes(1);
    expect(provider.analyze).toHaveBeenCalledWith({ prompt: "分析都市轻通勤女装 é", signal: expect.any(AbortSignal) });
    expect(first).not.toHaveProperty("ownerId");
    expect(first).not.toHaveProperty("searchRequestId");
    expect((await repository.getOwnedAnalysisRow(ownerId, first.id))?.searchRequestId).toBe("private-search");
    await expect(create({ operationId, prompt: "不同分析需求女装" })).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
  });

  it("counts default title Unicode code points without splitting surrogate pairs", async () => {
    expect((await create({ prompt: "😀".repeat(31) })).title).toBe("😀".repeat(30));
  });

  it.each([false, true])("resolves a true check-then-insert race (different prompt: %s) with one provider invocation", async (different) => {
    const originalFind = repository.findAnalysisByOperationRow;
    const bothRead = deferred(); let reads = 0;
    vi.spyOn(repository, "findAnalysisByOperationRow").mockImplementation(async (...args) => {
      const row = await originalFind(...args);
      if (++reads <= 2) { if (reads === 2) bothRead.resolve(); await bothRead.promise; }
      return row;
    });
    const started = deferred(); const release = deferred();
    provider = { analyze: vi.fn(async () => { started.resolve(); await release.promise; return output; }) };
    const operationId = randomUUID();
    const requests = [create({ operationId }), create({ operationId, prompt: different ? "不同分析需求女装" : prompt })];
    const results = requests.map((request) => request.then((value) => ({ value }), (error: unknown) => ({ error })));
    try {
      await started.promise;
      const loser = await Promise.race(results);
      if (different) expect(loser).toMatchObject({ error: { code: "OPERATION_ID_REUSED", status: 409 } });
      else expect(loser).toMatchObject({ value: { status: "pending" } });
      expect(provider.analyze).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); }
    const settled = await Promise.all(results);
    expect(settled.filter((result) => "value" in result && result.value.status === "completed")).toHaveLength(1);
    expect(await db.select().from(inspirationAnalyses)).toHaveLength(1);
  });

  it("blocks another operation while pending, but isolates another owner's pending slot", async () => {
    await seed();
    await expect(create()).rejects.toMatchObject({ code: "INSPIRATION_BUSY", status: 409 });
    expect((await create({ ownerId: otherOwnerId })).status).toBe("completed");
    expect(provider.analyze).toHaveBeenCalledTimes(1);
  });

  it("persists only a stable provider error and explicitly retries the same analysis", async () => {
    const operationId = randomUUID();
    provider = { analyze: vi.fn(async () => { throw new AppError("INSPIRATION_SEARCH_TIMEOUT", 504, "secret provider body", { secret: "secret" }); }) };
    const error = await create({ operationId }).catch((error: unknown) => error);
    const row = await repository.findAnalysisByOperationRow(ownerId, operationId);
    expect(error).toMatchObject({ code: "INSPIRATION_SEARCH_TIMEOUT", status: 504, details: { analysisId: row!.id } });
    expect((error as AppError).details).toEqual({ analysisId: row!.id });
    expect((error as AppError).message).not.toContain("secret");
    expect(row).toMatchObject({ status: "failed", result: null, errorCode: "INSPIRATION_SEARCH_TIMEOUT", version: 1 });
    expect((await create({ operationId })).status).toBe("failed");
    expect(provider.analyze).toHaveBeenCalledTimes(1);
    provider = { analyze: vi.fn(async () => output) };
    expect(await retryInspirationAnalysis({ ownerId, analysisId: row!.id }, provider)).toMatchObject({ id: row!.id, status: "completed", errorCode: null, version: 3 });
    await expect(retryInspirationAnalysis({ ownerId, analysisId: row!.id }, provider)).rejects.toMatchObject({ code: "INSPIRATION_BUSY" });
  });

  it("sanitizes unexpected provider failures and malformed provider snapshots", async () => {
    provider = { analyze: async () => { throw new Error("private transport detail"); } };
    await expect(create()).rejects.toMatchObject({ code: "INSPIRATION_SEARCH_UNAVAILABLE", status: 503 });
    provider = { analyze: async () => ({ ...output, result: {} as typeof output.result }) };
    await expect(create()).rejects.toMatchObject({ code: "INSPIRATION_STRUCTURE_INVALID", status: 502 });
    expect((await listInspirationAnalyses({ ownerId })).items.map((row) => row.status)).toEqual(["failed", "failed"]);
  });

  it.each(["create", "list", "detail"])("repairs only this owner's stale pending rows before %s", async (action) => {
    const staleTime = new Date(Date.now() - 181_000);
    const row = await seed({ updatedAt: staleTime });
    const other = await seed({ ownerId: otherOwnerId, updatedAt: staleTime });
    if (action === "create") await create();
    else if (action === "list") expect((await listInspirationAnalyses({ ownerId })).items[0]).toMatchObject({ status: "failed", errorCode: "INSPIRATION_INTERRUPTED" });
    else expect(await getInspirationAnalysis({ ownerId, analysisId: row.id })).toMatchObject({ status: "failed", errorCode: "INSPIRATION_INTERRUPTED" });
    expect(await repository.getOwnedAnalysisRow(ownerId, row.id)).toMatchObject({ status: "failed", errorCode: "INSPIRATION_INTERRUPTED", version: 1 });
    expect(await repository.getOwnedAnalysisRow(otherOwnerId, other.id)).toMatchObject({ status: "pending" });
  });

  it("does not repair a recent pending record", async () => {
    const row = await seed({ updatedAt: new Date(Date.now() - 179_000) });
    expect(await getInspirationAnalysis({ ownerId, analysisId: row.id })).toMatchObject({ status: "pending", version: 0 });
  });

  it.each(["failed", "deleted", "retried"])("fences a delayed provider completion after the original attempt is %s", async (state) => {
    const started = deferred(); const release = deferred();
    provider = { analyze: async () => { started.resolve(); await release.promise; return output; } };
    const operationId = randomUUID();
    const request = create({ operationId });
    const outcome = request.catch((error: unknown) => error);
    await started.promise;
    const row = (await repository.findAnalysisByOperationRow(ownerId, operationId))!;
    await db.update(inspirationAnalyses).set({ updatedAt: new Date(Date.now() - 181_000) }).where(eq(inspirationAnalyses.id, row.id));
    await getInspirationAnalysis({ ownerId, analysisId: row.id });
    if (state === "deleted") await deleteInspirationAnalysis({ ownerId, analysisId: row.id });
    if (state === "retried") await repository.claimFailedAnalysisRetryRow(ownerId, row.id, new Date());
    release.resolve();
    expect(await outcome).toMatchObject({ code: state === "deleted" ? "INSPIRATION_NOT_FOUND" : "INSPIRATION_BUSY" });
    const after = await repository.getOwnedAnalysisRow(ownerId, row.id);
    if (state === "deleted") expect(after).toBeUndefined();
    else expect(after).toMatchObject({ status: state === "retried" ? "pending" : "failed", result: null });
  });

  it("allows exactly one concurrent retry to claim a failed row", async () => {
    const row = await seed({ status: "failed", errorCode: "INSPIRATION_INTERRUPTED" });
    const started = deferred(); const release = deferred();
    provider = { analyze: vi.fn(async () => { started.resolve(); await release.promise; return output; }) };
    const outcomes = [1, 2].map(() => retryInspirationAnalysis({ ownerId, analysisId: row.id }, provider).catch((error: unknown) => error));
    try { await started.promise; expect(await Promise.race(outcomes)).toMatchObject({ code: "INSPIRATION_BUSY" }); } finally { release.resolve(); }
    await Promise.all(outcomes);
    expect(provider.analyze).toHaveBeenCalledTimes(1);
  });

  it("calls the provider only after the pending insert is committed and without an open transaction", async () => {
    provider = { analyze: async () => {
      const rows = await db.select().from(inspirationAnalyses);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      const active = await db.execute(sql`select pid from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`);
      expect(active).toHaveLength(0);
      return output;
    } };
    expect((await create()).status).toBe("completed");
  });

  it("isolates every owned operation and never leaks other owner's records", async () => {
    const row = await create();
    const identity = { ownerId: otherOwnerId, analysisId: row.id };
    for (const action of [() => getInspirationAnalysis(identity), () => renameInspirationAnalysis({ ...identity, title: "renamed", version: row.version }), () => deleteInspirationAnalysis(identity), () => retryInspirationAnalysis(identity, provider)]) {
      await expect(action()).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
    }
    expect((await listInspirationAnalyses({ ownerId: otherOwnerId })).items).toEqual([]);
    expect(await getInspirationAnalysis({ ownerId, analysisId: row.id })).toEqual(row);
  });

  it("rejects mutations of pending rows and enforces rename versions before hard deletion", async () => {
    const row = await seed();
    const identity = { ownerId, analysisId: row.id };
    for (const action of [() => renameInspirationAnalysis({ ...identity, title: "new", version: 0 }), () => deleteInspirationAnalysis(identity), () => retryInspirationAnalysis(identity, provider)]) {
      await expect(action()).rejects.toMatchObject({ code: "INSPIRATION_BUSY", status: 409 });
    }
    await repository.failPendingAnalysisRow(ownerId, row.id, "INSPIRATION_INTERRUPTED", new Date(), 0);
    const renamed = await renameInspirationAnalysis({ ...identity, title: "  已重命名  ", version: 1 });
    expect(renamed).toMatchObject({ title: "已重命名", version: 2 });
    await expect(renameInspirationAnalysis({ ...identity, title: "stale", version: 1 })).rejects.toMatchObject({ code: "INSPIRATION_BUSY" });
    expect(await deleteInspirationAnalysis(identity)).toEqual({ id: row.id, deleted: true });
    expect(await repository.getOwnedAnalysisRow(ownerId, row.id)).toBeUndefined();
  });

  it("paginates tied timestamps by descending UUID without losing PostgreSQL microseconds", async () => {
    const ids = ["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"];
    for (const id of ids) await seed({ id, status: "failed", errorCode: "INSPIRATION_INTERRUPTED" });
    await db.execute(sql`update inspiration_analyses set updated_at = '2026-10-28T00:00:00.123456Z'::timestamptz where owner_id = ${ownerId}`);
    const first = await listInspirationAnalyses({ ownerId, limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(first.items[0]).not.toHaveProperty("result");
    expect(decodeInspirationCursor(first.nextCursor!)).toEqual({ updatedAt: "2026-10-28T00:00:00.123456Z", id: ids[1] });
    const last = await listInspirationAnalyses({ ownerId, cursor: first.nextCursor!, limit: 2 });
    expect(last.items.map((row) => row.id)).toEqual([ids[2]]);
    expect(last.nextCursor).toBeNull();
  });

  it("rejects noncanonical or malformed cursors and invalid service inputs", async () => {
    const valid = encodeInspirationCursor({ updatedAt: "2026-10-28T00:00:00.123456Z", id: randomUUID() });
    for (const cursor of [valid + "=", valid + "!", "e30", Buffer.from(JSON.stringify({ updatedAt: "no", id: randomUUID() })).toString("base64url"), Buffer.from(JSON.stringify({ ...decodeInspirationCursor(valid), extra: true })).toString("base64url")]) {
      await expect(listInspirationAnalyses({ ownerId, cursor })).rejects.toMatchObject({ code: "INSPIRATION_INVALID_INPUT", status: 400 });
    }
    for (const request of [create({ prompt: "x" }), create({ ownerId: "invalid" }), create({ operationId: "invalid" }), listInspirationAnalyses({ ownerId, limit: 101 }), getInspirationAnalysis({ ownerId, analysisId: "invalid" })]) {
      await expect(request).rejects.toMatchObject({ code: "INSPIRATION_INVALID_INPUT", status: 400 });
    }
    expect(provider.analyze).not.toHaveBeenCalled();
  });

  it("does not misclassify an unrelated primary-key uniqueness error as busy", async () => {
    const existing = await create();
    const originalInsert = repository.createPendingAnalysisRow;
    vi.spyOn(repository, "createPendingAnalysisRow").mockImplementation((input) => originalInsert({ ...input, id: existing.id }));
    await expect(create()).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
    expect(provider.analyze).toHaveBeenCalledTimes(1);
    expect(await db.select().from(inspirationAnalyses)).toHaveLength(1);
  });

  it("preserves a failed record when retry conflicts with a different pending operation", async () => {
    const failed = await seed({ status: "failed", errorCode: "INSPIRATION_SEARCH_EMPTY" });
    await seed();
    await expect(retryInspirationAnalysis({ ownerId, analysisId: failed.id }, provider)).rejects.toMatchObject({ code: "INSPIRATION_BUSY", status: 409 });
    expect(await repository.getOwnedAnalysisRow(ownerId, failed.id)).toMatchObject({ status: "failed", errorCode: "INSPIRATION_SEARCH_EMPTY", version: 0 });
    expect(provider.analyze).not.toHaveBeenCalled();
  });

  it("fences an old provider failure after stale repair and retry", async () => {
    const started = deferred(); const release = deferred();
    provider = { analyze: async () => { started.resolve(); await release.promise; throw new AppError("INSPIRATION_SEARCH_TIMEOUT", 504, "timeout"); } };
    const operationId = randomUUID();
    const outcome = create({ operationId }).catch((error: unknown) => error);
    await started.promise;
    const row = (await repository.findAnalysisByOperationRow(ownerId, operationId))!;
    await db.update(inspirationAnalyses).set({ updatedAt: new Date(Date.now() - 181_000) }).where(eq(inspirationAnalyses.id, row.id));
    await getInspirationAnalysis({ ownerId, analysisId: row.id });
    await repository.claimFailedAnalysisRetryRow(ownerId, row.id, new Date());
    release.resolve();
    expect(await outcome).toMatchObject({ code: "INSPIRATION_SEARCH_TIMEOUT", details: { analysisId: row.id } });
    expect(await repository.getOwnedAnalysisRow(ownerId, row.id)).toMatchObject({ status: "pending", errorCode: null, version: 2 });
  });

  it("scopes every repository transition to the supplied owner", async () => {
    const pending = await seed();
    const failed = await seed({ status: "failed", errorCode: "INSPIRATION_INTERRUPTED" });
    const completed = await seed({ status: "completed", sources: output.sources, result: output.result, completedAt: new Date(), shareId: randomUUID() });
    const now = new Date();
    expect(await repository.findAnalysisByOperationRow(otherOwnerId, pending.operationId)).toBeUndefined();
    expect(await repository.completePendingAnalysisRow(otherOwnerId, pending.id, output, now, 0)).toBeUndefined();
    expect(await repository.failPendingAnalysisRow(otherOwnerId, pending.id, "INSPIRATION_INTERRUPTED", now, 0)).toBeUndefined();
    expect(await repository.claimFailedAnalysisRetryRow(otherOwnerId, failed.id, now)).toBeUndefined();
    expect(await repository.renameAnalysisRow(otherOwnerId, completed.id, 0, "changed", now)).toBeUndefined();
    expect(await repository.deleteAnalysisRow(otherOwnerId, completed.id)).toBeUndefined();
    expect(await repository.enableShareRow(otherOwnerId, completed.id, randomUUID(), now, completed.version)).toBeUndefined();
    expect(await repository.disableShareRow(otherOwnerId, completed.id, now, completed.version)).toBeUndefined();
    expect(await repository.getOwnedAnalysisRow(ownerId, pending.id)).toEqual(pending);
    expect(await repository.getOwnedAnalysisRow(ownerId, failed.id)).toEqual(failed);
    expect(await repository.getOwnedAnalysisRow(ownerId, completed.id)).toEqual(completed);
  });

  it("repairs only strictly older pending timestamps at the cutoff", async () => {
    const cutoff = new Date("2026-10-28T00:00:00.000Z");
    const row = await seed({ updatedAt: cutoff });
    expect(await repository.failStalePendingRows(ownerId, cutoff)).toHaveLength(0);
    expect(await repository.failStalePendingRows(ownerId, new Date(cutoff.getTime() + 1))).toHaveLength(1);
    expect(await repository.getOwnedAnalysisRow(ownerId, row.id)).toMatchObject({ status: "failed", version: 1 });
  });

  it("allows only one rename at a shared version", async () => {
    const row = await create();
    const outcomes = await Promise.all(["first", "second"].map((title) => renameInspirationAnalysis({ ownerId, analysisId: row.id, version: row.version, title }).catch((error: unknown) => error)));
    expect(outcomes.filter((value) => value instanceof AppError)).toHaveLength(1);
    expect(outcomes.find((value) => value instanceof AppError)).toMatchObject({ code: "INSPIRATION_BUSY" });
    expect(await repository.getOwnedAnalysisRow(ownerId, row.id)).toMatchObject({ version: row.version + 1 });
  });

  it("rejects corrupt persisted JSON rather than exposing an unchecked detail", async () => {
    const row = await create();
    await db.update(inspirationAnalyses).set({ result: { private: "secret" } }).where(eq(inspirationAnalyses.id, row.id));
    await expect(getInspirationAnalysis({ ownerId, analysisId: row.id })).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
  });
  async function visualDeletionFixture() {
    const analysis = await create();
    const patternId = randomUUID(), storageAssetId = randomUUID();
    const libraryKey = `users/${ownerId}/patterns/${patternId}/thumbnail.png`;
    await db.insert(patterns).values({ id: patternId, ownerId, name: "Saved inspiration", originalFilename: "saved.png", extension: "png", sizeBytes: 1024n, status: "ready", previewStatus: "ready" });
    await db.insert(storageAssets).values({ id: storageAssetId, ownerId, patternId, role: "thumbnail", objectKey: libraryKey, originalFilename: "saved.png", detectedMimeType: "image/png", sizeBytes: 1024n, width: 640, height: 480 });
    const objects = new Set<string>([libraryKey]);
    const researchKeys: string[] = [];
    const visualKeys: string[] = [];
    for (const state of ["old", "active", "pending", "failed", "concept"] as const) {
      const jobId = randomUUID(), assetId = randomUUID();
      const concept = state === "concept";
      const status = state === "pending" || state === "failed" ? state : "completed";
      await db.insert(inspirationVisualJobs).values({ id: jobId, ownerId, analysisId: analysis.id, operationId: randomUUID(), kind: concept ? "concept_image" : "research_visuals", directionIndex: concept ? 0 : null, status, completedAt: status === "pending" ? null : new Date(), errorCode: status === "failed" ? "INSPIRATION_VISUALS_INTERRUPTED" : null });
      const key = researchVisualObjectKey({ ownerId, analysisId: analysis.id, jobId, assetId, extension: "png" });
      objects.add(key);
      visualKeys.push(key);
      if (state === "old" || state === "active") researchKeys.push(key);
      await db.insert(inspirationVisualAssets).values({ id: assetId, ownerId, analysisId: analysis.id, jobId, kind: concept ? "generated_concept" : "web_evidence", ordinal: 0, title: state, altText: state, objectKey: key, contentType: "image/png", width: 640, height: 480,
        ...(concept ? { directionIndex: 0, savedPatternId: patternId, saveOperationId: randomUUID() } : { documentRole: "evidence", sourceIndexes: [1], sourcePageUrl: "https://example.test/evidence", sourceSiteName: "Source", sourceQuery: "query" }),
      });
      if (state === "active") await db.insert(inspirationVisualAssets).values({ id: randomUUID(), ownerId, analysisId: analysis.id, jobId, kind: "library_match", ordinal: 0, title: "Private library", altText: "Private library", patternId });
    }
    const deletions: string[][] = [];
    const observed: { analyses: number; jobs: number; visuals: number }[] = [];
    const store: visualObjectStore.VisualObjectStore = {
      async put() { throw new Error("Unexpected object write"); },
      async get() { throw new Error("Unexpected object read"); },
      async delete(keys) {
        observed.push({ analyses: (await db.select().from(inspirationAnalyses)).length, jobs: (await db.select().from(inspirationVisualJobs)).length, visuals: (await db.select().from(inspirationVisualAssets)).length });
        deletions.push([...keys]); keys.forEach((key) => objects.delete(key));
      },
    };
    return { analysisId: analysis.id, patternId, storageAssetId, libraryKey, objects, researchKeys, visualKeys, deletions, observed, store };
  }

  it("deletes all committed research web objects after the analysis and visual rows cascade, preserving saved library data", async () => {
    const fixture = await visualDeletionFixture();
    const result = await visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId }, { store: fixture.store, conceptStore: fixture.store });
    expect(result).toEqual({ id: fixture.analysisId, deleted: true });
    expect(fixture.deletions).toHaveLength(1);
    expect(fixture.deletions.flat().sort()).toEqual(fixture.visualKeys.sort());
    expect(fixture.observed).toEqual([{ analyses: 0, jobs: 0, visuals: 0 }]);
    expect(fixture.objects.size).toBe(1); // All owned report objects are gone; saved library data survives.
    expect(fixture.objects.has(fixture.libraryKey)).toBe(true);
    expect(await db.select().from(patterns)).toMatchObject([{ id: fixture.patternId, status: "ready" }]);
    expect(await db.select().from(storageAssets)).toMatchObject([{ id: fixture.storageAssetId, objectKey: fixture.libraryKey }]);
  });

  it.each(["delete", "store configuration", "environment read"] as const)("preserves successful database deletion when %s cleanup fails", async (failure) => {
    const fixture = await visualDeletionFixture();
    if (failure === "delete") fixture.store.delete = async () => { throw new Error("private storage failure"); };
    else if (failure === "store configuration") vi.spyOn(visualObjectStore, "createVisualObjectStore").mockImplementation(() => { throw new Error("private configuration"); });
    else vi.spyOn(environment, "getServerEnv").mockImplementation(() => { throw new Error("private environment"); });
    const result = await visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId }, failure === "delete" ? { store: fixture.store, conceptStore: fixture.store } : {});
    expect(result).toEqual({ id: fixture.analysisId, deleted: true });
    expect(await db.select().from(inspirationAnalyses)).toEqual([]);
    expect(await db.select().from(inspirationVisualJobs)).toEqual([]);
    expect(await db.select().from(inspirationVisualAssets)).toEqual([]);
    expect(fixture.objects.size).toBe(6);
  });

  it("returns indistinguishable foreign and missing deletion errors without deleting objects or rows", async () => {
    const fixture = await visualDeletionFixture();
    const errors = [];
    for (const analysisId of [fixture.analysisId, randomUUID()]) {
      const error = await visualService.deleteInspirationWithVisualAssets({ ownerId: otherOwnerId, analysisId }, { store: fixture.store, conceptStore: fixture.store }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404, message: "Inspiration analysis not found" });
      errors.push(JSON.stringify(error));
    }
    expect(errors[0]).toEqual(errors[1]);
    expect(fixture.deletions).toEqual([]);
    expect(fixture.objects.size).toBe(6);
    expect(await db.select().from(inspirationAnalyses)).toHaveLength(1);
    expect(await db.select().from(inspirationVisualAssets)).toHaveLength(6);
  });

  it("lets only the successful owned deletion clean captured keys in a concurrent-delete race", async () => {
    const fixture = await visualDeletionFixture();
    const outcomes = await Promise.all([1, 2].map(() => visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId }, { store: fixture.store, conceptStore: fixture.store }).catch((caught: unknown) => caught)));
    expect(outcomes.filter((value) => value instanceof AppError)).toHaveLength(1);
    expect(outcomes.find((value) => value instanceof AppError)).toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
    expect(outcomes.find((value) => !(value instanceof AppError))).toEqual({ id: fixture.analysisId, deleted: true });
    expect(fixture.deletions).toHaveLength(1);
    expect(fixture.deletions.flat().sort()).toEqual(fixture.visualKeys.sort());
  });

  it("preserves pending analysis conflicts and never cleans objects when core deletion fails", async () => {
    const fixture = await visualDeletionFixture();
    await db.update(inspirationAnalyses).set({ status: "pending", result: null, sources: null, completedAt: null }).where(eq(inspirationAnalyses.id, fixture.analysisId));
    await expect(visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId }, { store: fixture.store, conceptStore: fixture.store })).rejects.toMatchObject({ code: "INSPIRATION_BUSY", status: 409 });
    expect(fixture.deletions).toEqual([]);
    expect(fixture.objects.size).toBe(6);
    expect(await db.select().from(inspirationVisualAssets)).toHaveLength(6);
  });

  it("deletes text-only analyses without initializing any object store", async () => {
    const row = await create();
    const store = vi.spyOn(visualObjectStore, "createVisualObjectStore").mockImplementation(() => { throw new Error("Must not initialize storage"); });
    expect(await visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: row.id })).toEqual({ id: row.id, deleted: true });
    expect(store).not.toHaveBeenCalled();
  });


  it("deletes pinned evidence and live/tombstoned concept outputs only after the owned report cascade commits", async () => {
    const fixture = await visualDeletionFixture();
    const live = await seedReportConcept({ ownerId, analysisId: fixture.analysisId });
    const deleted = await seedReportConcept({ ownerId, analysisId: fixture.analysisId, version: 2, deleted: true });
    const [visual] = await db.select().from(inspirationVisualAssets).where(eq(inspirationVisualAssets.objectKey, fixture.researchKeys[0]!));
    await db.insert(inspirationConceptReferences).values({ ownerId, analysisId: fixture.analysisId, setId: live.setId, visualAssetId: visual!.id, ordinal: 0 });
    const conceptKeys = [...live.assets, ...deleted.assets].map(({ objectKey }) => objectKey);
    conceptKeys.forEach((key) => fixture.objects.add(key));
    const remove = fixture.store.delete;
    fixture.store.delete = async (keys) => {
      expect(await db.select().from(inspirationConceptOutputs)).toEqual([]);
      expect(await db.select().from(inspirationConceptSets)).toEqual([]);
      expect(await db.select().from(inspirationConceptReferences)).toEqual([]);
      await remove(keys);
    };
    await visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId }, { store: fixture.store, conceptStore: fixture.store });
    expect(fixture.deletions.flat()).toEqual(expect.arrayContaining([...fixture.researchKeys, ...conceptKeys]));
    expect(fixture.objects.has(fixture.libraryKey)).toBe(true);
    for (const key of [...fixture.researchKeys, ...conceptKeys]) expect(fixture.objects.has(key)).toBe(false);
  });

  it("waits for a publishing refresh and snapshots its new keys before deleting", async () => {
    const fixture = await visualDeletionFixture();
    const shareId = randomUUID(), jobId = randomUUID(), assetId = randomUUID();
    await db.update(inspirationAnalyses).set({ shareId }).where(eq(inspirationAnalyses.id, fixture.analysisId));
    const key = researchVisualObjectKey({ ownerId, analysisId: fixture.analysisId, jobId, assetId, extension: "png" });
    const held = deferred(), publish = deferred();
    let pid = 0;
    const writer = db.transaction(async (tx) => {
      await lockConceptAnalysis(tx, fixture.analysisId);
      pid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0]!.pid);
      held.resolve(); await publish.promise;
      await tx.insert(inspirationVisualJobs).values({ id: jobId, ownerId, analysisId: fixture.analysisId, operationId: randomUUID(), kind: "research_visuals", status: "completed", completedAt: new Date() });
      await tx.insert(inspirationVisualAssets).values({ id: assetId, ownerId, analysisId: fixture.analysisId, jobId, kind: "web_evidence", ordinal: 0, title: "Concurrent refresh", altText: "Concurrent refresh", documentRole: "evidence", sourceIndexes: [1], sourcePageUrl: "https://example.test/evidence", sourceSiteName: "Source", sourceQuery: "query", objectKey: key, contentType: "image/png", width: 640, height: 480 });
      fixture.objects.add(key);
    });
    await held.promise;
    const deletion = visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId }, { store: fixture.store, conceptStore: fixture.store });
    try {
      expect(await waitForDatabaseBlocker(pid, "advisory")).toBe(true);
      expect(fixture.deletions).toEqual([]);
    } finally { publish.resolve(); await writer; await deletion; }
    expect(fixture.deletions.flat().sort()).toEqual([...fixture.visualKeys, key].sort());
    expect(fixture.objects.has(key)).toBe(false);
    await expect(authorizeOwnedVisualResource({ ownerId, assetId })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(authorizeSharedVisualResource({ shareId, assetId })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("waits for a concept publisher set lock and includes its committed replacement output", async () => {
    const fixture = await visualDeletionFixture();
    const seeded = await seedReportConcept({ ownerId, analysisId: fixture.analysisId });
    const held = deferred(), publish = deferred();
    let pid = 0;
    const assetId = randomUUID();
    const key = conceptOutputObjectKey({ ownerId, analysisId: fixture.analysisId, setId: seeded.setId, outputId: assetId, outputKind: "sketch" });
    const writer = db.transaction(async (tx) => {
      await tx.select().from(inspirationConceptSets).where(eq(inspirationConceptSets.id, seeded.setId)).for("update");
      pid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0]!.pid);
      held.resolve(); await publish.promise;
      await tx.update(inspirationConceptOutputs).set({ id: assetId, objectKey: key }).where(eq(inspirationConceptOutputs.id, seeded.assets[0]!.id));
      fixture.objects.add(key);
    });
    await held.promise;
    const deletion = visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId }, { store: fixture.store, conceptStore: fixture.store });
    try { expect(await waitForDatabaseBlocker(pid)).toBe(true); expect(fixture.deletions).toEqual([]); }
    finally { publish.resolve(); await writer; await deletion; }
    expect(fixture.deletions.flat()).toContain(key);
    expect(fixture.deletions.flat()).not.toContain(seeded.assets[0]!.objectKey);
    expect(fixture.objects.has(key)).toBe(false);
  });

  it("cleans exact owned objects for uppercase UUID identities", async () => {
    const fixture = await visualDeletionFixture();
    await visualService.deleteInspirationWithVisualAssets({ ownerId: ownerId.toUpperCase(), analysisId: fixture.analysisId.toUpperCase() }, { store: fixture.store, conceptStore: fixture.store });
    expect(fixture.deletions.flat().sort()).toEqual(fixture.visualKeys.sort());
    expect(fixture.objects).toEqual(new Set([fixture.libraryKey]));
  });

  it("keeps recoverable concept orphans after storage failure but revokes all database access", async () => {
    const fixture = await visualDeletionFixture();
    const seeded = await seedReportConcept({ ownerId, analysisId: fixture.analysisId });
    seeded.assets.forEach(({ objectKey }) => fixture.objects.add(objectKey));
    const before = [...fixture.objects];
    fixture.store.delete = async () => { throw new Error("Storage is unavailable"); };
    expect(await visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId }, { store: fixture.store, conceptStore: fixture.store })).toEqual({ id: fixture.analysisId, deleted: true });
    expect([...fixture.objects]).toEqual(before);
    expect(await db.select().from(inspirationConceptOutputs)).toEqual([]);
    expect(await db.select().from(inspirationConceptSets)).toEqual([]);
  });

  it.each([false, true])("cleans namespaces independently through real object stores, research deletion fails=%s", async (failResearch) => {
    const fixture = await visualDeletionFixture();
    const seeded = await seedReportConcept({ ownerId, analysisId: fixture.analysisId });
    const conceptKeys = seeded.assets.map(({ objectKey }) => objectKey);
    conceptKeys.forEach((key) => fixture.objects.add(key));
    const deleted: string[] = [];
    const sdk = {
      put: vi.fn(), get: vi.fn(), listV2: vi.fn(),
      deleteMulti: vi.fn(),
    };
    sdk.deleteMulti.mockImplementation(async (keys: string[], options: OSS.DeleteMultiOptions) => {
        expect(await db.select().from(inspirationAnalyses)).toEqual([]);
        if (failResearch && keys[0]!.includes("/research/")) throw new Error("Research storage unavailable");
        deleted.push(...keys); keys.forEach((key) => fixture.objects.delete(key));
        return { deleted: options.quiet ? [] : keys.map((Key) => ({ Key })), res: { status: 200, headers: { "x-oss-request-id": "test-delete" }, size: 100, rt: 1 } };
      });
    const dependencies = { getCredential: async () => ({ accessKeyId: "test-id", accessKeySecret: "test-secret" }), createClient: () => sdk };
    const createVisual = visualObjectStore.createVisualObjectStore;
    const createConcept = conceptObjectStore.createConceptObjectStore;
    vi.spyOn(visualObjectStore, "createVisualObjectStore").mockImplementation((config) => createVisual(config, dependencies));
    vi.spyOn(conceptObjectStore, "createConceptObjectStore").mockImplementation((config) => createConcept(config, dependencies));
    await visualService.deleteInspirationWithVisualAssets({ ownerId, analysisId: fixture.analysisId });
    expect(deleted.sort()).toEqual([...(failResearch ? [] : fixture.visualKeys), ...conceptKeys].sort());
    expect(fixture.objects).toEqual(new Set([fixture.libraryKey, ...(failResearch ? fixture.visualKeys : [])]));
  });

});
