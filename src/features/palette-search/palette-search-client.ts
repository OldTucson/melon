"use client";

import { readApiResponse } from "@/lib/query/client";

import type {
  PaletteSearchRequest,
  PaletteSearchResponse,
} from "./contracts";

type BrowserFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function searchPatternsByPalette(
  input: PaletteSearchRequest & { signal: AbortSignal },
  dependencies: { fetcher?: BrowserFetch } = {},
) {
  return readApiResponse<PaletteSearchResponse>(
    await (dependencies.fetcher ?? fetch)("/api/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: input.requestId,
        colors: input.colors,
        filters: input.filters,
      }),
      signal: input.signal,
    }),
  );
}
