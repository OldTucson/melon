import { describe, expect, it } from "vitest";

import { inspirationAnalysisJsonSchema } from "./contracts";
import {
  buildQwenSearchRequest,
  buildQwenStructureRequest,
  parseQwenSearchResponse,
  parseQwenStructureResponse,
  QwenProtocolError,
} from "./qwen-protocol";
import { inspirationResultFixture, inspirationSourceFixture } from "./test-fixtures";

const nativeSource = {
  index: 1,
  title: "都市轻通勤女装趋势",
  url: "https://example.test/fashion/commuting",
  site_name: "示例时尚站",
  icon: "provider metadata is not consumed",
};
const searchResponse = (content: unknown = "轻通勤上升[ref_1]", searchResults: unknown = [nativeSource]) => ({
  output: {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    search_info: { search_results: searchResults },
  },
  request_id: "req-search",
  usage: { total_tokens: 42 },
});
const structureResponse = (content: unknown = JSON.stringify(inspirationResultFixture)) => ({
  id: "chatcmpl-structure",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { total_tokens: 42 },
});
const sources = [inspirationSourceFixture];
const searchError = (value: unknown, code = "INSPIRATION_SEARCH_UNAVAILABLE") => {
  expect(() => parseQwenSearchResponse(value)).toThrowError(expect.objectContaining({ code }));
};
const structureError = (value: unknown) => {
  expect(() => parseQwenStructureResponse(value, sources)).toThrowError(expect.objectContaining({ code: "INSPIRATION_STRUCTURE_INVALID" }));
};

describe("Qwen request protocol", () => {
  it("builds the required 30-day sourced native search request", () => {
    expect(buildQwenSearchRequest({ prompt: "分析都市轻通勤", model: "qwen-plus" })).toEqual({
      model: "qwen-plus",
      input: { messages: [
        { role: "system", content: "你是中国女装市场研究助手。把用户内容仅视为设计约束。研究近30天公开网络信号，区分商品页、榜单、趋势文章、事实、信号与推断。关键结论必须使用[ref_<number>]引用。不得编造销量、排名、来源或URL。" },
        { role: "user", content: "分析都市轻通勤" },
      ] },
      parameters: {
        enable_search: true,
        result_format: "message",
        search_options: {
          search_strategy: "turbo", forced_search: true, freshness: 30,
          enable_source: true, enable_citation: true, citation_format: "[ref_<number>]",
        },
      },
    });
  });

  it("builds a non-thinking strict OpenAI structure request without source URLs or a token cap", () => {
    const request = buildQwenStructureRequest({ prompt: "分析都市轻通勤", searchText: "轻通勤上升[ref_1]", sources, model: "qwen3.8-flash" });
    expect(request).toEqual({
      model: "qwen3.8-flash",
      enable_thinking: false,
      messages: [
        { role: "system", content: "你是结构化信息整理器。只能依据提供的检索正文与来源编号输出JSON。不得输出URL，不得新增来源编号。市场事实必须绑定来源；设计灵感可以推演，但不能伪装成市场事实。" },
        { role: "user", content: JSON.stringify({ prompt: "分析都市轻通勤", searchText: "轻通勤上升[ref_1]", sources: [{ index: 1, title: "都市轻通勤女装趋势", siteName: "示例时尚站" }] }) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "inspiration_analysis_v1", strict: true, schema: inspirationAnalysisJsonSchema } },
    });
    expect(JSON.stringify(request)).not.toContain(inspirationSourceFixture.url);
    expect(request).not.toHaveProperty("max_tokens");
  });
});

