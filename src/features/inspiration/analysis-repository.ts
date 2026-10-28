import "server-only";

import { and, desc, eq, getTableColumns, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { inspirationAnalyses as analyses } from "@/lib/db/schema";
import type { InspirationErrorCode } from "./contracts";
import type { InspirationCursor } from "./inspiration-cursor";
import type { InspirationProviderOutput } from "./qwen-provider";

export type AnalysisRow = typeof analyses.$inferSelect;
const owned = (ownerId: string, analysisId: string) => and(eq(analyses.ownerId, ownerId), eq(analyses.id, analysisId));
const changed = (now: Date) => ({ updatedAt: now, version: sql`${analyses.version} + 1` });

export async function createPendingAnalysisRow(input: {
  id: string; ownerId: string; operationId: string; prompt: string; title: string;
  searchModel: string; structureModel: string; now: Date;
}) {
  const { now, ...values } = input;
  const [row] = await db.insert(analyses).values({ ...values, status: "pending", createdAt: now, updatedAt: now }).returning();
  return row;
}

export async function findAnalysisByOperationRow(ownerId: string, operationId: string) {
  const [row] = await db.select().from(analyses).where(and(eq(analyses.ownerId, ownerId), eq(analyses.operationId, operationId))).limit(1);
  return row;
}

export async function failStalePendingRows(ownerId: string, cutoff: Date) {
  return db.update(analyses).set({ ...changed(new Date()), status: "failed", errorCode: "INSPIRATION_INTERRUPTED" })
    .where(and(eq(analyses.ownerId, ownerId), eq(analyses.status, "pending"), lt(analyses.updatedAt, cutoff))).returning();
}

// The attempt version prevents an old provider response from completing a newer retry.
export async function completePendingAnalysisRow(ownerId: string, analysisId: string, output: InspirationProviderOutput, now: Date, version: number) {
  const [row] = await db.update(analyses).set({ ...changed(now), ...output, status: "completed", completedAt: now, errorCode: null })
    .where(and(owned(ownerId, analysisId), eq(analyses.status, "pending"), eq(analyses.version, version))).returning();
  return row;
}

export async function failPendingAnalysisRow(ownerId: string, analysisId: string, errorCode: InspirationErrorCode, now: Date, version: number) {
  const [row] = await db.update(analyses).set({ ...changed(now), status: "failed", errorCode, result: null, completedAt: null })
    .where(and(owned(ownerId, analysisId), eq(analyses.status, "pending"), eq(analyses.version, version))).returning();
  return row;
}

export async function claimFailedAnalysisRetryRow(ownerId: string, analysisId: string, now: Date) {
  const [row] = await db.update(analyses).set({ ...changed(now), status: "pending", errorCode: null, result: null, sources: null, completedAt: null, searchRequestId: null, structureRequestId: null })
    .where(and(owned(ownerId, analysisId), eq(analyses.status, "failed"))).returning();
  return row;
}

const summaryColumns = (() => {
  const columns = getTableColumns(analyses);
  return {
    id: columns.id, title: columns.title, prompt: columns.prompt, status: columns.status,
    version: columns.version, createdAt: columns.createdAt, updatedAt: columns.updatedAt,
    completedAt: columns.completedAt, errorCode: columns.errorCode, shareId: columns.shareId,
  };
})();

export async function listAnalysisSummaryRows(ownerId: string, cursor: InspirationCursor | undefined, limitPlusOne: number) {
  return db.select({ ...summaryColumns, updatedCursorValue: sql<string>`to_char(${analyses.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(analyses).where(and(eq(analyses.ownerId, ownerId), cursor ? sql`(${analyses.updatedAt}, ${analyses.id}) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)` : undefined))
    .orderBy(desc(analyses.updatedAt), desc(analyses.id)).limit(limitPlusOne);
}

export async function getOwnedAnalysisRow(ownerId: string, analysisId: string) {
  const [row] = await db.select().from(analyses).where(owned(ownerId, analysisId)).limit(1);
  return row;
}

export async function renameAnalysisRow(ownerId: string, analysisId: string, version: number, title: string, now: Date) {
  const [row] = await db.update(analyses).set({ ...changed(now), title })
    .where(and(owned(ownerId, analysisId), ne(analyses.status, "pending"), eq(analyses.version, version))).returning();
  return row;
}

export async function deleteAnalysisRow(ownerId: string, analysisId: string) {
  const [row] = await db.delete(analyses).where(and(owned(ownerId, analysisId), ne(analyses.status, "pending"))).returning();
  return row;
}

export async function enableShareRow(ownerId: string, analysisId: string, shareId: string, now: Date, version: number) {
  const [row] = await db.update(analyses).set({ ...changed(now), shareId })
    .where(and(owned(ownerId, analysisId), eq(analyses.status, "completed"), eq(analyses.version, version), isNull(analyses.shareId))).returning();
  return row;
}

export async function disableShareRow(ownerId: string, analysisId: string, now: Date, version: number) {
  const [row] = await db.update(analyses).set({ ...changed(now), shareId: null })
    .where(and(owned(ownerId, analysisId), eq(analyses.status, "completed"), eq(analyses.version, version), isNotNull(analyses.shareId))).returning();
  return row;
}

// The sole unscoped read is an opaque share capability, constrained to completed rows.
export async function getSharedAnalysisRow(shareId: string) {
  const [row] = await db.select({ title: analyses.title, prompt: analyses.prompt, completedAt: analyses.completedAt, sources: analyses.sources, result: analyses.result })
    .from(analyses).where(and(eq(analyses.shareId, shareId), eq(analyses.status, "completed"))).limit(1);
  return row;
}
