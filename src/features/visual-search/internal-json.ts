import "server-only";

export const MAX_INTERNAL_SEARCH_RESPONSE_BYTES = 64 * 1024;

export async function readBoundedInternalJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes = MAX_INTERNAL_SEARCH_RESPONSE_BYTES,
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
    if (signal.aborted) {
      onAbort();
      throw abortReason();
    }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortReason();
      if (done) break;
      if (value.byteLength > maximumBytes - byteLength) {
        const error = new Error("Internal search response is too large");
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
