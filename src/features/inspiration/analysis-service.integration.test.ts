import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/lib/db/client";
import { inspirationAnalyses, users } from "@/lib/db/schema";
import { AppError } from "@/lib/http/app-error";
import { resetDatabase } from "@/test/database";
import * as repository from "./analysis-repository";
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
    expect(await repository.enableShareRow(otherOwnerId, completed.id, randomUUID(), now)).toBeUndefined();
    expect(await repository.disableShareRow(otherOwnerId, completed.id, now)).toBeUndefined();
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
});
