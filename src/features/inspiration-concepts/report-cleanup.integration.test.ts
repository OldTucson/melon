import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, db } from "@/lib/db/client";
import { users, inspirationAnalyses, assets, patterns } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";
import { deleteAnalysisWithObjectKeys } from "@/features/inspiration/analysis-repository";
import { inspirationReportCleanupManifests as manifestTable } from "@/lib/db/schema/inspiration-concepts";
import * as reportRepository from "./report-cleanup-repository";
import { deleteInspirationWithVisualAssets } from "@/features/inspiration-visuals/visual-service";
import { seedReportConcept } from "./integration-fixtures";
import { cleanupInspirationConceptObjects } from "./cleanup";
import type { ConceptCleanupStore } from "./object-store";

const day = 86_400_000;
describe("durable deleted report cleanup", () => {
  let ownerId: string, analysisId: string, now: Date, old: Date;
  let objects: Map<string, Date>, listed: string[], store: ConceptCleanupStore;
  const run = (dryRun = false) => cleanupInspirationConceptObjects({ now, dryRun, store });
  const manifests = () => db.execute(sql`select * from inspiration_report_cleanup_manifests order by analysis_id`);
  beforeEach(async () => {
    await resetDatabase(); ownerId = randomUUID(); analysisId = randomUUID();
    old = new Date(); now = new Date(old.getTime() + 2 * day);
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@example.test`, displayName: "Cleanup", passwordHash: "hash" });
    await db.insert(inspirationAnalyses).values({ id: analysisId, ownerId, operationId: randomUUID(), prompt: "Report", title: "Report", status: "completed", sources: [], result: {}, searchModel: "qwen-plus", structureModel: "qwen3.8-flash", completedAt: old });
    objects = new Map(); listed = [];
    store = {
      async listObjects(prefix) { listed.push(prefix); return [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, lastModified]) => ({ key, lastModified })); },
      async delete(keys) { keys.forEach((key) => objects.delete(key)); },
      async researchObjectLastModified(key) { return objects.get(key) ?? null; },
      async deleteResearchObjects(keys) { keys.forEach((key) => objects.delete(key)); },
    };
  });
  afterAll(closeDatabase);
  async function deletedReport(mode?: "fail" | "success" | "legacy") {
    const row = await seedReportConcept({ ownerId, analysisId });
    row.assets.forEach(({ objectKey }) => objects.set(objectKey, old));
    const conceptPrefix = `users/${ownerId}/inspiration/${analysisId}/concept-sets/${row.setId}/`;
    const researchPrefix = `users/${ownerId}/inspiration/${analysisId}/research/`;
    objects.set(`${conceptPrefix}flat/${randomUUID()}.png`, old);
    objects.set(`${researchPrefix}${randomUUID()}/${randomUUID()}.png`, old);
    if (mode === "legacy") await db.execute(sql`delete from inspiration_analyses where id = ${analysisId}::uuid`);
    else if (mode) {
      await deleteInspirationWithVisualAssets({ ownerId, analysisId }, { conceptStore: { async delete(keys) { if (mode === "fail") throw Error("offline"); await store.delete(keys); } } });
    } else await deleteAnalysisWithObjectKeys(ownerId, analysisId);
    return { ...row, conceptPrefix, researchPrefix };
  }
  it("recovers objects with no surviving rows after a crash before immediate cleanup", async () => {
    const row = await deletedReport();
    expect(await db.select().from(inspirationAnalyses)).toHaveLength(0);
    expect(await run()).toMatchObject({ failures: 0 });
    expect(objects.size).toBe(0);
    expect(new Set(listed)).toEqual(new Set([row.conceptPrefix, row.researchPrefix]));
    expect(await manifests()).toHaveLength(0);
  });
  it("recovers exact object scopes recorded by legacy SQL deletion", async () => {
    await deletedReport("legacy");
    expect(await manifests()).toHaveLength(1);
    expect(await run()).toMatchObject({ deletedReports: 1, deletedObjects: 3, deletedResearchObjects: 1, failures: 0 });
    expect(objects.size).toBe(0);
  });
  it("keeps the manifest after successful immediate snapshot cleanup until every orphan scope is empty", async () => {
    await deletedReport("success");
    expect(objects.size).toBe(2); expect(await manifests()).toHaveLength(1);
    expect(await run()).toMatchObject({ deletedReports: 1, deletedObjects: 1, deletedResearchObjects: 1, failures: 0 });
    expect(objects.size).toBe(0); expect(await manifests()).toHaveLength(0);
  });
  it("cleans every recorded set including tombstones and leaves failed deletion transactions intact", async () => {
    const first = await seedReportConcept({ ownerId, analysisId });
    const second = await seedReportConcept({ ownerId, analysisId, directionIndex: 1, deleted: true });
    for (const row of [first, second]) row.assets.forEach(({ objectKey }) => objects.set(objectKey, old));
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`delete from inspiration_analyses where id = ${analysisId}::uuid`);
      throw Error("abort deletion");
    })).rejects.toThrow("abort deletion");
    expect(await manifests()).toHaveLength(0); expect(await db.select().from(inspirationAnalyses)).toHaveLength(1);
    await deleteAnalysisWithObjectKeys(ownerId, analysisId);
    expect(await run()).toMatchObject({ deletedReports: 1, deletedObjects: 4, failures: 0 });
    expect(objects.size).toBe(0);
    expect(new Set(listed).size).toBe(3);
  });
  it("retains a manifest after partial acknowledged deletion throws, even when an object is already gone", async () => {
    await deletedReport(); const original = store.delete;
    store.delete = async (keys) => { objects.delete(keys[0]!); throw Error("partial acknowledgement"); };
    expect(await run()).toMatchObject({ failures: 1, deletedReports: 0 });
    expect(await manifests()).toHaveLength(1); expect(objects.size).toBe(2);
    store.delete = original;
    expect(await run()).toMatchObject({ failures: 0, deletedReports: 1 }); expect(objects.size).toBe(0);
  });
  it("recovers an immediate storage failure without treating snapshot deletion as completion", async () => {
    await deletedReport("fail");
    expect(objects.size).toBe(4); expect(await manifests()).toHaveLength(1);
    expect(await run()).toMatchObject({ deletedReports: 1, deletedObjects: 3, deletedResearchObjects: 1, failures: 0 });
    expect(objects.size).toBe(0); expect(await manifests()).toHaveLength(0);
  });
  it("leaves every database row, lease and object unchanged in dry-run", async () => {
    await deletedReport(); const saved = [...objects], before = await manifests();
    expect(await run(true)).toMatchObject({ scannedReports: 1, deletedReports: 0, deletedObjects: 0, deletedResearchObjects: 0, failures: 0 });
    expect(await manifests()).toEqual(before); expect([...objects]).toEqual(saved); expect(listed).toHaveLength(2);
  });
  it.each(["list", "research delete", "concept delete", "relist", "database complete", "database release"])("keeps a retryable manifest after %s failure", async (failure) => {
    await deletedReport(); const original = { ...store }; let calls = 0;
    if (failure === "list") store.listObjects = async () => { throw Error("offline"); };
    if (failure === "research delete") store.deleteResearchObjects = async () => { throw Error("missing acknowledgement"); };
    if (failure === "concept delete") store.delete = async () => { throw Error("missing acknowledgement"); };
    if (failure === "relist") store.listObjects = async (prefix) => { if (++calls === 2) throw Error("offline"); return original.listObjects(prefix); };
    const repo = { ...reportRepository };
    if (failure === "database complete") repo.completeReportCleanup = async () => { throw Error("database unavailable"); };
    if (failure === "database release") {
      store.listObjects = async () => { throw Error("offline"); };
      repo.releaseReportCleanup = async () => { throw Error("database unavailable"); };
    }
    expect(await cleanupInspirationConceptObjects({ now, dryRun: false, store, reportRepository: repo })).toMatchObject({ failures: 1, deletedReports: 0 });
    expect(await manifests()).toHaveLength(1);
    Object.assign(store, original);
    if (failure === "database release") now = new Date(now.getTime() + 31 * 60_000);
    expect(await run()).toMatchObject({ failures: 0, deletedReports: 1 });
    expect(objects.size).toBe(0); expect(await manifests()).toHaveLength(0);
  });
  it.each(["foreign owner", "foreign analysis", "malformed", "duplicate", "invalid time", "over limit", "foreign relist"])("rejects %s listings and retains the manifest", async (mode) => {
    const row = await deletedReport(); const original = store.listObjects; const researchKey = [...objects.keys()].find((key) => key.startsWith(row.researchPrefix))!;
    let calls = 0;
    store.listObjects = async (prefix) => {
      const valid = await original(prefix); calls++;
      const bad = { key: researchKey, lastModified: old };
      if (mode === "foreign owner" || mode === "foreign relist") bad.key = researchKey.replace(ownerId, randomUUID());
      if (mode === "foreign analysis") bad.key = researchKey.replace(analysisId, randomUUID());
      if (mode === "malformed") bad.key += "?token";
      if (mode === "invalid time") bad.lastModified = new Date("invalid");
      if (mode === "foreign relist" && calls === 1) return valid;
      if (mode === "over limit") return Array.from({ length: 10_001 }, () => bad);
      return [...valid, bad];
    };
    expect(await run()).toMatchObject({ failures: 1, deletedReports: 0 });
    expect(await manifests()).toHaveLength(1);
    expect(objects.size).toBe(mode === "foreign relist" ? 3 : 4);
  });
  it("preserves a nonempty acknowledged relisting and a fresh object until a later run", async () => {
    const row = await deletedReport(); const fresh = `${row.conceptPrefix}flat/${randomUUID()}.png`;
    objects.set(fresh, now);
    expect(await run()).toMatchObject({ deletedReports: 0, failures: 0 });
    expect([...objects.keys()]).toEqual([fresh]); expect(await manifests()).toHaveLength(1);
    now = new Date(now.getTime() + 2 * day);
    expect(await run()).toMatchObject({ deletedReports: 1, failures: 0 });
    expect(objects.size).toBe(0);
  });
  it("does not complete when deletion claims success but objects remain", async () => {
    await deletedReport(); store.delete = async () => {}; store.deleteResearchObjects = async () => {};
    expect(await run()).toMatchObject({ deletedReports: 0, failures: 0 });
    expect(objects.size).toBe(4); expect(await manifests()).toHaveLength(1);
  });
  it("never scans another owner, another report, an unrecorded set or saved pattern objects", async () => {
    const row = await deletedReport();
    const protectedKeys = [
      `${row.conceptPrefix.replace(ownerId, randomUUID())}sketch/${randomUUID()}.png`,
      `${row.conceptPrefix.replace(analysisId, randomUUID())}sketch/${randomUUID()}.png`,
      `${row.conceptPrefix.replace(row.setId, randomUUID())}sketch/${randomUUID()}.png`,
      `users/${ownerId}/patterns/${randomUUID()}/source/${randomUUID()}.png`,
    ];
    protectedKeys.forEach((key) => objects.set(key, old));
    expect(await run()).toMatchObject({ failures: 0, deletedReports: 1 });
    expect([...objects.keys()].sort()).toEqual(protectedKeys.sort());
    expect(new Set(listed)).toEqual(new Set([row.researchPrefix, row.conceptPrefix]));
  });
  it("preserves a surviving library alias inside the recorded report scope", async () => {
    const row = await deletedReport(); const key = row.assets[0]!.objectKey;
    const patternId = randomUUID();
    await db.insert(patterns).values({ id: patternId, ownerId, name: "Saved", originalFilename: "saved.png", extension: "png", sizeBytes: 1n, status: "ready" });
    await db.insert(assets).values({ id: randomUUID(), ownerId, patternId, role: "source", objectKey: key, originalFilename: "saved.png", sizeBytes: 1n });
    expect(await run()).toMatchObject({ failures: 0, deletedReports: 0 });
    expect([...objects.keys()]).toEqual([key]); expect(await manifests()).toHaveLength(1);
  });
  it("bounds a blocked manifest claim without holding storage I/O open", async () => {
    await deletedReport(); let unlock!: () => void, announce!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const held = new Promise<void>((resolve) => { announce = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(manifestTable).for("update"); announce(); await gate;
    });
    await held;
    const fallback = setTimeout(unlock, 6000);
    try {
      await expect(reportRepository.claimReportCleanup({ ownerId, analysisId, now, cutoff: new Date(now.getTime() - day) })).rejects.toThrow();
    } finally { clearTimeout(fallback); unlock(); await holder; }
    expect((await db.select().from(manifestTable))[0]!.leaseToken).toBeNull();
    expect(objects.size).toBe(4);
  }, 10_000);
  it("claims exclusively, rejects foreign or changed tokens and reclaims a crashed lease", async () => {
    await deletedReport(); const cutoff = new Date(now.getTime() - day);
    expect(await reportRepository.claimReportCleanup({ ownerId: randomUUID(), analysisId, now, cutoff })).toBeUndefined();
    const claims = await Promise.all([1, 2].map(() => reportRepository.claimReportCleanup({ ownerId, analysisId, now, cutoff })));
    const claim = claims.find(Boolean)!; expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await run()).toMatchObject({ scannedReports: 0 }); expect(objects.size).toBe(4);
    for (const wrong of [{ ...claim, ownerId: randomUUID() }, { ...claim, leaseToken: randomUUID() }, { ...claim, leaseUntil: new Date(claim.leaseUntil.getTime() + 1) }]) {
      expect(await reportRepository.completeReportCleanup(wrong, now)).toBe(false);
      expect(await reportRepository.releaseReportCleanup(wrong, now)).toBe(false);
    }
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await reportRepository.completeReportCleanup(claim, now)).toBe(false);
    const replacement = await reportRepository.claimReportCleanup({ ownerId, analysisId, now, cutoff });
    expect(replacement!.leaseToken).not.toBe(claim.leaseToken);
    expect(await reportRepository.releaseReportCleanup(claim, now)).toBe(false);
    expect(await reportRepository.releaseReportCleanup(replacement!, now)).toBe(true);
    expect(await run()).toMatchObject({ failures: 0, deletedReports: 1 });
  });
  it("retains authority when the lease expires during storage I/O", async () => {
    await deletedReport(); const original = store.listObjects; const clock = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(clock);
    store.listObjects = async (prefix) => { spy.mockReturnValue(clock + 31 * 60_000); return original(prefix); };
    try { expect(await run()).toMatchObject({ failures: 1, deletedReports: 0 }); }
    finally { spy.mockRestore(); store.listObjects = original; }
    expect(await manifests()).toHaveLength(1);
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await run()).toMatchObject({ failures: 0, deletedReports: 1 });
  });
  it("requires all exact scopes empty before completion and respects 25-report batches", async () => {
    await deletedReport();
    await db.insert(manifestTable).values(Array.from({ length: 25 }, () => ({ ownerId, analysisId: randomUUID(), setIds: [], createdAt: old })));
    expect(await run()).toMatchObject({ scannedReports: 25, deletedReports: 25, failures: 0 });
    expect(await manifests()).toHaveLength(1);
    expect(await run()).toMatchObject({ scannedReports: 1, deletedReports: 1, failures: 0 });
    expect(await manifests()).toHaveLength(0); expect(objects.size).toBe(0);
  });
  it("does not claim an active report or a report deleted less than 24 hours ago", async () => {
    await db.execute(sql`select capture_inspiration_report_cleanup(${ownerId}::uuid, ${analysisId}::uuid)`);
    expect(await run()).toMatchObject({ scannedReports: 0 });
    await deletedReport(); now = new Date(old.getTime() + 60_000);
    expect(await run()).toMatchObject({ scannedReports: 0 }); expect(objects.size).toBe(4);
  });
  it("merges captures idempotently before cascades and survives later owner deletion", async () => {
    const first = await seedReportConcept({ ownerId, analysisId });
    await db.execute(sql`select capture_inspiration_report_cleanup(${ownerId}::uuid, ${analysisId}::uuid)`);
    const second = await seedReportConcept({ ownerId, analysisId, directionIndex: 1 });
    await db.execute(sql`select capture_inspiration_report_cleanup(${ownerId}::uuid, ${analysisId}::uuid)`);
    await deleteAnalysisWithObjectKeys(ownerId, analysisId);
    await db.delete(users).where(eq(users.id, ownerId));
    const rows = await db.select().from(manifestTable);
    expect(rows).toHaveLength(1); expect(rows[0]!.setIds.sort()).toEqual([first.setId, second.setId].sort());
  });
  it("captures scopes before direct user deletion can cascade sets first", async () => {
    const first = await seedReportConcept({ ownerId, analysisId });
    await db.delete(users).where(eq(users.id, ownerId));
    expect(await db.select().from(manifestTable)).toMatchObject([{ ownerId, analysisId, setIds: [first.setId] }]);
    expect(await db.select().from(inspirationAnalyses)).toHaveLength(0);
  });

});
