import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import {
  inspirationAnalysisResultSchema, inspirationCreateMutationSchema, inspirationDetailDtoSchema,
  inspirationErrorCodeSchema, inspirationListDtoSchema, inspirationListQuerySchema,
  inspirationPatchMutationSchema, inspirationSourcesSchema, inspirationSummaryDtoSchema,
  type InspirationCreateMutationInput, type InspirationListQueryInput, type InspirationPatchMutationInput,
} from "./contracts";
import * as repository from "./analysis-repository";
import { decodeInspirationCursor, encodeInspirationCursor } from "./inspiration-cursor";
import { getQwenInspirationProvider, type InspirationProvider, type InspirationProviderOutput } from "./qwen-provider";

export const inspirationNotFound = () => new AppError("INSPIRATION_NOT_FOUND", 404, "Inspiration analysis not found");
export const inspirationBusy = () => new AppError("INSPIRATION_BUSY", 409, "Inspiration analysis state changed or is busy");
const internalError = () => new AppError("INTERNAL_ERROR", 500, "Inspiration operation failed");

export function parseInspirationInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError("INSPIRATION_INVALID_INPUT", 400, "Invalid inspiration input");
  return parsed.data;
}

export function parseInspirationStored<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw internalError();
  return parsed.data;
}

export const inspirationIdentitySchema = z.object({ ownerId: z.string().uuid(), analysisId: z.string().uuid() }).strict();
export type InspirationIdentity = z.infer<typeof inspirationIdentitySchema>;

export function inspirationShareUrl(shareId: string) {
  try {
    const origin = new URL(getServerEnv().APP_ORIGIN);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error();
    return new URL(`/share/inspiration/${encodeURIComponent(shareId)}`, origin.origin).href;
  } catch { throw internalError(); }
}

type SummaryRow = Pick<repository.AnalysisRow, "id" | "title" | "prompt" | "status" | "version" | "createdAt" | "updatedAt" | "completedAt" | "errorCode" | "shareId">;
function toSummary(row: SummaryRow) {
  return parseInspirationStored(inspirationSummaryDtoSchema, {
    id: row.id, title: row.title, prompt: row.prompt, status: row.status, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null, errorCode: row.errorCode,
    shareUrl: row.shareId ? inspirationShareUrl(row.shareId) : null,
  });
}

export function toInspirationDetail(row: repository.AnalysisRow) {
  return parseInspirationStored(inspirationDetailDtoSchema, { ...toSummary(row), sources: row.sources, result: row.result });
}

export async function requireOwnedInspiration(ownerId: string, analysisId: string) {
  const row = await repository.getOwnedAnalysisRow(ownerId, analysisId);
  if (!row) throw inspirationNotFound();
  return row;
}

