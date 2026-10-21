import "server-only";

import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";

import {
  internalImageSearchResponseSchema,
  type InternalImageSearchResponse,
} from "./contracts";

const INTERNAL_TIMEOUT_MS = 12_000;
// The schema allows only 30 compact matches; 64 KiB leaves ample JSON overhead.
export const MAX_INTERNAL_IMAGE_SEARCH_RESPONSE_BYTES = 64 * 1024;

const publicErrors = {
  INVALID_FILE: ["IMAGE_SEARCH_INVALID_FILE", 415, "Invalid search image"],
  IMAGE_TOO_LARGE: [
    "IMAGE_SEARCH_IMAGE_TOO_LARGE",
    413,
    "Search image is too large",
  ],
  NO_INDEX: ["IMAGE_SEARCH_NO_INDEX", 409, "No searchable image index"],
  BUSY: ["IMAGE_SEARCH_BUSY", 429, "Image search is busy"],
  TIMEOUT: ["IMAGE_SEARCH_TIMEOUT", 504, "Image search timed out"],
  UNAVAILABLE: [
    "IMAGE_SEARCH_UNAVAILABLE",
    503,
    "Image search is unavailable",
  ],
} as const;

type InternalErrorCode = keyof typeof publicErrors;

export type InternalImageSearchInput = {
  ownerId: string;
  image: File;
  allowedPatternIds: readonly string[];
  requestId: string;
  signal: AbortSignal;
};

export type InternalImageSearchClient = {
  search(input: InternalImageSearchInput): Promise<InternalImageSearchResponse>;
};

type Fetch = typeof fetch;

function publicError(code: InternalErrorCode) {
  const [publicCode, status, message] = publicErrors[code];
  return new AppError(publicCode, status, message);
}

function unavailable() {
  return publicError("UNAVAILABLE");
}

async function readResponseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const abortReason = () =>
    signal.reason ?? new DOMException("Request aborted", "AbortError");
  const cancelReader = (reason: unknown) => {
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // Cancellation is best effort; the request deadline must still win.
    }
  };
  const onAbort = () => cancelReader(abortReason());
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal.aborted) onAbort();
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortReason();
      if (done) break;
      if (
        value.byteLength >
        MAX_INTERNAL_IMAGE_SEARCH_RESPONSE_BYTES - byteLength
      ) {
        const error = new Error("Internal image search response is too large");
        cancelReader(error);
        throw error;
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function readInternalError(
  response: Response,
  signal: AbortSignal,
): Promise<InternalErrorCode> {
  try {
    const body = await readResponseJson(response, signal);
    if (
      typeof body === "object" &&
      body !== null &&
      "detail" in body &&
      typeof body.detail === "object" &&
      body.detail !== null &&
      "code" in body.detail &&
      typeof body.detail.code === "string" &&
      Object.hasOwn(publicErrors, body.detail.code)
    ) {
      return body.detail.code as InternalErrorCode;
    }
  } catch {
    // Invalid error bodies are deliberately collapsed to UNAVAILABLE.
  }
  return "UNAVAILABLE";
}

export function createInternalImageSearchClient(
  config: { serviceUrl: string; token: string },
  fetchImpl: Fetch = fetch,
): InternalImageSearchClient {
  const endpoint = `${config.serviceUrl.replace(/\/$/, "")}/internal/search`;

  return {
    async search(input) {
      const form = new FormData();
      form.set("image", input.image, input.image.name);
      form.set("ownerId", input.ownerId);
      form.set("allowedPatternIds", JSON.stringify(input.allowedPatternIds));
      form.set("requestId", input.requestId);

      const timeoutSignal = AbortSignal.timeout(INTERNAL_TIMEOUT_MS);
      const signal = AbortSignal.any([input.signal, timeoutSignal]);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}` },
          body: form,
          cache: "no-store",
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (input.signal.aborted) {
          throw input.signal.reason ?? error;
        }
        if (timeoutSignal.aborted) throw publicError("TIMEOUT");
        throw unavailable();
      }

      if (!response.ok) {
        const code = await readInternalError(response, signal);
        if (input.signal.aborted) {
          throw input.signal.reason ?? unavailable();
        }
        if (timeoutSignal.aborted) throw publicError("TIMEOUT");
        throw publicError(code);
      }

      try {
        const parsed = internalImageSearchResponseSchema.parse(
          await readResponseJson(response, signal),
        );
        if (parsed.requestId !== input.requestId) throw unavailable();
        return parsed;
      } catch (error) {
        if (input.signal.aborted) {
          throw input.signal.reason ?? error;
        }
        if (timeoutSignal.aborted) throw publicError("TIMEOUT");
        if (error instanceof AppError) throw error;
        throw unavailable();
      }
    },
  };
}

export function getInternalImageSearchClient(): InternalImageSearchClient {
  const env = getServerEnv();
  if (
    !env.IMAGE_SEARCH_ENABLED ||
    !env.IMAGE_SEARCH_SERVICE_URL ||
    !env.IMAGE_SEARCH_INTERNAL_TOKEN
  ) {
    throw unavailable();
  }
  return createInternalImageSearchClient({
    serviceUrl: env.IMAGE_SEARCH_SERVICE_URL,
    token: env.IMAGE_SEARCH_INTERNAL_TOKEN,
  });
}
