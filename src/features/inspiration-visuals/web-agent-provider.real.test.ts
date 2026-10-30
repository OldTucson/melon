// @vitest-environment node
import { describe, expect, it } from "vitest";
import { webAgentConfigSchema, webAgentRequestIdSchema } from "./web-agent-contracts";
import { createWebAgentProvider } from "./web-agent-provider";

const runReal = process.env.RUN_REAL_INSPIRATION_WEB_TESTS === "1";
const requestId = "inspiration-web-release-smoke-v1";
const intents = [{
  key: "evidence-1", role: "evidence" as const,
  query: "cotton linen womenswear relaxed summer shirt fabric",
  sourceIndexes: [], sourceHosts: [], productName: null, brand: null,
}];

type SmokeOptions = {
  enabled: boolean;
  config: unknown;
  transport?: typeof fetch;
  log?: (line: string) => void;
};

async function runSmoke({ enabled, config, transport = fetch, log = console.info }: SmokeOptions): Promise<void> {
  if (!enabled) return;
  const parsed = webAgentConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error("REAL_INSPIRATION_WEB_CONFIG_INVALID");
  let requests = 0;
  const oneRequest: typeof fetch = async (url, init) => {
    // Refuse retries or image fetches even if provider implementation changes.
    if (requests !== 0 || url !== "https://dashscope.aliyuncs.com/api/v2/apps/web-search-agent/chat/completions" || init?.method !== "POST") {
      throw new Error("REAL_INSPIRATION_WEB_REQUEST_BUDGET");
    }
    requests++;
    return transport(url, init);
  };
  let result;
  try {
    result = await createWebAgentProvider(parsed.data, oneRequest).search({
      requestId,
      prompt: "Research relaxed cotton linen summer womenswear using original source pages.",
      headline: "Cotton linen everyday layers",
      summary: "Find sourced fashion and material references for relaxed summer shirts.",
      intents,
      signal: AbortSignal.timeout(65_000),
    });
  } catch {
    // Never attach a provider error/cause or echo any response/request content.
    throw new Error("REAL_INSPIRATION_WEB_FAILED");
  }
  const https = (value: string) => {
    const url = URL.parse(value);
    return url?.protocol === "https:" && !url.username && !url.password;
  };
  // Only boolean/count assertions: Vitest cannot print sensitive candidate data.
  expect(requests).toBe(1);
  expect(webAgentRequestIdSchema.safeParse(result.requestId).success).toBe(true);
  expect(result.candidates.length).toBeGreaterThan(0);
  expect(result.candidates.length).toBeLessThanOrEqual(128);
  expect(result.candidates.every((candidate) =>
    typeof candidate.title === "string" && candidate.title.length > 0 &&
    typeof candidate.query === "string" && candidate.query.length > 0 &&
    https(candidate.imageUrl) && https(candidate.sourcePageUrl),
  )).toBe(true);
  log(JSON.stringify({ requestCount: requests, candidateCount: result.candidates.length,
    requestId, providerRequestId: result.requestId }));
}

const offlineConfig = { apiKey: "offline-test-key", agentId: "aid-offline", agentVersion: "release" };
describe("real Agent smoke safety (offline)", () => {
  it("does not validate credentials or use transport without explicit opt-in", async () => {
    let requests = 0;
    await runSmoke({ enabled: false, config: offlineConfig, transport: async () => { requests++; throw new Error("UNEXPECTED_NETWORK"); } });
    expect(requests).toBe(0);
  });
  it("rejects missing credentials before any transport with a fixed safe code", async () => {
    let requests = 0;
    await expect(runSmoke({ enabled: true, config: {}, transport: async () => { requests++; throw new Error("UNEXPECTED_NETWORK"); } })).rejects.toThrow(/^REAL_INSPIRATION_WEB_CONFIG_INVALID$/);
    expect(requests).toBe(0);
  });
  it("makes one request, validates structured images and logs only IDs/counts", async () => {
    let requests = 0;
    const lines: string[] = [];
    await runSmoke({ enabled: true, config: offlineConfig, log: (line) => lines.push(line), transport: async () => {
      requests++;
      return new Response(`data: ${JSON.stringify({ request_id: "offline-request-1", output: { choices: [{ message: {
        content: "RAW_PROVIDER_TEXT_NEVER_LOG",
        additional_kwargs: { data_type: "image", data_json: [{ idx: 0, query: "PRIVATE_QUERY", title: "PRIVATE_TITLE", url: "https://example.test/page?secret=query", image_info: { url: "https://example.test/image?secret=query", width: 640, height: 480 } }] },
      } }] } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
    expect(requests).toBe(1);
    expect(lines).toEqual(['{"requestCount":1,"candidateCount":1,"requestId":"inspiration-web-release-smoke-v1","providerRequestId":"offline-request-1"}']);
  });
});

(runReal ? describe : describe.skip)("real web Agent (one paid request, no image downloads)", () => {
  it("returns structured fashion/material candidates", async () => {
    await runSmoke({ enabled: runReal, config: {
      apiKey: process.env.DASHSCOPE_API_KEY,
      agentId: process.env.DASHSCOPE_WEB_SEARCH_AGENT_ID,
      agentVersion: process.env.DASHSCOPE_WEB_SEARCH_AGENT_VERSION,
    } });
  }, 70_000);
});
