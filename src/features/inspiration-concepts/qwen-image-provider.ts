import "server-only";

import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import { readBoundedJson } from "@/lib/http/bounded-json";
import type { ConceptOutputKind } from "./contracts";
import { buildQwenImageRequest, parseQwenImageCreateResponse, parseQwenImageQueryResponse, QwenImageProtocolRejection, type QwenImageTaskState } from "./qwen-image-protocol";

export type { QwenImageTaskState } from "./qwen-image-protocol";
export interface QwenImageProvider {
  createTask(input: { kind: ConceptOutputKind; prompt: string; images: readonly string[]; signal: AbortSignal }): Promise<{ taskId: string; requestId: string }>;
  queryTask(input: { taskId: string; signal: AbortSignal }): Promise<QwenImageTaskState>;
}
export class QwenImageSubmissionError extends AppError {
  constructor(readonly definitelyNotAccepted: boolean, safetyRejected = false) {
    const code = definitelyNotAccepted ? (safetyRejected ? "INSPIRATION_CONCEPT_REJECTED" : "INSPIRATION_CONCEPT_UNAVAILABLE") : "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN";
    super(code, 503, code);
  }
}
const unavailable = (timeout = false) => {
  const code = timeout ? "INSPIRATION_CONCEPT_TIMEOUT" : "INSPIRATION_CONCEPT_UNAVAILABLE";
  return new AppError(code, timeout ? 504 : 503, code);
};
function cancelBody(response: Response) {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Best effort. */ }
}

export function createQwenImageProvider(config: { apiKey: string; nativeBaseUrl: string }, fetchImpl: typeof fetch = fetch): QwenImageProvider {
  // Config comes from the validated server environment, never request input.
  const baseUrl = config.nativeBaseUrl.replace(/\/$/, "");
  async function request<T>(path: string, callerSignal: AbortSignal, parse: (value: unknown) => T, body?: unknown): Promise<T> {
    const creating = body !== undefined;
    if (callerSignal.aborted) throw creating ? new QwenImageSubmissionError(true) : unavailable();
    const controller = new AbortController();
    let timedOut = false;
    let transmitted = false;
    const onCallerAbort = () => controller.abort();
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, creating ? 30_000 : 15_000);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(unavailable(timedOut));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (callerSignal.aborted) throw unavailable();
      transmitted = true;
      const pending = fetchImpl(`${baseUrl}${path}`, {
        method: creating ? "POST" : "GET",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", ...(creating ? { "X-DashScope-Async": "enable" } : {}) },
        ...(creating ? { body: JSON.stringify(body) } : {}),
        cache: "no-store", redirect: "error", signal: controller.signal,
      }).then((response) => { if (controller.signal.aborted) cancelBody(response); return response; });
      const response = await Promise.race([pending, aborted]);
      if (!response.ok) { cancelBody(response); throw unavailable(); }
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        cancelBody(response); throw unavailable();
      }
      const value = await Promise.race([readBoundedJson(response, controller.signal, 256 * 1024), aborted]);
      if (controller.signal.aborted) throw unavailable();
      return parse(value);
    } catch (error) {
      if (creating) {
        if (!controller.signal.aborted && error instanceof QwenImageProtocolRejection) throw new QwenImageSubmissionError(true, error.safetyRejected);
        throw new QwenImageSubmissionError(!transmitted);
      }
      throw unavailable(timedOut);
    } finally {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
  return {
    async createTask(input) {
      let body: ReturnType<typeof buildQwenImageRequest>;
      try { body = buildQwenImageRequest(input); } catch { throw new QwenImageSubmissionError(true); }
      return request("/services/aigc/image-generation/generation", input.signal, parseQwenImageCreateResponse, body);
    },
    async queryTask(input) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.taskId)) throw unavailable();
      return request(`/tasks/${encodeURIComponent(input.taskId)}`, input.signal, (value) => parseQwenImageQueryResponse(value, input.taskId));
    },
  };
}

export function getQwenImageProvider(): QwenImageProvider {
  try {
    const env = getServerEnv();
    if (!env.INSPIRATION_ENABLED || !env.INSPIRATION_CONCEPT_IMAGES_ENABLED || !env.DASHSCOPE_API_KEY || !env.DASHSCOPE_NATIVE_BASE_URL) throw unavailable();
    return createQwenImageProvider({ apiKey: env.DASHSCOPE_API_KEY, nativeBaseUrl: env.DASHSCOPE_NATIVE_BASE_URL });
  } catch {
    throw new AppError("INSPIRATION_CONCEPT_DISABLED", 503, "INSPIRATION_CONCEPT_DISABLED");
  }
}
