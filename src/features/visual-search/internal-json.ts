import "server-only";

import { readBoundedJson } from "@/lib/http/bounded-json";

export const MAX_INTERNAL_SEARCH_RESPONSE_BYTES = 64 * 1024;

export function readBoundedInternalJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes = MAX_INTERNAL_SEARCH_RESPONSE_BYTES,
): Promise<unknown> {
  return readBoundedJson(response, signal, maximumBytes);
}
