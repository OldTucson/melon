import "server-only";

import {
  readBoundedInternalJson,
} from "@/features/visual-search/internal-json";
import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";

import {
  internalPaletteSearchRequestSchema,
  internalPaletteSearchResponseSchema,
  type InternalPaletteSearchResponse,
} from "./contracts";

const INTERNAL_TIMEOUT_MS = 12_000;

const publicErrors = {
  INVALID_COLORS: [
    "PALETTE_SEARCH_INVALID_COLORS",
    400,
    "Invalid palette colors",
  ],
  NO_INDEX: [
    "PALETTE_SEARCH_NO_INDEX",
    409,
    "No searchable palette index",
  ],
  TIMEOUT: ["PALETTE_SEARCH_TIMEOUT", 504, "Palette search timed out"],
  UNAVAILABLE: [
    "PALETTE_SEARCH_UNAVAILABLE",
    503,
    "Palette search is unavailable",
  ],
} as const;

type InternalErrorCode = keyof typeof publicErrors;

export type InternalPaletteSearchInput = {
  ownerId: string;
  allowedPatternIds: readonly string[];
  requestId: string;
  colors: readonly string[];
  signal: AbortSignal;
};

export type InternalPaletteSearchClient = {
  search(
    input: InternalPaletteSearchInput,
  ): Promise<InternalPaletteSearchResponse>;
};

type Fetch = typeof fetch;

function publicError(code: InternalErrorCode) {
  const [publicCode, status, message] = publicErrors[code];
  return new AppError(publicCode, status, message);
}

function unavailable() {
  return publicError("UNAVAILABLE");
}

async function readInternalError(
  response: Response,
  signal: AbortSignal,
): Promise<InternalErrorCode> {
  try {
    const body = await readBoundedInternalJson(response, signal);
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
    // Invalid internal error bodies are deliberately collapsed.
  }
  return "UNAVAILABLE";
}

function equalColors(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((color, index) => color === right[index])
  );
}

export function createInternalPaletteSearchClient(
  config: { serviceUrl: string; token: string },
  fetchImpl: Fetch = fetch,
): InternalPaletteSearchClient {
  const endpoint = `${config.serviceUrl.replace(/\/$/, "")}/internal/palette-search`;

  return {
    async search(input) {
      const request = internalPaletteSearchRequestSchema.safeParse({
        ownerId: input.ownerId,
        allowedPatternIds: input.allowedPatternIds,
        requestId: input.requestId,
        colors: input.colors,
      });
      if (!request.success) throw publicError("INVALID_COLORS");

      const timeoutSignal = AbortSignal.timeout(INTERNAL_TIMEOUT_MS);
      const signal = AbortSignal.any([input.signal, timeoutSignal]);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request.data),
          cache: "no-store",
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason ?? error;
        if (timeoutSignal.aborted) throw publicError("TIMEOUT");
        throw unavailable();
      }

      if (!response.ok) {
        const code = await readInternalError(response, signal);
        if (input.signal.aborted) throw input.signal.reason ?? unavailable();
        if (timeoutSignal.aborted) throw publicError("TIMEOUT");
        throw publicError(code);
      }

      try {
        const parsed = internalPaletteSearchResponseSchema.parse(
          await readBoundedInternalJson(response, signal),
        );
        if (
          parsed.requestId !== request.data.requestId ||
          !equalColors(parsed.query.colors, request.data.colors)
        ) {
          throw unavailable();
        }
        return parsed;
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason ?? error;
        if (timeoutSignal.aborted) throw publicError("TIMEOUT");
        if (error instanceof AppError) throw error;
        throw unavailable();
      }
    },
  };
}

export function getInternalPaletteSearchClient(): InternalPaletteSearchClient {
  const env = getServerEnv();
  if (
    !env.IMAGE_SEARCH_ENABLED ||
    !env.IMAGE_SEARCH_SERVICE_URL ||
    !env.IMAGE_SEARCH_INTERNAL_TOKEN
  ) {
    throw unavailable();
  }
  return createInternalPaletteSearchClient({
    serviceUrl: env.IMAGE_SEARCH_SERVICE_URL,
    token: env.IMAGE_SEARCH_INTERNAL_TOKEN,
  });
}
