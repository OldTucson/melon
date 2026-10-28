import { z } from "zod";

import { hasNoNullByte } from "@/lib/validation/text";

import {
  inspirationAnalysisJsonSchema,
  inspirationAnalysisResultSchema,
  inspirationSourcesSchema,
  type InspirationAnalysisResult,
  type InspirationErrorCode,
  type InspirationSources,
} from "./contracts";
import { QWEN_SEARCH_SYSTEM_PROMPT, QWEN_STRUCTURE_SYSTEM_PROMPT } from "./qwen-prompts";

type ProtocolErrorCode = Extract<InspirationErrorCode,
  "INSPIRATION_SEARCH_EMPTY" | "INSPIRATION_SEARCH_UNAVAILABLE" | "INSPIRATION_STRUCTURE_INVALID"
>;

export class QwenProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode) {
    super("Invalid inspiration provider response");
    this.name = "QwenProtocolError";
  }
}

export type QwenSearchStageResult = {
  searchText: string;
  sources: InspirationSources;
  requestId: string;
};

export type QwenStructureStageResult = {
  result: InspirationAnalysisResult;
  requestId: string;
};

const boundedText = (max: number) => z.string().trim().min(1).max(max).refine(hasNoNullByte);
const contentSchema = boundedText(128_000);
const requestIdSchema = boundedText(200);
const choicesSchema = z.array(z.unknown()).min(1).max(8);
const rawSourcesSchema = z.array(z.unknown()).min(1).max(20);
const searchStageSchema = z.object({
  searchText: contentSchema,
  sources: inspirationSourcesSchema,
  requestId: requestIdSchema,
}).strict();
const completionSchema = z.object({
  content: contentSchema,
  requestId: requestIdSchema,
}).strict();

// Project only fields we consume; provider usage, timing, icons, etc. are not contracts.
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

export function buildQwenSearchRequest({ prompt, model }: { prompt: string; model: string }) {
  return {
    model,
    input: { messages: [
      { role: "system", content: QWEN_SEARCH_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ] },
    parameters: {
      enable_search: true,
      result_format: "message",
      search_options: {
        search_strategy: "turbo",
        forced_search: true,
        freshness: 30,
        enable_source: true,
        enable_citation: true,
        citation_format: "[ref_<number>]",
      },
    },
  };
}

export function buildQwenStructureRequest({ prompt, searchText, sources, model }: {
  prompt: string;
  searchText: string;
  sources: InspirationSources;
  model: string;
}) {
  return {
    model,
    enable_thinking: false,
    messages: [
      { role: "system", content: QWEN_STRUCTURE_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({
        prompt,
        searchText,
        sources: sources.map(({ index, title, siteName }) => ({ index, title, siteName })),
      }) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "inspiration_analysis_v1", strict: true, schema: inspirationAnalysisJsonSchema },
    },
  };
}

export function parseQwenSearchResponse(value: unknown): QwenSearchStageResult {
  try {
    const output = field(value, "output");
    const choices = choicesSchema.parse(field(output, "choices"));
    const searchText = field(field(choices[0], "message"), "content");
    const rawSources = field(field(output, "search_info"), "search_results");
    if (
      searchText === undefined || searchText === null ||
      (typeof searchText === "string" && searchText.trim() === "") ||
      rawSources === undefined || rawSources === null ||
      (Array.isArray(rawSources) && rawSources.length === 0)
    ) {
      throw new QwenProtocolError("INSPIRATION_SEARCH_EMPTY");
    }
    const sources = rawSourcesSchema.parse(rawSources).map((source) => ({
      index: field(source, "index"),
      title: field(source, "title"),
      url: field(source, "url"),
      siteName: field(source, "site_name") ?? null,
    }));
    return searchStageSchema.parse({ searchText, sources, requestId: field(value, "request_id") });
  } catch (error) {
    if (error instanceof QwenProtocolError) throw error;
    throw new QwenProtocolError("INSPIRATION_SEARCH_UNAVAILABLE");
  }
}

export function parseQwenStructureResponse(value: unknown, sources: InspirationSources): QwenStructureStageResult {
  try {
    const choices = choicesSchema.parse(field(value, "choices"));
    const completion = completionSchema.parse({
      content: field(field(choices[0], "message"), "content"),
      requestId: field(value, "id"),
    });
    const result = inspirationAnalysisResultSchema.parse(JSON.parse(completion.content));
    const validIndexes = new Set(inspirationSourcesSchema.parse(sources).map((source) => source.index));
    const supportedIndexes = (indexes: number[]) => [...new Set(indexes.filter((index) => validIndexes.has(index)))];
    const factual = <T extends { sourceIndexes: number[] }>(items: T[]) => items
      .map((item) => ({ ...item, sourceIndexes: supportedIndexes(item.sourceIndexes) }))
      .filter((item) => item.sourceIndexes.length > 0);

    return {
      requestId: completion.requestId,
      result: {
        ...result,
        marketSignals: factual(result.marketSignals),
        dimensions: {
          silhouettes: factual(result.dimensions.silhouettes),
          productTypes: factual(result.dimensions.productTypes),
          styles: factual(result.dimensions.styles),
          categories: factual(result.dimensions.categories),
          colors: factual(result.dimensions.colors),
          materials: factual(result.dimensions.materials),
        },
        referenceLooks: factual(result.referenceLooks),
        inspirationPrompts: result.inspirationPrompts.map((prompt) => ({ ...prompt, sourceIndexes: supportedIndexes(prompt.sourceIndexes) })),
      },
    };
  } catch {
    throw new QwenProtocolError("INSPIRATION_STRUCTURE_INVALID");
  }
}
