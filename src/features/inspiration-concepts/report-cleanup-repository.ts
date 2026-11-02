import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db, type DbTransaction } from "@/lib/db/client";
import { inspirationReportCleanupManifests as manifests, type InspirationReportCleanupManifestRow } from "@/lib/db/schema/inspiration-concepts";

export type ReportCleanupIdentity = Pick<InspirationReportCleanupManifestRow, "ownerId" | "analysisId">;
export type ReportCleanupClaim = InspirationReportCleanupManifestRow & { leaseToken: string; leaseUntil: Date };
export const REPORT_CLEANUP_LEASE_MS = 30 * 60_000;
const identity = (input: ReportCleanupIdentity) => and(eq(manifests.ownerId, input.ownerId), eq(manifests.analysisId, input.analysisId));
const reportAbsent = sql`not exists (select 1 from inspiration_analyses where id = ${manifests.analysisId})`;
const eligible = (now: Date, cutoff: Date) => and(lt(manifests.createdAt, cutoff), or(isNull(manifests.leaseUntil), lt(manifests.leaseUntil, now)), reportAbsent);
const exactClaim = (claim: ReportCleanupClaim, now: Date) => and(identity(claim), eq(manifests.leaseToken, claim.leaseToken), eq(manifests.leaseUntil, claim.leaseUntil), gt(manifests.leaseUntil, now), reportAbsent);

async function boundedQuery<T>(query: (tx: DbTransaction) => PromiseLike<T>, readOnly = false): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '10s'`);
    return query(tx);
  }, readOnly ? { accessMode: "read only" } : undefined);
}

/** Listing is read-only, bounded and fair across successfully attempted manifests. */
export async function listReportCleanupCandidates(input: { now: Date; cutoff: Date }) {
  return boundedQuery((tx) => tx.select().from(manifests).where(eligible(input.now, input.cutoff))
    .orderBy(sql`${manifests.lastAttemptAt} asc nulls first`, asc(manifests.createdAt), asc(manifests.analysisId)).limit(25), true);
}
/** Commit the lease before object I/O; process death leaves an expiring claim. */
export async function claimReportCleanup(input: ReportCleanupIdentity & { now: Date; cutoff: Date }): Promise<ReportCleanupClaim | undefined> {
  const [row] = await boundedQuery((tx) => tx.update(manifests).set({ leaseToken: randomUUID(), leaseUntil: new Date(input.now.getTime() + REPORT_CLEANUP_LEASE_MS), lastAttemptAt: input.now })
    .where(and(identity(input), eligible(input.now, input.cutoff))).returning());
  return row?.leaseToken && row.leaseUntil ? { ...row, leaseToken: row.leaseToken, leaseUntil: row.leaseUntil } : undefined;
}
/** Caller must have authoritatively listed every exact scope empty. */
export async function completeReportCleanup(claim: ReportCleanupClaim, now: Date) {
  return (await boundedQuery((tx) => tx.delete(manifests).where(exactClaim(claim, now)).returning({ id: manifests.analysisId }))).length === 1;
}
export async function releaseReportCleanup(claim: ReportCleanupClaim, now: Date) {
  return (await boundedQuery((tx) => tx.update(manifests).set({ leaseToken: null, leaseUntil: null })
    .where(exactClaim(claim, now)).returning({ id: manifests.analysisId }))).length === 1;
}

/** Preserve surviving library/current aliases even if historical data reused a key. */
export async function reportCleanupProtectedKeys(prefix: string) {
  // Prefixes have been canonicalized by the cleanup service; escape SQL wildcards anyway.
  const pattern = prefix.replace(/[\\%_]/g, "\\$&") + "%";
  const rows = await boundedQuery((tx) => tx.execute<{ key: string }>(sql`
    select object_key as key from assets where object_key like ${pattern}
    union select object_key as key from inspiration_concept_outputs where object_key like ${pattern}
    union select object_key as key from inspiration_visual_assets where object_key like ${pattern}
    limit 10001`), true);
  if (rows.length > 10_000) throw Error("Cleanup reference limit");
  return new Set(rows.map(({ key }) => key));
}
