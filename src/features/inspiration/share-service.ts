import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
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
  const changed = await enableShareRow(ownerId, analysisId, shareId, new Date());
  const row = changed ?? await requireOwnedInspiration(ownerId, analysisId);
  if (row.status !== "completed" || !row.shareId) throw inspirationBusy();
  return toInspirationDetail(row);
}

export async function disableInspirationShare(input: InspirationIdentity) {
  const { ownerId, analysisId } = parseInspirationInput(inspirationIdentitySchema, input);
  const existing = await requireOwnedInspiration(ownerId, analysisId);
  if (existing.status === "pending") throw inspirationBusy();
  if (!existing.shareId) return toInspirationDetail(existing);
  const changed = await disableShareRow(ownerId, analysisId, new Date());
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
