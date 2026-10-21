"use client";

import type { PatternItem } from "@/features/library/library-types";
import { readApiResponse } from "@/lib/query/client";

import type {
  ImageSearchFiltersInput,
  ImageSearchMatchKind,
} from "./contracts";

export const MAX_CLIENT_IMAGE_SEARCH_BYTES = 20 * 1024 * 1024;

const acceptedTypes = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
]);

export type ImageSearchResponse = {
  query: { width: number; height: number };
  groups: Array<{
    kind: ImageSearchMatchKind;
    items: Array<PatternItem & { matchKind: ImageSearchMatchKind }>;
  }>;
  timing: { totalMs: number };
};

export class ImageSearchFileError extends Error {
  readonly code: "too_large" | "unsupported";

  constructor(code: "too_large" | "unsupported") {
    super(code);
    this.name = "ImageSearchFileError";
    this.code = code;
  }
}

export function validateImageSearchFile(file: File) {
  if (file.size > MAX_CLIENT_IMAGE_SEARCH_BYTES) {
    throw new ImageSearchFileError("too_large");
  }
  const extension = file.name.toLowerCase().split(".").pop();
  if (
    file.size === 0 ||
    !extension ||
    acceptedTypes.get(extension) !== file.type.toLowerCase()
  ) {
    throw new ImageSearchFileError("unsupported");
  }
}

type BrowserFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function searchPatternsByImage(
  input: {
    file: File;
    filters: ImageSearchFiltersInput;
    requestId: string;
    signal: AbortSignal;
  },
  dependencies: { fetcher?: BrowserFetch } = {},
) {
  validateImageSearchFile(input.file);
  const body = new FormData();
  body.set("image", input.file, input.file.name);
  body.set("filters", JSON.stringify(input.filters));
  body.set("requestId", input.requestId);
  return readApiResponse<ImageSearchResponse>(
    await (dependencies.fetcher ?? fetch)("/api/image-search", {
      method: "POST",
      body,
      signal: input.signal,
    }),
  );
}
