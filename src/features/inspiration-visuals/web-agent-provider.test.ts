import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerEnv, parseServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";

import { createWebAgentProvider, getWebAgentProvider } from "./web-agent-provider";

vi.mock("@/lib/env/server", async (original) => ({
  ...await original<typeof import("@/lib/env/server")>(), getServerEnv: vi.fn(),
}));

const config = { apiKey: "sk-private-test", agentId: "aid-example", agentVersion: "release" as const };
const input = (signal = new AbortController().signal) => ({
  requestId: "request-client-1", prompt: "Fashion brief", headline: "Linen direction", summary: "Soft tailoring",
  intents: [{ key: "evidence-1", role: "evidence" as const, query: "linen trend", sourceIndexes: [1], sourceHosts: ["journal.test"], productName: null, brand: null }],
  signal,
});
const envelope = {
  request_id: "request-platform-1",
  output: { choices: [{ message: { additional_kwargs: { data_type: "image", data_json: [{
    idx: 1, query: "linen trend", title: "Shirt", url: "https://journal.test/article",
    image_info: { url: "https://images.test/shirt.jpg?sig=secret", width: 800, height: 600 },
  }] } } }] },
};
const sse = (value: unknown = envelope) => `data: ${JSON.stringify(value)}\n\n`;
const response = (body: BodyInit | null = sse(), status = 200, contentType = "text/event-stream; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": contentType } });
const secret = "sk-private-test https://private.test/file?token=SECRET users/owner/private-object raw-body Authorization";
async function expectFailure(pending: Promise<unknown>, code = "INSPIRATION_VISUALS_UNAVAILABLE", status?: number) {
  const error: unknown = await pending.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code, message: code, ...(status ? { status } : {}) });
  expect(error).not.toHaveProperty("cause");
  expect((error as AppError).details).toBeUndefined();
  const inspectable = String(error) + JSON.stringify(error) + String((error as Error).stack);
  for (const sensitive of [config.apiKey, "https://", "SECRET", "users/owner", "raw-body", "Authorization", "token="]) expect(inspectable).not.toContain(sensitive);
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Web Search Agent HTTP provider", () => {
  it("makes exactly one fixed-endpoint POST with server credentials and required streaming options", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(createWebAgentProvider(config, fetchImpl).search(input())).resolves.toEqual({
      requestId: "request-platform-1", candidates: [{
        query: "linen trend", title: "Shirt", sourcePageUrl: "https://journal.test/article",
        imageUrl: "https://images.test/shirt.jpg?sig=secret",
      }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://dashscope.aliyuncs.com/api/v2/apps/web-search-agent/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-private-test");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stream: true, input: { request_id: "request-client-1" },
      parameters: { agent_options: { forced_search: true, enable_citation: true, enable_text_image_mixed: true } },
    });
  });

  it.each([201, 202, 204, 302, 401, 429, 500])("rejects HTTP %i without reading its body or retrying", async (status) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(status === 204 ? null : body, status));
    await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), undefined, 503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(status !== 204);
  });

  it.each(["application/json", "text/html", "text/event-stream-evil", ""])("rejects incorrect content type %s", async (contentType) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body, 200, contentType));
    await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), undefined, 502);
    expect(cancelled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not trust a transport exception that impersonates the EMPTY application error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new AppError("INSPIRATION_VISUALS_EMPTY", 502, secret, { url: secret }));
    await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), undefined, 503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport errors and never retries", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(secret));
    await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), undefined, 503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([null, "", "data: [DONE]\n\n", `data: ${secret}\n\n`, sse({ code: secret, message: secret }), ":" + "x".repeat(2 * 1024 * 1024)])(
    "maps missing/malformed/error/oversized responses to UNAVAILABLE (case %#)", async (body) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body));
      await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), undefined, 502);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes stream read failures", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(secret)); } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body));
    await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), undefined, 502);
    expect(body.locked).toBe(false);
  });

  it.each([
    null, 42, [],
    { choices: null }, { choices: {} }, { choices: [null] }, { choices: [42] }, { choices: [[]] },
    { choices: [{ message: null }] }, { choices: [{ message: 42 }] }, { choices: [{ message: [] }] },
    { choices: [{ message: { additional_kwargs: null } }] },
    { choices: [{ message: { additional_kwargs: 42 } }] },
    { choices: [{ message: { additional_kwargs: [] } }] },
    { choices: [{ message: { content: "Valid first message" } }, { message: 42 }] },
    {}, { choices: [] }, { choices: [{}] },
  ])("maps malformed or message-less known envelopes to UNAVAILABLE, never EMPTY (case %#)", async (output) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(sse({ request_id: "request-platform-1", output })));
    await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), undefined, 502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps unknown events surrounding a valid HTML-only message without additional_kwargs to EMPTY", async () => {
    const unknown = sse({ request_id: "request-platform-1", event: "progress", step: 2 });
    const html = sse({ request_id: "request-platform-1", output: { choices: [{ message: { content: '<img src="https://images.test/ignored.jpg">' } }] } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(unknown + html + unknown));
    await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), "INSPIRATION_VISUALS_EMPTY", 502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns EMPTY only for a valid stream with no structured images, ignoring HTML", async () => {
    const htmlOnly = { request_id: "request-platform-1", output: { choices: [{ message: {
      content: '<img src="https://images.test/from-html.jpg">', additional_kwargs: {},
    } }] } };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(sse(htmlOnly)));
    await expectFailure(createWebAgentProvider(config, fetchImpl).search(input()), "INSPIRATION_VISUALS_EMPTY", 502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  for (const during of ["fetch", "body"] as const) {
    it(`enforces and cleans up the 60s deadline during ${during}`, async () => {
      vi.useFakeTimers();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => undefined); } });
      // An uncooperative fetch still cannot extend the provider deadline.
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => during === "fetch" ? new Promise<Response>(() => undefined) : Promise.resolve(response(body)));
      const pending = createWebAgentProvider(config, fetchImpl).search(input());
      const assertion = expectFailure(pending, undefined, 504);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      if (during === "body") { expect(cancelled).toBe(true); expect(body.locked).toBe(false); }
    });

    it(`sanitizes caller cancellation and cleans listeners during ${during}`, async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const add = vi.spyOn(caller.signal, "addEventListener");
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => during === "fetch" ? new Promise<Response>(() => undefined) : Promise.resolve(response(body)));
      const pending = createWebAgentProvider(config, fetchImpl).search(input(caller.signal));
      const assertion = expectFailure(pending);
      await vi.advanceTimersByTimeAsync(0);
      caller.abort(new Error(secret));
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
      if (during === "body") { expect(cancelled).toBe(true); expect(body.locked).toBe(false); }
    });
  }

  it("avoids a paid request for pre-aborted or invalid input", async () => {
    const caller = new AbortController();
    caller.abort(new Error(secret));
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = createWebAgentProvider(config, fetchImpl);
    await expectFailure(provider.search(input(caller.signal)));
    await expectFailure(provider.search({ ...input(), prompt: "x".repeat(2001) }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cleans up deadline and caller listener after success or failure", async () => {
    vi.useFakeTimers();
    for (const body of [sse(), "data: malformed\n\n"]) {
      const caller = new AbortController();
      const add = vi.spyOn(caller.signal, "addEventListener");
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body));
      await createWebAgentProvider(config, fetchImpl).search(input(caller.signal)).catch(() => undefined);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

const baseEnv = {
  NODE_ENV: "test", DATABASE_URL: "postgres://localhost/melon", AUTH_SECRET: "a".repeat(32),
  APP_ORIGIN: "http://localhost:3000", ALIYUN_OSS_REGION: "oss-cn-hangzhou", ALIYUN_OSS_BUCKET: "melon-test-assets",
  ALIYUN_OSS_ENDPOINT: "https://assets.example.test", ALIYUN_OSS_CNAME: "true",
  ALIYUN_STS_ROLE_ARN: "acs:ram::123456789012:role/melon-browser-upload",
};
const enabledEnv = {
  ...baseEnv, INSPIRATION_ENABLED: "true", INSPIRATION_WEB_VISUALS_ENABLED: "true", DASHSCOPE_API_KEY: config.apiKey,
  DASHSCOPE_WORKSPACE_ID: "workspace", DASHSCOPE_NATIVE_BASE_URL: "https://workspace.example.maas.aliyuncs.com/api/v1",
  DASHSCOPE_OPENAI_BASE_URL: "https://workspace.example.maas.aliyuncs.com/compatible-mode/v1", DASHSCOPE_WEB_SEARCH_AGENT_ID: config.agentId,
  DASHSCOPE_WEB_SEARCH_AGENT_VERSION: "release",
};

describe("configured Web Search Agent", () => {
  it("constructs from typed server config without making a request", async () => {
    vi.mocked(getServerEnv).mockReturnValue(parseServerEnv(enabledEnv));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchImpl);
    const provider = getWebAgentProvider();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(provider.search(input())).resolves.toMatchObject({ requestId: "request-platform-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "missing-key", "missing-id", "missing-version", "env-error"])("sanitizes %s config errors without requesting", async (kind) => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    if (kind === "env-error") vi.mocked(getServerEnv).mockImplementation(() => { throw new Error(secret); });
    else {
      const env = parseServerEnv(kind === "disabled" ? baseEnv : enabledEnv);
      if (kind === "missing-key") env.DASHSCOPE_API_KEY = undefined;
      if (kind === "missing-id") env.DASHSCOPE_WEB_SEARCH_AGENT_ID = undefined;
      if (kind === "missing-version") env.DASHSCOPE_WEB_SEARCH_AGENT_VERSION = undefined;
      vi.mocked(getServerEnv).mockReturnValue(env);
    }
    await expectFailure(Promise.resolve().then(() => getWebAgentProvider()));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
