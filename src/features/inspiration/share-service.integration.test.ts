import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, db } from "@/lib/db/client";
import { inspirationAnalyses, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";
import { getServerEnv } from "@/lib/env/server";
import { createInspirationAnalysis, deleteInspirationAnalysis } from "./analysis-service";
import { enableInspirationShare, disableInspirationShare, getSharedInspirationAnalysis } from "./share-service";
import { inspirationResultFixture, inspirationSourceFixture } from "./test-fixtures";

const provider = { analyze: async () => ({ sources: [inspirationSourceFixture], result: inspirationResultFixture, searchRequestId: "private-search", structureRequestId: "private-structure" }) };
describe("inspiration shares", () => {
  const ownerId = randomUUID(); const otherOwnerId = randomUUID();
  beforeEach(async () => {
    await resetDatabase();
    await db.insert(users).values([ownerId, otherOwnerId].map((id) => ({ id, email: `${id}@example.test`, displayName: "Designer", passwordHash: "hash", mustChangePassword: false })));
  });
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
