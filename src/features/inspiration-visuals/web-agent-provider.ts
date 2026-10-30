import "server-only";

import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";

import {
  webAgentConfigSchema,
  type WebAgentConfig,
  type WebEvidenceProvider,
} from "./web-agent-contracts";
import { buildWebAgentRequest, parseWebAgentStream } from "./web-agent-protocol";

export type { WebAgentConfig, WebAgentSearchInput, WebAgentSearchResult, WebEvidenceProvider } from "./web-agent-contracts";

const ENDPOINT = "https://dashscope.aliyuncs.com/api/v2/apps/web-search-agent/chat/completions";
const DEADLINE_MS = 60_000;

function unavailable(status = 503) {
  return new AppError("INSPIRATION_VISUALS_UNAVAILABLE", status, "INSPIRATION_VISUALS_UNAVAILABLE");
}

function cancelBody(response: Response) {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Best effort. */ }
}

export function createWebAgentProvider(
  config: WebAgentConfig,
  fetchImpl: typeof fetch = fetch,
): WebEvidenceProvider {
  let validated: WebAgentConfig;
  try { validated = webAgentConfigSchema.parse(config); } catch { throw unavailable(); }

  return {
    async search(input) {
      if (input.signal.aborted) throw unavailable();
      let request: ReturnType<typeof buildWebAgentRequest>;
      try { request = buildWebAgentRequest(input, validated); } catch { throw unavailable(); }
      const controller = new AbortController();
      let timedOut = false;
      let failureStatus = 503;
      const emptyError = new AppError("INSPIRATION_VISUALS_EMPTY", 502, "INSPIRATION_VISUALS_EMPTY");
      const onCallerAbort = () => controller.abort();
      input.signal.addEventListener("abort", onCallerAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, DEADLINE_MS);
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(unavailable(timedOut ? 504 : 503));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

      try {
        // Recheck after attaching the listener so an already cancelled caller
        // cannot start a paid request. Race even an uncooperative injected fetch.
        if (input.signal.aborted) { controller.abort(); throw unavailable(); }
        const pendingResponse = fetchImpl(ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${validated.apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify(request),
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        }).then((response) => {
          if (controller.signal.aborted) cancelBody(response);
          return response;
        });
        const response = await Promise.race([pendingResponse, aborted]);
        if (response.status !== 200) { cancelBody(response); throw unavailable(); }
        failureStatus = 502;
        const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType !== "text/event-stream" || !response.body) {
          cancelBody(response);
          throw unavailable(502);
        }
        const result = await Promise.race([parseWebAgentStream(response.body, controller.signal), aborted]);
        if (controller.signal.aborted) throw unavailable(timedOut ? 504 : 503);
        if (result.candidates.length === 0) {
          throw emptyError;
        }
        return result;
      } catch (error) {
        // Never propagate abort reasons, response bodies, Zod issues, URLs or
        // credential-bearing fetch errors; no upstream error becomes a cause.
        if (timedOut) throw unavailable(504);
        if (input.signal.aborted) throw unavailable();
        if (error === emptyError) throw emptyError;
        throw unavailable(failureStatus);
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onCallerAbort);
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Resolves configuration only. A search is the sole operation that sends HTTP. */
export function getWebAgentProvider(): WebEvidenceProvider {
  try {
    const env = getServerEnv();
    if (!env.INSPIRATION_ENABLED || !env.INSPIRATION_WEB_VISUALS_ENABLED ||
      !env.DASHSCOPE_API_KEY || !env.DASHSCOPE_WEB_SEARCH_AGENT_ID || !env.DASHSCOPE_WEB_SEARCH_AGENT_VERSION) {
      throw unavailable();
    }
    return createWebAgentProvider({
      apiKey: env.DASHSCOPE_API_KEY,
      agentId: env.DASHSCOPE_WEB_SEARCH_AGENT_ID,
      agentVersion: env.DASHSCOPE_WEB_SEARCH_AGENT_VERSION,
    });
  } catch {
    throw unavailable();
  }
}
