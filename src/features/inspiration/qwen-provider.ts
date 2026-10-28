import "server-only";

import { getServerEnv, type ServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import { readBoundedJson } from "@/lib/http/bounded-json";

import type { InspirationAnalysisResult, InspirationSource } from "./contracts";
import {
  buildQwenSearchRequest,
  buildQwenStructureRequest,
  parseQwenSearchResponse,
  parseQwenStructureResponse,
  QwenProtocolError,
} from "./qwen-protocol";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEARCH_DEADLINE_MS = 60_000;
const STRUCTURE_DEADLINE_MS = 45_000;

export type InspirationProviderOutput = {
  sources: InspirationSource[];
  result: InspirationAnalysisResult;
  searchRequestId: string;
  structureRequestId: string;
};

export type InspirationProvider = {
  analyze(input: {
    prompt: string;
    signal: AbortSignal;
  }): Promise<InspirationProviderOutput>;
};

type QwenProviderConfig = {
  apiKey: string;
  nativeBaseUrl: string;
  openaiBaseUrl: string;
  searchModel: ServerEnv["INSPIRATION_SEARCH_MODEL"];
  structureModel: ServerEnv["INSPIRATION_STRUCTURE_MODEL"];
};

type Stage = "search" | "structure";

function stageError(stage: Stage, failure: "timeout" | "transport" | "content") {
  if (stage === "search") {
    return failure === "timeout"
      ? new AppError("INSPIRATION_SEARCH_TIMEOUT", 504, "Inspiration search timed out")
      : new AppError("INSPIRATION_SEARCH_UNAVAILABLE", failure === "transport" ? 503 : 502, "Inspiration search is unavailable");
  }
  if (failure === "timeout") {
    return new AppError("INSPIRATION_STRUCTURE_TIMEOUT", 504, "Inspiration structuring timed out");
  }
  return failure === "transport"
    ? new AppError("INSPIRATION_STRUCTURE_UNAVAILABLE", 503, "Inspiration structuring is unavailable")
    : new AppError("INSPIRATION_STRUCTURE_INVALID", 502, "Invalid inspiration structure");
}

export function createQwenInspirationProvider(
  config: QwenProviderConfig,
  fetchImpl: typeof fetch = fetch,
): InspirationProvider {
  const searchEndpoint = `${config.nativeBaseUrl.replace(/\/$/, "")}/services/aigc/text-generation/generation`;
  const structureEndpoint = `${config.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`;

  async function runStage<T>(
    stage: Stage,
    endpoint: string,
    request: unknown,
    callerSignal: AbortSignal,
    parse: (value: unknown) => T,
  ): Promise<T> {
    callerSignal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(stage === "search" ? SEARCH_DEADLINE_MS : STRUCTURE_DEADLINE_MS);
    const signal = AbortSignal.any([callerSignal, timeoutSignal]);
    let failure: "transport" | "content" = "transport";
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        cache: "no-store",
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        // Never parse or expose provider error bodies. Cancellation is best effort.
        try { void response.body?.cancel().catch(() => undefined); } catch { /* Ignore cancellation errors. */ }
        throw stageError(stage, "transport");
      }
      failure = "content";
      const value = await readBoundedJson(response, signal, MAX_RESPONSE_BYTES);
      const parsed = parse(value);
      signal.throwIfAborted();
      return parsed;
    } catch (error) {
      if (callerSignal.aborted) throw callerSignal.reason;
      if (timeoutSignal.aborted) throw stageError(stage, "timeout");
      if (stage === "search" && error instanceof QwenProtocolError && error.code === "INSPIRATION_SEARCH_EMPTY") {
        throw new AppError("INSPIRATION_SEARCH_EMPTY", 502, "Inspiration search returned no sources");
      }
      throw stageError(stage, failure);
    }
  }

  return {
    async analyze(input) {
      const search = await runStage(
        "search", searchEndpoint,
        buildQwenSearchRequest({ prompt: input.prompt, model: config.searchModel }),
        input.signal, parseQwenSearchResponse,
      );
      const structure = await runStage(
        "structure", structureEndpoint,
        buildQwenStructureRequest({ prompt: input.prompt, searchText: search.searchText, sources: search.sources, model: config.structureModel }),
        input.signal, (value) => parseQwenStructureResponse(value, search.sources),
      );
      return {
        sources: search.sources,
        result: structure.result,
        searchRequestId: search.requestId,
        structureRequestId: structure.requestId,
      };
    },
  };
}

export function getQwenInspirationProvider(): InspirationProvider {
  const env = getServerEnv();
  if (
    !env.INSPIRATION_ENABLED || !env.DASHSCOPE_API_KEY ||
    !env.DASHSCOPE_WORKSPACE_ID || !env.DASHSCOPE_NATIVE_BASE_URL ||
    !env.DASHSCOPE_OPENAI_BASE_URL
  ) {
    throw new AppError("INSPIRATION_DISABLED", 503, "Inspiration analysis is disabled");
  }
  return createQwenInspirationProvider({
    apiKey: env.DASHSCOPE_API_KEY,
    nativeBaseUrl: env.DASHSCOPE_NATIVE_BASE_URL,
    openaiBaseUrl: env.DASHSCOPE_OPENAI_BASE_URL,
    searchModel: env.INSPIRATION_SEARCH_MODEL,
    structureModel: env.INSPIRATION_STRUCTURE_MODEL,
  });
}
