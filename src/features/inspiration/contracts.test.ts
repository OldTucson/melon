import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  colorFacetSchema,
  inspirationAnalysisJsonSchema,
  inspirationAnalysisResultSchema,
  inspirationCreateMutationSchema,
  inspirationDetailDtoSchema,
  inspirationListDtoSchema,
  inspirationListQuerySchema,
  inspirationPatchMutationSchema,
  inspirationSharedDtoSchema,
  inspirationSourceSchema,
  inspirationSourcesSchema,
  inspirationSummaryDtoSchema,
  trendFacetSchema,
} from "./contracts";
import {
  inspirationDetailFixture,
  inspirationResultFixture,
  inspirationSourceFixture,
  inspirationSummaryFixture,
} from "./test-fixtures";

const operationId = randomUUID();
const facet = { name: "轻通勤", rationale: "公开商品与趋势内容重复出现", strength: "high", sourceIndexes: [1] };

describe("inspiration contracts", () => {
  it("trims and NFC-normalizes user prompts and editable titles", () => {
    expect(inspirationCreateMutationSchema.parse({ operationId, prompt: "  Cafe\u0301 女装研究  " }).prompt).toBe("Café 女装研究");
    expect(inspirationPatchMutationSchema.parse({ title: " Cafe\u0301 ", version: 0 }).title).toBe("Café");
  });

  it.each(["", "四个字符", "a".repeat(1001), "分析女装\0趋势"])("rejects invalid prompt %j", (prompt) => {
    expect(inspirationCreateMutationSchema.safeParse({ operationId, prompt }).success).toBe(false);
  });

  it("accepts prompt length boundaries and rejects untrusted mutation fields", () => {
    for (const length of [5, 1000]) expect(inspirationCreateMutationSchema.safeParse({ operationId, prompt: "字".repeat(length) }).success).toBe(true);
    expect(inspirationCreateMutationSchema.safeParse({ operationId, prompt: "女装趋势研究", ownerId: randomUUID() }).success).toBe(false);
    expect(inspirationCreateMutationSchema.safeParse({ operationId: "bad", prompt: "女装趋势研究" }).success).toBe(false);
    for (const patch of [{ title: " ", version: 0 }, { title: "a".repeat(121), version: 0 }, { title: "a\0", version: 0 }, { title: "标题", version: -1 }, { title: "标题", version: 0.5 }, { title: "标题", version: 0, prompt: "女装趋势研究" }]) expect(inspirationPatchMutationSchema.safeParse(patch).success).toBe(false);
  });

  it("bounds and defaults list pagination", () => {
    expect(inspirationListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(inspirationListQuerySchema.parse({ limit: "100", cursor: "opaque-cursor" })).toEqual({ limit: 100, cursor: "opaque-cursor" });
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "" }, { cursor: "a\0" }, { ownerId: operationId }]) expect(inspirationListQuerySchema.safeParse(query).success).toBe(false);
  });

  it("validates complete reusable fixtures", () => {
    expect(inspirationSourceSchema.safeParse(inspirationSourceFixture).success).toBe(true);
    expect(inspirationAnalysisResultSchema.safeParse(inspirationResultFixture).success).toBe(true);
    expect(inspirationSummaryDtoSchema.safeParse(inspirationSummaryFixture).success).toBe(true);
    expect(inspirationDetailDtoSchema.safeParse(inspirationDetailFixture).success).toBe(true);
    expect(inspirationListDtoSchema.safeParse({ items: [inspirationSummaryFixture], nextCursor: null }).success).toBe(true);
  });

  it.each(["javascript:alert(1)", "ftp://example.test/item", "https://user:secret@example.test/item", "https://user@example.test/item", "invalid"])("rejects unsafe source URL %s", (url) => {
    expect(inspirationSourceSchema.safeParse({ ...inspirationSourceFixture, url }).success).toBe(false);
  });

  it("accepts HTTP sources and rejects duplicate or excessive provider source indexes", () => {
    expect(inspirationSourceSchema.safeParse({ ...inspirationSourceFixture, url: "http://example.test/item" }).success).toBe(true);
    expect(() => inspirationSourcesSchema.parse([inspirationSourceFixture, inspirationSourceFixture])).toThrow(/duplicate source index/);
    expect(inspirationSourcesSchema.safeParse(Array.from({ length: 21 }, (_, index) => ({ ...inspirationSourceFixture, index: index + 1 }))).success).toBe(false);
    for (const index of [0, 101, 1.5]) expect(inspirationSourceSchema.safeParse({ ...inspirationSourceFixture, index }).success).toBe(false);
  });

  it("rejects unbounded or null-containing display text", () => {
    for (const title of ["", "a".repeat(301), "a\0"]) expect(inspirationSourceSchema.safeParse({ ...inspirationSourceFixture, title }).success).toBe(false);
    for (const name of ["", "a".repeat(81), "a\0"]) expect(trendFacetSchema.safeParse({ ...facet, name }).success).toBe(false);
    expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, summary: "a\0" }).success).toBe(false);
    expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, inspirationPrompts: inspirationResultFixture.inspirationPrompts.map((prompt) => ({ ...prompt, palette: ["a\0"] })) }).success).toBe(false);
  });

  it("requires bounded source references and uppercase color hints", () => {
    for (const sourceIndexes of [[0], [101], [1.5], Array(21).fill(1)]) expect(trendFacetSchema.safeParse({ ...facet, sourceIndexes }).success).toBe(false);
    for (const colorHint of [null, "#AABBCC"]) expect(colorFacetSchema.safeParse({ ...facet, colorHint }).success).toBe(true);
    for (const colorHint of ["#aabbcc", "red", "#FFF", "url(evil)"]) expect(colorFacetSchema.safeParse({ ...facet, colorHint }).success).toBe(false);
  });

  it("caps all result collections and permits unsupported dimensions to be empty", () => {
    expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, marketSignals: Array(9).fill(facet) }).success).toBe(false);
    for (const dimension of Object.keys(inspirationResultFixture.dimensions)) {
      const item = dimension === "colors" ? { ...facet, colorHint: null } : facet;
      expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, dimensions: { ...inspirationResultFixture.dimensions, [dimension]: Array(9).fill(item) } }).success).toBe(false);
      expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, dimensions: { ...inspirationResultFixture.dimensions, [dimension]: [] } }).success).toBe(true);
    }
    expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, referenceLooks: Array(13).fill(inspirationResultFixture.referenceLooks[0]) }).success).toBe(false);
    for (const length of [2, 6]) expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, inspirationPrompts: Array(length).fill(inspirationResultFixture.inspirationPrompts[0]) }).success).toBe(false);
    expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, inspirationPrompts: Array(5).fill(inspirationResultFixture.inspirationPrompts[0]) }).success).toBe(true);
  });

  it("rejects model-invented fields at every object boundary", () => {
    expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, url: "https://example.test" }).success).toBe(false);
    expect(trendFacetSchema.safeParse({ ...facet, url: "https://example.test" }).success).toBe(false);
    expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, dimensions: { ...inspirationResultFixture.dimensions, extra: [] } }).success).toBe(false);
    for (const field of ["referenceLooks", "inspirationPrompts"] as const) expect(inspirationAnalysisResultSchema.safeParse({ ...inspirationResultFixture, [field]: inspirationResultFixture[field].map((item) => ({ ...item, url: "https://example.test" })) }).success).toBe(false);
  });

  it("exports a JSON schema forbidding additional properties on every object", () => {
    let count = 0;
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.type === "object") { count++; expect(node.additionalProperties).toBe(false); }
      for (const child of Object.values(node)) visit(child);
    }
    visit(inspirationAnalysisJsonSchema);
    expect(count).toBeGreaterThan(5);
    expect(inspirationAnalysisJsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("keeps authenticated internal fields and full results out of summaries", () => {
    for (const key of ["ownerId", "operationId", "searchRequestId", "structureRequestId", "providerError"]) expect(inspirationDetailDtoSchema.safeParse({ ...inspirationDetailFixture, [key]: "private" }).success).toBe(false);
    expect(inspirationSummaryDtoSchema.safeParse({ ...inspirationSummaryFixture, result: inspirationResultFixture }).success).toBe(false);
    for (const patch of [{ version: -1 }, { createdAt: "yesterday" }, { status: "unknown" }, { errorCode: "raw provider error" }]) expect(inspirationDetailDtoSchema.safeParse({ ...inspirationDetailFixture, ...patch }).success).toBe(false);
    expect(inspirationDetailDtoSchema.safeParse({ ...inspirationDetailFixture, status: "pending", sources: null, result: null, shareUrl: null, errorCode: null, completedAt: null }).success).toBe(true);
  });

  it("exposes only the five public snapshot fields", () => {
    const shared = { title: "都市轻通勤", prompt: "分析近 30 天都市轻通勤女装", completedAt: "2026-10-28T02:00:00.000Z", sources: [inspirationSourceFixture], result: inspirationResultFixture };
    expect(inspirationSharedDtoSchema.safeParse(shared).success).toBe(true);
    for (const key of ["id", "ownerId", "status", "version", "shareUrl", "errorCode", "createdAt", "searchRequestId"]) expect(inspirationSharedDtoSchema.safeParse({ ...shared, [key]: "private" }).success).toBe(false);
    expect(inspirationSharedDtoSchema.safeParse(inspirationDetailFixture).success).toBe(false);
    expect(inspirationSharedDtoSchema.safeParse({ ...shared, completedAt: null }).success).toBe(false);
  });
});
