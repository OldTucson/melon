import { z } from "zod";

import type { AppErrorCode } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";
import { hasNoNullByte } from "@/lib/validation/text";

const displayText = (max: number) =>
  z.string().trim().min(1).max(max).refine(hasNoNullByte);
const normalizedText = (min: number, max: number) =>
  z.string().trim().transform((value) => value.normalize("NFC"))
    .pipe(z.string().min(min).max(max).refine(hasNoNullByte));
const promptSchema = normalizedText(5, 1000);
const titleSchema = normalizedText(1, 120);
const sourceIndexesSchema = z.array(z.number().int().min(1).max(100)).max(20);
const cursorSchema = z.string().min(1).max(2048).refine(hasNoNullByte);
const versionSchema = z.number().int().nonnegative();
const httpUrlSchema = z.string().url().max(2048).refine((value) => {
  const parsed = URL.parse(value);
  return parsed !== null && ["http:", "https:"].includes(parsed.protocol) && parsed.username === "" && parsed.password === "";
});

export const inspirationCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  prompt: promptSchema,
}).strict();

export const inspirationListQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const inspirationPatchMutationSchema = z.object({
  title: titleSchema,
  version: versionSchema,
}).strict();

export const trendFacetSchema = z.object({
  name: displayText(80),
  rationale: displayText(500),
  strength: z.enum(["high", "medium", "emerging"]),
  sourceIndexes: sourceIndexesSchema,
}).strict();

export const colorFacetSchema = trendFacetSchema.extend({
  colorHint: z.string().regex(/^#[0-9A-F]{6}$/).nullable(),
}).strict();

export const referenceLookSchema = z.object({
  name: displayText(80),
  sourceKind: z.enum(["product", "ranking", "trend_article", "other"]),
  whyRelevant: displayText(500),
  sourceIndexes: sourceIndexesSchema,
}).strict();

export const inspirationPromptSchema = z.object({
  title: titleSchema,
  direction: displayText(500),
  silhouette: displayText(300),
  palette: z.array(displayText(80)).max(8),
  materials: z.array(displayText(80)).max(8),
  details: z.array(displayText(300)).max(8),
  sourceIndexes: sourceIndexesSchema,
}).strict();

export const inspirationAnalysisResultSchema = z.object({
  schemaVersion: z.literal("inspiration-analysis-v1"),
  headline: displayText(120),
  summary: displayText(2000),
  confidenceNote: displayText(1000),
  marketSignals: z.array(trendFacetSchema).max(8),
  dimensions: z.object({
    silhouettes: z.array(trendFacetSchema).max(8),
    productTypes: z.array(trendFacetSchema).max(8),
    styles: z.array(trendFacetSchema).max(8),
    categories: z.array(trendFacetSchema).max(8),
    colors: z.array(colorFacetSchema).max(8),
    materials: z.array(trendFacetSchema).max(8),
  }).strict(),
  referenceLooks: z.array(referenceLookSchema).max(12),
  inspirationPrompts: z.array(inspirationPromptSchema).min(3).max(5),
}).strict();

export const inspirationAnalysisJsonSchema = z.toJSONSchema(
  inspirationAnalysisResultSchema,
  { target: "draft-07" },
);

export const inspirationSourceSchema = z.object({
  index: z.number().int().min(1).max(100),
  title: displayText(300),
  url: httpUrlSchema,
  siteName: displayText(120).nullable(),
}).strict();

export const inspirationSourcesSchema = z.array(inspirationSourceSchema).max(20).superRefine((sources, context) => {
  if (new Set(sources.map((source) => source.index)).size !== sources.length) {
    context.addIssue({ code: "custom", message: "duplicate source index" });
  }
});

export const inspirationErrorCodes = [
  "INSPIRATION_DISABLED",
  "INSPIRATION_INVALID_INPUT",
  "INSPIRATION_BUSY",
  "INSPIRATION_SEARCH_TIMEOUT",
  "INSPIRATION_SEARCH_EMPTY",
  "INSPIRATION_SEARCH_UNAVAILABLE",
  "INSPIRATION_STRUCTURE_TIMEOUT",
  "INSPIRATION_STRUCTURE_INVALID",
  "INSPIRATION_STRUCTURE_UNAVAILABLE",
  "INSPIRATION_INTERRUPTED",
  "INSPIRATION_NOT_FOUND",
] as const satisfies readonly AppErrorCode[];
export const inspirationErrorCodeSchema = z.enum(inspirationErrorCodes);
export const inspirationStatusSchema = z.enum(["pending", "completed", "failed"]);

export const inspirationSummaryDtoSchema = z.object({
  id: z.string().uuid(),
  title: titleSchema,
  prompt: promptSchema,
  status: inspirationStatusSchema,
  version: versionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  errorCode: inspirationErrorCodeSchema.nullable(),
  shareUrl: httpUrlSchema.nullable(),
}).strict();

export const inspirationDetailDtoSchema = inspirationSummaryDtoSchema.extend({
  sources: inspirationSourcesSchema.nullable(),
  result: inspirationAnalysisResultSchema.nullable(),
}).strict();

export const inspirationSharedDtoSchema = z.object({
  title: titleSchema,
  prompt: promptSchema,
  completedAt: z.string().datetime(),
  sources: inspirationSourcesSchema,
  result: inspirationAnalysisResultSchema,
}).strict();

export const inspirationListDtoSchema = z.object({
  items: z.array(inspirationSummaryDtoSchema).max(100),
  nextCursor: cursorSchema.nullable(),
}).strict();

export type InspirationCreateMutationInput = z.input<typeof inspirationCreateMutationSchema>;
export type InspirationCreateMutation = z.output<typeof inspirationCreateMutationSchema>;
export type InspirationListQueryInput = z.input<typeof inspirationListQuerySchema>;
export type InspirationListQuery = z.output<typeof inspirationListQuerySchema>;
export type InspirationPatchMutationInput = z.input<typeof inspirationPatchMutationSchema>;
export type InspirationPatchMutation = z.output<typeof inspirationPatchMutationSchema>;
export type TrendStrength = z.output<typeof trendFacetSchema>["strength"];
export type TrendFacet = z.output<typeof trendFacetSchema>;
export type ColorFacet = z.output<typeof colorFacetSchema>;
export type ReferenceLook = z.output<typeof referenceLookSchema>;
export type InspirationPrompt = z.output<typeof inspirationPromptSchema>;
export type InspirationAnalysisResult = z.output<typeof inspirationAnalysisResultSchema>;
export type InspirationSource = z.output<typeof inspirationSourceSchema>;
export type InspirationSources = z.output<typeof inspirationSourcesSchema>;
export type InspirationSummaryDto = z.output<typeof inspirationSummaryDtoSchema>;
export type InspirationDetailDto = z.output<typeof inspirationDetailDtoSchema>;
export type InspirationSharedDto = z.output<typeof inspirationSharedDtoSchema>;
export type InspirationListDto = z.output<typeof inspirationListDtoSchema>;
export type InspirationErrorCode = z.output<typeof inspirationErrorCodeSchema>;
export type InspirationStatus = z.output<typeof inspirationStatusSchema>;
