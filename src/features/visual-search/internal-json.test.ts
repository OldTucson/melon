import { describe, expect, it, vi } from "vitest";

import {
  MAX_INTERNAL_SEARCH_RESPONSE_BYTES,
  readBoundedInternalJson,
} from "./internal-json";

describe("bounded internal JSON reader", () => {
  it("parses a chunked JSON response within the byte limit", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"ok":'));
          controller.enqueue(encoder.encode("true}"));
          controller.close();
        },
      }),
    );

    await expect(
      readBoundedInternalJson(response, new AbortController().signal),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects the first chunk over the remaining allowance and releases resources", async () => {
    const signal = new AbortController().signal;
    const addListener = vi.spyOn(signal, "addEventListener");
    const removeListener = vi.spyOn(signal, "removeEventListener");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });

    await expect(
      readBoundedInternalJson(new Response(body), signal, 4),
    ).rejects.toThrow("too large");

    expect(cancel).toHaveBeenCalledOnce();
    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(body.locked).toBe(false);
    expect(MAX_INTERNAL_SEARCH_RESPONSE_BYTES).toBe(64 * 1024);
  });

  it("propagates abort while stalled cancellation remains pending", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = readBoundedInternalJson(
      new Response(body),
      controller.signal,
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
