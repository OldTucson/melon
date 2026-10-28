import { describe, expect, it, vi } from "vitest";

import { readBoundedJson } from "./bounded-json";

describe("bounded JSON reader", () => {
  it("parses chunked JSON within the exact UTF-8 byte limit", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"ok":"好"}');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    await expect(readBoundedJson(new Response(body), new AbortController().signal, bytes.byteLength))
      .resolves.toEqual({ ok: "好" });
    expect(body.locked).toBe(false);
  });

  it("cancels a body that exceeds two MiB without awaiting cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel,
    });
    await expect(readBoundedJson(new Response(body, { headers: { "content-length": "1" } }), new AbortController().signal, 2 * 1024 * 1024))
      .rejects.toThrow(/too large/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("counts accumulated chunks toward the allowance", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
      },
      cancel,
    });
    await expect(readBoundedJson(new Response(body), new AbortController().signal, 5)).rejects.toThrow(/too large/i);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates abort while stalled cancellation remains pending", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = readBoundedJson(new Response(body), controller.signal, 64 * 1024);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("rejects an already aborted reader and removes its listener", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(readBoundedJson(new Response(body), controller.signal, 10)).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(body.locked).toBe(false);
  });

  it("rejects missing bodies and malformed JSON", async () => {
    await expect(readBoundedJson(new Response(null), new AbortController().signal, 100)).rejects.toThrow(/body/i);
    await expect(readBoundedJson(new Response("{"), new AbortController().signal, 100)).rejects.toBeInstanceOf(SyntaxError);
  });
});