// Drizzle wraps postgres-js errors in cause; never classify an unnamed uniqueness violation as busy.
function uniqueViolation(error: unknown): { constraint?: string } | undefined {
  let candidate = error;
  const seen = new Set<unknown>();
  while (typeof candidate === "object" && candidate !== null && !seen.has(candidate)) {
    seen.add(candidate);
    if ("code" in candidate && candidate.code === "23505") {
      return { constraint: "constraint_name" in candidate && typeof candidate.constraint_name === "string" ? candidate.constraint_name : undefined };
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }
}

const repairStale = (ownerId: string) => repository.failStalePendingRows(ownerId, new Date(Date.now() - 3 * 60_000));
function replay(row: repository.AnalysisRow, prompt: string) {
  if (row.prompt !== prompt) throw new AppError("OPERATION_ID_REUSED", 409, "Operation ID was already used");
  return toInspirationDetail(row);
}

async function runAttempt(row: repository.AnalysisRow, provider?: InspirationProvider) {
  let output: InspirationProviderOutput;
  try {
    const response = await (provider ?? getQwenInspirationProvider()).analyze({ prompt: row.prompt, signal: new AbortController().signal });
    const sources = inspirationSourcesSchema.safeParse(response.sources);
    const result = inspirationAnalysisResultSchema.safeParse(response.result);
    if (!sources.success || !result.success) throw new AppError("INSPIRATION_STRUCTURE_INVALID", 502, "Invalid inspiration output");
    output = { sources: sources.data, result: result.data, searchRequestId: response.searchRequestId, structureRequestId: response.structureRequestId };
  } catch (error) {
    const stable = error instanceof AppError && inspirationErrorCodeSchema.safeParse(error.code).success
      ? { code: inspirationErrorCodeSchema.parse(error.code), status: error.status }
      : { code: "INSPIRATION_SEARCH_UNAVAILABLE" as const, status: 503 };
    await repository.failPendingAnalysisRow(row.ownerId, row.id, stable.code, new Date(), row.version);
    throw new AppError(stable.code, stable.status, "Inspiration analysis failed", { analysisId: row.id });
  }
  // Provider work is finished before any persistence; every statement autocommits.
  const completed = await repository.completePendingAnalysisRow(row.ownerId, row.id, output, new Date(), row.version);
  if (!completed) {
    await requireOwnedInspiration(row.ownerId, row.id);
    throw inspirationBusy();
  }
  return toInspirationDetail(completed);
}

export async function createInspirationAnalysis(input: InspirationCreateMutationInput & { ownerId: string }, provider?: InspirationProvider) {
  const parsed = parseInspirationInput(inspirationCreateMutationSchema.extend({ ownerId: z.string().uuid() }), input);
  await repairStale(parsed.ownerId);
  const existing = await repository.findAnalysisByOperationRow(parsed.ownerId, parsed.operationId);
  if (existing) return replay(existing, parsed.prompt);
  let row: repository.AnalysisRow | undefined;
  try {
    const env = getServerEnv();
    row = await repository.createPendingAnalysisRow({ ...parsed, id: randomUUID(), title: [...parsed.prompt].slice(0, 30).join(""), searchModel: env.INSPIRATION_SEARCH_MODEL, structureModel: env.INSPIRATION_STRUCTURE_MODEL, now: new Date() });
  } catch (error) {
    const unique = uniqueViolation(error);
    if (unique) {
      const winner = await repository.findAnalysisByOperationRow(parsed.ownerId, parsed.operationId);
      if (winner) return replay(winner, parsed.prompt);
      if (unique.constraint === "inspiration_analyses_owner_pending_unique") throw inspirationBusy();
    }
    throw internalError();
  }
  if (!row) throw internalError();
  return runAttempt(row, provider);
}

export async function retryInspirationAnalysis(input: InspirationIdentity, provider?: InspirationProvider) {
  const { ownerId, analysisId } = parseInspirationInput(inspirationIdentitySchema, input);
  let row: repository.AnalysisRow | undefined;
  try { row = await repository.claimFailedAnalysisRetryRow(ownerId, analysisId, new Date()); }
  catch (error) {
    if (uniqueViolation(error)?.constraint === "inspiration_analyses_owner_pending_unique") throw inspirationBusy();
    throw internalError();
  }
  if (!row) { await requireOwnedInspiration(ownerId, analysisId); throw inspirationBusy(); }
  return runAttempt(row, provider);
}

export async function listInspirationAnalyses(input: InspirationListQueryInput & { ownerId: string }) {
  const parsed = parseInspirationInput(inspirationListQuerySchema.extend({ ownerId: z.string().uuid() }), input);
  const cursor = parsed.cursor ? decodeInspirationCursor(parsed.cursor) : undefined;
  await repairStale(parsed.ownerId);
  const rows = await repository.listAnalysisSummaryRows(parsed.ownerId, cursor, parsed.limit + 1);
  const items = rows.slice(0, parsed.limit);
  const last = items.at(-1);
  return parseInspirationStored(inspirationListDtoSchema, {
    items: items.map(toSummary),
    nextCursor: rows.length > parsed.limit && last ? encodeInspirationCursor({ updatedAt: last.updatedCursorValue, id: last.id }) : null,
  });
}

export async function getInspirationAnalysis(input: InspirationIdentity) {
  const { ownerId, analysisId } = parseInspirationInput(inspirationIdentitySchema, input);
  await repairStale(ownerId);
  return toInspirationDetail(await requireOwnedInspiration(ownerId, analysisId));
}

export async function renameInspirationAnalysis(input: InspirationIdentity & InspirationPatchMutationInput) {
  const { ownerId, analysisId, title, version } = parseInspirationInput(inspirationPatchMutationSchema.extend(inspirationIdentitySchema.shape), input);
  const row = await repository.renameAnalysisRow(ownerId, analysisId, version, title, new Date());
  if (!row) { await requireOwnedInspiration(ownerId, analysisId); throw inspirationBusy(); }
  return toInspirationDetail(row);
}

export async function deleteInspirationAnalysis(input: InspirationIdentity) {
  const { ownerId, analysisId } = parseInspirationInput(inspirationIdentitySchema, input);
  const row = await repository.deleteAnalysisRow(ownerId, analysisId);
  if (!row) { await requireOwnedInspiration(ownerId, analysisId); throw inspirationBusy(); }
  return { id: row.id, deleted: true as const };
}
