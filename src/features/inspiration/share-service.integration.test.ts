import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/lib/db/client";
import { inspirationAnalyses, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";
import { getServerEnv } from "@/lib/env/server";
import { createInspirationAnalysis, deleteInspirationAnalysis } from "./analysis-service";
import { enableInspirationShare, disableInspirationShare, getSharedInspirationAnalysis } from "./share-service";
import { inspirationResultFixture, inspirationSourceFixture } from "./test-fixtures";
import * as repository from "./analysis-repository";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

// Hold one service after its real owned-row SELECT; all intervening reads/writes remain real.
function pauseNextOwnedRead() {
  const read = deferred(); const release = deferred();
  const original = repository.getOwnedAnalysisRow;
  vi.spyOn(repository, "getOwnedAnalysisRow").mockImplementationOnce(async (...args) => {
    const row = await original(...args);
    read.resolve();
    await release.promise;
    return row;
  });
  return { read: read.promise, release: release.resolve };
}

const provider = { analyze: async () => ({ sources: [inspirationSourceFixture], result: inspirationResultFixture, searchRequestId: "private-search", structureRequestId: "private-structure" }) };
describe("inspiration shares", () => {
  const ownerId = randomUUID(); const otherOwnerId = randomUUID();
  beforeEach(async () => {
    await resetDatabase();
    await db.insert(users).values([ownerId, otherOwnerId].map((id) => ({ id, email: `${id}@example.test`, displayName: "Designer", passwordHash: "hash", mustChangePassword: false })));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(closeDatabase);
  const create = () => createInspirationAnalysis({ ownerId, operationId: randomUUID(), prompt: "分析都市轻通勤女装" }, provider);
  const shareId = (url: string | null) => new URL(url!).pathname.split("/").at(-1)!;

  it("enables idempotently, returns a strict public DTO, revokes immediately, and rotates the next URL", async () => {
    const row = await create(); const identity = { ownerId, analysisId: row.id };
    const shared = await enableInspirationShare(identity);
    expect(shared).toMatchObject({ version: row.version + 1, shareUrl: expect.stringMatching(/^http:\/\/localhost:3000\/share\/inspiration\/[0-9a-f-]{36}$/) });
    expect(await enableInspirationShare(identity)).toEqual(shared);
    expect(await getSharedInspirationAnalysis(shareId(shared.shareUrl))).toEqual({ title: row.title, prompt: row.prompt, completedAt: row.completedAt, sources: row.sources, result: row.result });
    const revoked = await disableInspirationShare(identity);
    expect(revoked).toMatchObject({ shareUrl: null, version: shared.version + 1 });
    expect(await disableInspirationShare(identity)).toEqual(revoked);
    await expect(getSharedInspirationAnalysis(shareId(shared.shareUrl))).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
    expect((await enableInspirationShare(identity)).shareUrl).not.toBe(shared.shareUrl);
  });

  it("concurrent enables reuse one share and increment version once", async () => {
    const row = await create(); const identity = { ownerId, analysisId: row.id };
    const results = await Promise.all([enableInspirationShare(identity), enableInspirationShare(identity)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].version).toBe(row.version + 1);
    const revoked = await Promise.all([disableInspirationShare(identity), disableInspirationShare(identity)]);
    expect(revoked[0]).toEqual(revoked[1]);
    expect(revoked[0].version).toBe(row.version + 2);
  });

  it("rejects a stale revoke after another request revokes S1 and enables S2", async () => {
    const row = await create(); const identity = { ownerId, analysisId: row.id };
    const firstShare = await enableInspirationShare(identity);
    const paused = pauseNextOwnedRead();
    const stale = disableInspirationShare(identity).catch((error: unknown) => error);
    await paused.read;
    let replacement!: Awaited<ReturnType<typeof enableInspirationShare>>;
    try {
      const revoked = await disableInspirationShare(identity);
      expect(revoked.version).toBe(firstShare.version + 1);
      replacement = await enableInspirationShare(identity);
      expect(replacement.version).toBe(firstShare.version + 2);
      expect(replacement.shareUrl).not.toBe(firstShare.shareUrl);
    } finally { paused.release(); }
    expect(await stale).toMatchObject({ code: "INSPIRATION_BUSY", status: 409 });
    expect(await repository.getOwnedAnalysisRow(ownerId, row.id)).toMatchObject({ shareId: shareId(replacement.shareUrl), version: firstShare.version + 2 });
    await expect(getSharedInspirationAnalysis(shareId(firstShare.shareUrl))).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND" });
    expect(await getSharedInspirationAnalysis(shareId(replacement.shareUrl))).toMatchObject({ title: row.title, prompt: row.prompt });
  });

  it("rejects a stale enable after another request enables and revokes a share", async () => {
    const row = await create(); const identity = { ownerId, analysisId: row.id };
    const paused = pauseNextOwnedRead();
    const stale = enableInspirationShare(identity).catch((error: unknown) => error);
    await paused.read;
    let shared!: Awaited<ReturnType<typeof enableInspirationShare>>;
    try {
      shared = await enableInspirationShare(identity);
      expect(shared.version).toBe(row.version + 1);
      const revoked = await disableInspirationShare(identity);
      expect(revoked).toMatchObject({ version: row.version + 2, shareUrl: null });
    } finally { paused.release(); }
    expect(await stale).toMatchObject({ code: "INSPIRATION_BUSY", status: 409 });
    expect(await repository.getOwnedAnalysisRow(ownerId, row.id)).toMatchObject({ shareId: null, version: row.version + 2 });
    await expect(getSharedInspirationAnalysis(shareId(shared.shareUrl))).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND" });
  });

  it.each(["enable", "disable"] as const)("replays an already-achieved %s after losing the observed version", async (direction) => {
    const row = await create(); const identity = { ownerId, analysisId: row.id };
    const initial = direction === "disable" ? await enableInspirationShare(identity) : row;
    const mutate = direction === "enable" ? enableInspirationShare : disableInspirationShare;
    const paused = pauseNextOwnedRead();
    const delayed = mutate(identity);
    await paused.read;
    let winner!: Awaited<ReturnType<typeof mutate>>;
    try { winner = await mutate(identity); } finally { paused.release(); }
    expect(await delayed).toEqual(winner);
    expect(winner.version).toBe(initial.version + 1);
    expect(await repository.getOwnedAnalysisRow(ownerId, row.id)).toMatchObject({ version: initial.version + 1 });
    if (direction === "enable") expect(await getSharedInspirationAnalysis(shareId(winner.shareUrl))).toMatchObject({ title: row.title });
    else await expect(getSharedInspirationAnalysis(shareId(initial.shareUrl))).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND" });
  });

  it("hard deletion immediately invalidates the public URL", async () => {
    const row = await create(); const identity = { ownerId, analysisId: row.id };
    const shared = await enableInspirationShare(identity);
    await deleteInspirationAnalysis(identity);
    await expect(getSharedInspirationAnalysis(shareId(shared.shareUrl))).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND" });
  });

  it("isolates share mutations and maps invalid or missing public IDs to the same 404", async () => {
    const row = await create();
    for (const action of [enableInspirationShare, disableInspirationShare]) await expect(action({ ownerId: otherOwnerId, analysisId: row.id })).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
    for (const id of ["invalid", randomUUID(), row.id]) await expect(getSharedInspirationAnalysis(id)).rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
  });

  it.each(["pending", "failed"] as const)("rejects sharing %s state", async (status) => {
    const id = randomUUID();
    await db.insert(inspirationAnalyses).values({ id, ownerId, operationId: randomUUID(), prompt: "分析都市轻通勤女装", title: "标题", status, errorCode: status === "failed" ? "INSPIRATION_INTERRUPTED" : null, searchModel: "qwen-plus", structureModel: "qwen3.8-flash" });
    await expect(enableInspirationShare({ ownerId, analysisId: id })).rejects.toMatchObject({ code: "INSPIRATION_BUSY", status: 409 });
    if (status === "pending") await expect(disableInspirationShare({ ownerId, analysisId: id })).rejects.toMatchObject({ code: "INSPIRATION_BUSY", status: 409 });
  });

  it("validates APP_ORIGIN before persisting a share and rejects unsafe origins", async () => {
    const row = await create(); const env = getServerEnv(); const origin = env.APP_ORIGIN;
    try {
      for (const bad of ["https://user:password@example.test", "https://example.test/path", "javascript:alert(1)", "https://example.test/?query=x"]) {
        env.APP_ORIGIN = bad;
        await expect(enableInspirationShare({ ownerId, analysisId: row.id })).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
      }
    } finally { env.APP_ORIGIN = origin; }
    const [stored] = await db.select().from(inspirationAnalyses).where(eq(inspirationAnalyses.id, row.id));
    expect(stored).toMatchObject({ shareId: null, version: row.version });
  });

  it("parses stored sources and result for public reads", async () => {
    const row = await create(); const shared = await enableInspirationShare({ ownerId, analysisId: row.id });
    await db.update(inspirationAnalyses).set({ sources: [{ index: 1, private: "secret" }] }).where(eq(inspirationAnalyses.id, row.id));
    await expect(getSharedInspirationAnalysis(shareId(shared.shareUrl))).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
  });
});
