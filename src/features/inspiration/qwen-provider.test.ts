import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerEnv, parseServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";

import { createQwenInspirationProvider, getQwenInspirationProvider } from "./qwen-provider";
import { inspirationResultFixture, inspirationSourceFixture } from "./test-fixtures";

vi.mock("@/lib/env/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/env/server")>(),
  getServerEnv: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

const testConfig = {
  apiKey: "sk-test-only",
  nativeBaseUrl: "https://workspace.example.maas.aliyuncs.com/api/v1/",
  openaiBaseUrl: "https://workspace.example.maas.aliyuncs.com/compatible-mode/v1/",
  searchModel: "qwen-plus",
  structureModel: "qwen3.8-flash",
} as const;
const prompt = "分析都市轻通勤女装";
const searchFixture = {
  output: {
    choices: [{ message: { role: "assistant", content: "轻通勤上升[ref_1]" }, finish_reason: "stop" }],
    search_info: { search_results: [{ index: 1, title: inspirationSourceFixture.title, url: inspirationSourceFixture.url, site_name: inspirationSourceFixture.siteName }] },
  },
  request_id: "search-request-1",
  usage: { total_tokens: 42 },
};
const structureFixture = {
  id: "structure-request-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(inspirationResultFixture) }, finish_reason: "stop" }],
  usage: { total_tokens: 42 },
};
const input = (signal = new AbortController().signal) => ({ prompt, signal });
const secret = `${testConfig.apiKey} ${prompt} Authorization https://private.test/raw raw-upstream-body`;

async function expectFailure(pending: Promise<unknown>, code: string, status: number) {
  const error: unknown = await pending.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code, status });
  const publicError = error as AppError;
  expect(publicError.details).toBeUndefined();
  expect(publicError).not.toHaveProperty("cause");
  for (const sensitive of [testConfig.apiKey, prompt, "Authorization", "https://", "raw-upstream-body"]) {
    expect(String(publicError) + JSON.stringify(publicError)).not.toContain(sensitive);
  }
}

function stageFetch(stage: "search" | "structure", response: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn<typeof fetch>();
  if (stage === "structure") fetchImpl.mockResolvedValueOnce(Response.json(searchFixture));
  fetchImpl.mockImplementationOnce(async () => response());
  return fetchImpl;
}

function stalledFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("Qwen two-stage HTTP provider", () => {
  it("posts sequential native search and strict compatible structuring with supported citations", async () => {
    let finishSearch!: () => void;
    const searchBody = new ReadableStream<Uint8Array>({
      start(controller) {
        finishSearch = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(searchFixture))); controller.close(); };
      },
    });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(searchBody))
      .mockResolvedValueOnce(Response.json(structureFixture));
    const pending = createQwenInspirationProvider(testConfig, fetchImpl).analyze(input());
    await vi.waitFor(() => expect(searchBody.locked).toBe(true));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    finishSearch();
    await expect(pending).resolves.toEqual({
      sources: [inspirationSourceFixture], result: inspirationResultFixture,
      searchRequestId: "search-request-1", structureRequestId: "structure-request-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://workspace.example.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
      "https://workspace.example.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: "POST", cache: "no-store", redirect: "error" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-only");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen-plus", input: { messages: [{ role: "system" }, { role: "user", content: prompt }] },
      parameters: { enable_search: true, search_options: { forced_search: true, freshness: 30 } },
    });
    const structureBody = String(fetchImpl.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(structureBody)).toMatchObject({ model: "qwen3.8-flash", enable_thinking: false, response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(structureBody).not.toContain(inspirationSourceFixture.url);
    expect(JSON.parse(JSON.parse(structureBody).messages[1].content)).toEqual({
      prompt, searchText: "轻通勤上升[ref_1]", sources: [{ index: 1, title: inspirationSourceFixture.title, siteName: inspirationSourceFixture.siteName }],
    });
  });

  it("excludes source URLs embedded in linked search text from structuring", async () => {
    const fixture = structuredClone(searchFixture);
    fixture.output.choices[0]!.message.content = "轻通勤上升：[示例时尚站](https://example.test/fashion/commuting)[ref_1]；来源 https://example.test/fashion/commuting 。";
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(fixture))
      .mockResolvedValueOnce(Response.json(structureFixture));
    const output = await createQwenInspirationProvider(testConfig, fetchImpl).analyze(input());
    const structureRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const structureInput = JSON.parse(structureRequest.messages[1].content);
    expect(JSON.stringify(structureRequest)).not.toContain("https://example.test/fashion/commuting");
    expect(structureInput.searchText).toContain("轻通勤上升");
    expect(structureInput.searchText).toContain("示例时尚站");
    expect(structureInput.searchText).toContain("[ref_1]");
    expect(output.sources).toEqual([inspirationSourceFixture]);
  });

  it.each(["search", "structure"] as const)("accepts exactly two MiB in the %s stage", async (stage) => {
    const json = JSON.stringify(stage === "search" ? searchFixture : structureFixture);
    const padding = 2 * 1024 * 1024 - new TextEncoder().encode(json).byteLength;
    const fetchImpl = stageFetch(stage, () => new Response(json + " ".repeat(padding)));
    if (stage === "search") fetchImpl.mockResolvedValueOnce(Response.json(structureFixture));
    await expect(createQwenInspirationProvider(testConfig, fetchImpl).analyze(input())).resolves.toMatchObject({ result: inspirationResultFixture });
  });

  for (const stage of ["search", "structure"] as const) {
    const label = stage === "search" ? "SEARCH" : "STRUCTURE";
    const invalidCode = stage === "search" ? "INSPIRATION_SEARCH_UNAVAILABLE" : "INSPIRATION_STRUCTURE_INVALID";
    it(`maps ${stage} network failures to sanitized 503 without retries`, async () => {
      const fetchImpl = stageFetch(stage, () => { throw new Error(secret); });
      await expectFailure(createQwenInspirationProvider(testConfig, fetchImpl).analyze(input()), `INSPIRATION_${label}_UNAVAILABLE`, 503);
      expect(fetchImpl).toHaveBeenCalledTimes(stage === "search" ? 1 : 2);
    });

    it.each([302, 401, 429, 500])(`maps ${stage} HTTP %i to sanitized 503 and cancels the body`, async (status) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetchImpl = stageFetch(stage, () => new Response(body, { status }));
      await expectFailure(createQwenInspirationProvider(testConfig, fetchImpl).analyze(input()), `INSPIRATION_${label}_UNAVAILABLE`, 503);
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(stage === "search" ? 1 : 2);
    });

    it.each(["json", "schema", "missing", "stream", "oversize"] as const)(`maps ${stage} invalid %s content to sanitized 502`, async (kind) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const fetchImpl = stageFetch(stage, () => {
        if (kind === "json") return new Response(secret);
        if (kind === "schema") return Response.json({ secret });
        if (kind === "missing") return new Response(null);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            if (kind === "stream") controller.error(new Error(secret));
            else controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel,
        }), { headers: { "content-length": "1" } });
      });
      await expectFailure(createQwenInspirationProvider(testConfig, fetchImpl).analyze(input()), invalidCode, 502);
      if (kind === "oversize") expect(cancel).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(stage === "search" ? 1 : 2);
    });

    it.each(["fetch", "body"] as const)(`enforces the ${stage} deadline during %s`, async (during) => {
      const searchTimeout = new AbortController();
      const structureTimeout = new AbortController();
      const deadline = stage === "search" ? searchTimeout : structureTimeout;
      const timeout = vi.spyOn(AbortSignal, "timeout")
        .mockReturnValueOnce(searchTimeout.signal).mockReturnValueOnce(structureTimeout.signal);
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetchImpl = vi.fn<typeof fetch>();
      if (stage === "structure") fetchImpl.mockResolvedValueOnce(Response.json(searchFixture));
      fetchImpl.mockImplementationOnce(during === "fetch" ? stalledFetch : async () => new Response(body));
      const pending = createQwenInspirationProvider(testConfig, fetchImpl).analyze(input());
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(stage === "search" ? 1 : 2));
      if (during === "body") await vi.waitFor(() => expect(body.locked).toBe(true));
      const assertion = expectFailure(pending, `INSPIRATION_${label}_TIMEOUT`, 504);
      deadline.abort(new DOMException(secret, "TimeoutError"));
      await assertion;
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual(stage === "search" ? [60_000] : [60_000, 45_000]);
      expect(fetchImpl.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
      if (during === "body") { expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false); }
    });

    it.each(["fetch", "body"] as const)(`propagates caller abort during ${stage} %s unchanged`, async (during) => {
      const caller = new AbortController();
      const reason = new DOMException("cancelled", "AbortError");
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetchImpl = vi.fn<typeof fetch>();
      if (stage === "structure") fetchImpl.mockResolvedValueOnce(Response.json(searchFixture));
      fetchImpl.mockImplementationOnce(during === "fetch" ? stalledFetch : async () => new Response(body));
      const pending = createQwenInspirationProvider(testConfig, fetchImpl).analyze(input(caller.signal));
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(stage === "search" ? 1 : 2));
      if (during === "body") await vi.waitFor(() => expect(body.locked).toBe(true));
      caller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(fetchImpl.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
      if (during === "body") { expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false); }
    });
  }

  it("does not pay for a request already cancelled by its caller", async () => {
    const caller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    caller.abort(reason);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(createQwenInspirationProvider(testConfig, fetchImpl).analyze(input(caller.signal))).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not structure search results with no sources", async () => {
    const fixture = structuredClone(searchFixture);
    fixture.output.search_info.search_results = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture));
    await expectFailure(createQwenInspirationProvider(testConfig, fetchImpl).analyze(input()), "INSPIRATION_SEARCH_EMPTY", 502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid model JSON inside an otherwise valid completion", async () => {
    const fixture = structuredClone(structureFixture);
    fixture.choices[0]!.message.content = secret;
    const fetchImpl = stageFetch("structure", () => Response.json(fixture));
    await expectFailure(createQwenInspirationProvider(testConfig, fetchImpl).analyze(input()), "INSPIRATION_STRUCTURE_INVALID", 502);
  });
});