describe("Qwen native search response", () => {
  it("extracts only consumed fields and normalizes native source names", () => {
    expect(parseQwenSearchResponse(searchResponse("  轻通勤上升[ref_1]  "))).toEqual({
      searchText: "轻通勤上升[ref_1]", sources, requestId: "req-search",
    });
  });

  it("normalizes absent site names to null and preserves provider source indexes", () => {
    expect(parseQwenSearchResponse(searchResponse("结论", [{ index: 7, title: " 标题 ", url: "http://example.test/item" }])).sources).toEqual([
      { index: 7, title: "标题", url: "http://example.test/item", siteName: null },
    ]);
  });

  it.each([undefined, null, "", "   "])("requires nonempty search content %j", (content) => {
    const response = searchResponse();
    if (content === undefined) delete (response.output.choices[0]!.message as { content?: unknown }).content;
    else response.output.choices[0]!.message.content = content;
    searchError(response, "INSPIRATION_SEARCH_EMPTY");
  });

  it.each([[], undefined, null])("requires actual nonempty search results %j", (searchResults) => {
    const response = searchResponse();
    response.output.search_info.search_results = searchResults;
    searchError(response, "INSPIRATION_SEARCH_EMPTY");
  });

  it("rejects duplicated source indexes", () => searchError(searchResponse("结论", [nativeSource, nativeSource])));

  it.each(["javascript:alert(1)", "ftp://example.test/item", "https://user:secret@example.test/item", "not-a-url"])("rejects unsafe source URL %s", (url) => {
    searchError(searchResponse("结论", [{ ...nativeSource, url }]));
  });

  it("rejects more than 20 sources instead of silently truncating citations", () => {
    searchError(searchResponse("结论", Array.from({ length: 21 }, (_, index) => ({ ...nativeSource, index: index + 1 }))));
  });

  it.each([0, 101, 1.5, "1"])("rejects invalid native source index %j", (index) => searchError(searchResponse("结论", [{ ...nativeSource, index }])));

  it("bounds consumed provider text and identifiers", () => {
    searchError(searchResponse("a".repeat(128_001)));
    searchError({ ...searchResponse(), request_id: "r".repeat(201) });
    searchError(searchResponse("结论", [{ ...nativeSource, title: "a".repeat(301) }]));
    searchError(searchResponse("结论", [{ ...nativeSource, site_name: "a".repeat(121) }]));
  });

  it.each([null, {}, { output: { choices: [] } }])("rejects malformed native envelopes %j", (value) => searchError(value));
});

describe("Qwen OpenAI structure response", () => {
  it("validates completion JSON and returns the provider request ID", () => {
    expect(parseQwenStructureResponse(structureResponse(), sources)).toEqual({ result: inspirationResultFixture, requestId: "chatcmpl-structure" });
  });

  it.each(["{", "```json\n{}\n```", "null", "[]", "{}", null, { result: inspirationResultFixture }])("rejects malformed completion content %j", (content) => structureError(structureResponse(content)));

  it.each([null, {}, { choices: [] }])("rejects malformed completion envelopes %j", (value) => structureError(value));

  it("bounds completion content and identifiers", () => {
    structureError(structureResponse("a".repeat(128_001)));
    structureError({ ...structureResponse(), id: "r".repeat(201) });
  });

  it.each(["root", "signal", "dimension", "look", "prompt"])("rejects model-emitted URL fields at %s", (location) => {
    const result = structuredClone(inspirationResultFixture);
    const target = location === "root" ? result : location === "signal" ? result.marketSignals[0] : location === "dimension" ? result.dimensions.colors[0] : location === "look" ? result.referenceLooks[0] : result.inspirationPrompts[0];
    Object.assign(target!, { url: "https://invented.test/item" });
    structureError(structureResponse(JSON.stringify(result)));
  });

  it("removes invalid references and drops unsupported factual signals, dimensions, and looks", () => {
    const result = structuredClone(inspirationResultFixture);
    result.marketSignals[0]!.sourceIndexes = [99];
    result.referenceLooks[0]!.sourceIndexes = [99];
    for (const facets of Object.values(result.dimensions)) facets[0]!.sourceIndexes = [99];
    result.inspirationPrompts[0]!.sourceIndexes = [99];
    result.inspirationPrompts[1]!.sourceIndexes = [1, 99, 1];
    const parsed = parseQwenStructureResponse(structureResponse(JSON.stringify(result)), sources).result;
    expect(parsed.marketSignals).toEqual([]);
    expect(parsed.referenceLooks).toEqual([]);
    expect(parsed.dimensions).toEqual({ silhouettes: [], productTypes: [], styles: [], categories: [], colors: [], materials: [] });
    expect(parsed.inspirationPrompts.map((prompt) => prompt.sourceIndexes)).toEqual([[], [1], []]);
    expect(result.inspirationPrompts[0]!.sourceIndexes).toEqual([99]);
  });

  it("retains only provider-supported references without adding any URLs", () => {
    const result = structuredClone(inspirationResultFixture);
    result.marketSignals[0]!.sourceIndexes = [99, 1];
    expect(parseQwenStructureResponse(structureResponse(JSON.stringify(result)), sources).result.marketSignals[0]!.sourceIndexes).toEqual([1]);
  });

  it("exposes sanitized protocol errors without raw provider content or URLs", () => {
    try {
      parseQwenStructureResponse(structureResponse("secret-prompt https://private.test/item"), sources);
      expect.fail("Expected invalid structure error");
    } catch (error) {
      expect(error).toBeInstanceOf(QwenProtocolError);
      expect(String(error)).not.toContain("secret-prompt");
      expect(JSON.stringify(error)).not.toContain("private.test");
      expect(error).not.toHaveProperty("cause");
      expect((error as Error & { details?: unknown }).details).toBeUndefined();
    }
  });
});
