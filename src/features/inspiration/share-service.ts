import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { inspirationAnalyses, inspirationVisualAssets as visualAssets, inspirationVisualJobs as visualJobs } from "@/lib/db/schema";
import { publicInspirationVisualBoardDtoSchema } from "@/features/inspiration-visuals/contracts";
import { composePublicInspirationDocument } from "@/features/inspiration-visuals/document-composer";
import { inspirationSharedDocumentDtoSchema } from "@/features/inspiration-visuals/document-contracts";
import { inspirationSharedDtoSchema } from "./contracts";
import { disableShareRow, enableShareRow, getSharedAnalysisRow } from "./analysis-repository";
import {
  inspirationBusy, inspirationIdentitySchema, inspirationNotFound, inspirationShareUrl,
  parseInspirationInput, parseInspirationStored, requireOwnedInspiration, toInspirationDetail,
  type InspirationIdentity,
} from "./analysis-service";

export async function enableInspirationShare(input: InspirationIdentity) {
  const { ownerId, analysisId } = parseInspirationInput(inspirationIdentitySchema, input);
  const existing = await requireOwnedInspiration(ownerId, analysisId);
  if (existing.status !== "completed") throw inspirationBusy();
  if (existing.shareId) return toInspirationDetail(existing);
  const shareId = randomUUID();
  inspirationShareUrl(shareId); // Reject invalid origin configuration before writing.
  const changed = await enableShareRow(ownerId, analysisId, shareId, new Date(), existing.version);
  const row = changed ?? await requireOwnedInspiration(ownerId, analysisId);
  if (row.status !== "completed" || !row.shareId) throw inspirationBusy();
  return toInspirationDetail(row);
}

export async function disableInspirationShare(input: InspirationIdentity) {
  const { ownerId, analysisId } = parseInspirationInput(inspirationIdentitySchema, input);
  const existing = await requireOwnedInspiration(ownerId, analysisId);
  if (existing.status === "pending") throw inspirationBusy();
  if (!existing.shareId) return toInspirationDetail(existing);
  const changed = await disableShareRow(ownerId, analysisId, new Date(), existing.version);
  const row = changed ?? await requireOwnedInspiration(ownerId, analysisId);
  if (row.status === "pending" || row.shareId) throw inspirationBusy();
  return toInspirationDetail(row);
}

export async function getSharedInspirationAnalysis(shareId: string) {
  const parsed = z.string().uuid().safeParse(shareId);
  if (!parsed.success) throw inspirationNotFound();
  const row = await getSharedAnalysisRow(parsed.data);
  if (!row) throw inspirationNotFound();
  return parseInspirationStored(inspirationSharedDtoSchema, { ...row, completedAt: row.completedAt?.toISOString() });
}

/** Public page content only. Keep the legacy text DTO available until its UI migrates. */
export async function getSharedInspirationDocument(shareId: string) {
  // The existing capability read validates both the token and stored text.
  await getSharedInspirationAnalysis(shareId);
  const activeJobs = alias(visualJobs, "shared_document_active_jobs");
  const activeJob = db.select({ id: activeJobs.id }).from(activeJobs)
    .where(and(
      eq(activeJobs.ownerId, inspirationAnalyses.ownerId),
      eq(activeJobs.analysisId, inspirationAnalyses.id),
      eq(activeJobs.kind, "research_visuals"),
      eq(activeJobs.status, "completed"),
    ))
    .orderBy(desc(activeJobs.createdAt), desc(activeJobs.id))
    .limit(1);
  // Project only public display fields. Never load library matches or storage/provider metadata.
  const webEvidence = await db.select({
    id: visualAssets.id, kind: visualAssets.kind, ordinal: visualAssets.ordinal,
    title: visualAssets.title, altText: visualAssets.altText,
    role: visualAssets.documentRole, sourceIndexes: visualAssets.sourceIndexes,
    brand: visualAssets.brand, productName: visualAssets.productName, priceText: visualAssets.priceText,
    sourcePageUrl: visualAssets.sourcePageUrl, sourceSiteName: visualAssets.sourceSiteName,
    sourceQuery: visualAssets.sourceQuery, width: visualAssets.width, height: visualAssets.height,
  }).from(visualAssets)
    .innerJoin(visualJobs, and(
      eq(visualJobs.id, visualAssets.jobId), eq(visualJobs.ownerId, visualAssets.ownerId),
      eq(visualJobs.analysisId, visualAssets.analysisId), eq(visualJobs.kind, "research_visuals"),
      eq(visualJobs.status, "completed"),
    ))
    .innerJoin(inspirationAnalyses, and(
      eq(inspirationAnalyses.id, visualJobs.analysisId), eq(inspirationAnalyses.ownerId, visualJobs.ownerId),
      eq(inspirationAnalyses.shareId, shareId), eq(inspirationAnalyses.status, "completed"),
    ))
    .where(and(eq(visualJobs.id, activeJob), eq(visualAssets.kind, "web_evidence")));
  const visuals = parseInspirationStored(publicInspirationVisualBoardDtoSchema, {
    webEvidence: webEvidence.map((asset) => ({ ...asset, imageUrl: `/share/inspiration/${shareId}/assets/${asset.id}` })),
    // Concept generation and concept byte routes are disabled in phase one.
    concepts: [],
  });
  // Recheck the capability after the visual read so concurrent revocation cannot return stale text.
  const text = await getSharedInspirationAnalysis(shareId);
  return parseInspirationStored(inspirationSharedDocumentDtoSchema, {
    title: text.title, prompt: text.prompt, completedAt: text.completedAt,
    document: composePublicInspirationDocument({
      shareId, result: text.result, sources: text.sources, ...visuals,
    }),
  });
}
