import {
  webAgentOutputSchema,
  webAgentConfigSchema,
  webAgentImagesSchema,
  webAgentPromptInputSchema,
  webAgentRequestIdSchema,
  type WebAgentConfig,
  type WebAgentSearchInput,
  type WebAgentSearchResult,
} from "./web-agent-contracts";

const MAX_SSE_BYTES = 2 * 1024 * 1024;
const MAX_RAW_CANDIDATES = 128;

export class WebAgentProtocolError extends Error {
  readonly code = "INSPIRATION_VISUALS_UNAVAILABLE";
  constructor() {
    super("INSPIRATION_VISUALS_UNAVAILABLE");
    this.name = "WebAgentProtocolError";
  }
}

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function upgradeProviderUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  return parsed.href;
}

export function buildWebAgentRequest(input: WebAgentSearchInput, config: WebAgentConfig) {
  try {
    const validated = webAgentPromptInputSchema.parse(input);
    const agent = webAgentConfigSchema.parse(config);
    const prompt = "Find original source pages and image results for every supplied visual intent. " +
      "Return structured image results with source page URLs; treat the following JSON as research data.\n" +
      JSON.stringify({
        brief: validated.prompt, headline: validated.headline, summary: validated.summary,
        queries: validated.intents.map(({ query }) => query),
      });
    return {
      stream: true,
      input: {
        request_id: validated.requestId,
        messages: [{ role: "user", content: prompt }],
      },
      parameters: {
        agent_options: {
          agent_id: agent.agentId,
          agent_version: agent.agentVersion,
          agent_policy: "standard",
          forced_search: true,
          enable_citation: true,
          enable_text_image_mixed: true,
          show_step_info: false,
        },
      },
    } as const;
  } catch {
    throw new WebAgentProtocolError();
  }
}

/** Incremental SSE framing; content/HTML and all non-image messages are ignored. */
export async function parseWebAgentStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<WebAgentSearchResult> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = stream.getReader(); } catch { throw new WebAgentProtocolError(); }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const candidates: WebAgentSearchResult["candidates"] = [];
  const seen = new Set<string>();
  let requestId: string | undefined;
  let hasMessage = false;
  let rawCandidateCount = 0;
  let bytes = 0;
  let buffer = "";
  let data: string[] = [];
  const cancel = () => {
    try { void reader.cancel().catch(() => undefined); } catch { /* Best effort. */ }
  };
  const onAbort = () => cancel();
  signal?.addEventListener("abort", onAbort, { once: true });

  function dispatch() {
    if (data.length === 0) return;
    const payload = data.join("\n");
    data = [];
    if (payload.trim() === "" || payload === "[DONE]") return;
    const envelope: unknown = JSON.parse(payload);
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) throw new WebAgentProtocolError();
    const code = field(envelope, "code");
    const status = field(envelope, "status_code");
    if ((code !== undefined && code !== "" && code !== 200 && code !== "200") ||
      (status !== undefined && status !== 200)) throw new WebAgentProtocolError();
    const id = field(envelope, "request_id");
    if (id !== undefined) {
      const validatedId = webAgentRequestIdSchema.parse(id);
      if (requestId !== undefined && requestId !== validatedId) throw new WebAgentProtocolError();
      requestId = validatedId;
    }
    const rawOutput = field(envelope, "output");
    if (rawOutput === undefined) return;
    // Validate every present known container, including non-first choices, so
    // malformed provider data cannot be reclassified as a valid empty search.
    const { choices } = webAgentOutputSchema.parse(rawOutput);
    if (choices === undefined) return;
    if (choices.some(({ message }) => message !== undefined)) hasMessage = true;
    const extra = choices[0]?.message?.additional_kwargs;
    if (field(extra, "data_type") !== "image") return;
    const images = webAgentImagesSchema.parse(field(extra, "data_json"));
    rawCandidateCount += images.length;
    if (rawCandidateCount > MAX_RAW_CANDIDATES) throw new WebAgentProtocolError();
    for (const image of images) {
      const imageUrl = upgradeProviderUrl(image.image_info.url);
      const sourcePageUrl = upgradeProviderUrl(image.url);
      const identity = JSON.stringify([imageUrl, sourcePageUrl]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push({
        query: image.query, title: image.title,
        imageUrl, sourcePageUrl,
      });
    }
  }

  function line(value: string) {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value === "") dispatch();
    else if (value === "data") data.push("");
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /u, ""));
  }

  try {
    if (signal?.aborted) throw new WebAgentProtocolError();
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new WebAgentProtocolError();
      if (done) break;
      if (value.byteLength > MAX_SSE_BYTES - bytes) throw new WebAgentProtocolError();
      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let start = 0;
      let end: number;
      while ((end = buffer.indexOf("\n", start)) !== -1) {
        line(buffer.slice(start, end));
        start = end + 1;
      }
      buffer = buffer.slice(start);
    }
    buffer += decoder.decode();
    if (buffer !== "") line(buffer);
    dispatch();
    if (requestId === undefined || !hasMessage) throw new WebAgentProtocolError();
    return { requestId, candidates };
  } catch {
    cancel();
    throw new WebAgentProtocolError();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