const baseEnvInput = {
  NODE_ENV: "test", DATABASE_URL: "postgres://localhost/melon", AUTH_SECRET: "a".repeat(32),
  APP_ORIGIN: "http://localhost:3000", ALIYUN_OSS_REGION: "oss-cn-hangzhou", ALIYUN_OSS_BUCKET: "melon-test-assets",
  ALIYUN_OSS_ENDPOINT: "https://assets.example.test", ALIYUN_OSS_CNAME: "true",
  ALIYUN_STS_ROLE_ARN: "acs:ram::123456789012:role/melon-browser-upload",
};
const baseEnv = () => parseServerEnv(baseEnvInput);
const enabledEnvInput = () => ({
  ...baseEnvInput, INSPIRATION_ENABLED: "true", DASHSCOPE_API_KEY: testConfig.apiKey,
  DASHSCOPE_WORKSPACE_ID: "workspace", DASHSCOPE_NATIVE_BASE_URL: testConfig.nativeBaseUrl,
  DASHSCOPE_OPENAI_BASE_URL: testConfig.openaiBaseUrl,
});
const enabledEnv = () => parseServerEnv(enabledEnvInput());

describe("configured Qwen provider", () => {
  it("is unavailable when disabled", () => {
    vi.mocked(getServerEnv).mockReturnValue(baseEnv());
    expect(getQwenInspirationProvider).toThrowError(expect.objectContaining({ code: "INSPIRATION_DISABLED", status: 503 }));
  });

  it.each(["DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID", "DASHSCOPE_NATIVE_BASE_URL", "DASHSCOPE_OPENAI_BASE_URL"] as const)("is unavailable when %s is missing", (key) => {
    vi.mocked(getServerEnv).mockImplementation(() => parseServerEnv({ ...enabledEnvInput(), [key]: undefined }));
    expect(getQwenInspirationProvider).toThrowError(expect.objectContaining({ code: "INSPIRATION_DISABLED", status: 503 }));
  });

  it.each([false, true])("preserves unrelated environment failures with missing inspiration key %s", (missingKey) => {
    const envInput = { ...enabledEnvInput(), AUTH_SECRET: "short", ...(missingKey ? { DASHSCOPE_API_KEY: undefined } : {}) };
    let parserError: unknown;
    try { parseServerEnv(envInput); } catch (error) { parserError = error; }
    expect(parserError).toBeInstanceOf(Error);
    vi.mocked(getServerEnv).mockImplementation(() => { throw parserError; });
    expect(getQwenInspirationProvider).toThrow(parserError as Error);
  });

  it("preserves non-validation environment failures", () => {
    const error = new Error("environment loader failed");
    vi.mocked(getServerEnv).mockImplementation(() => { throw error; });
    expect(getQwenInspirationProvider).toThrow(error);
  });

  it("uses server credentials and models with the default fetch", async () => {
    vi.mocked(getServerEnv).mockReturnValue(enabledEnv());
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(searchFixture)).mockResolvedValueOnce(Response.json(structureFixture));
    vi.stubGlobal("fetch", fetchImpl);
    try {
      await expect(getQwenInspirationProvider().analyze(input())).resolves.toMatchObject({ result: inspirationResultFixture });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer sk-test-only");
    } finally { vi.unstubAllGlobals(); }
  });
});
