import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { MAX_INTERNAL_SEARCH_RESPONSE_BYTES } from "@/features/visual-search/internal-json";

import {
  createInternalImageSearchClient,
  MAX_INTERNAL_IMAGE_SEARCH_RESPONSE_BYTES,
} from "./internal-client";

const ownerId = "10000000-0000-4000-8000-000000000001";
const patternId = "20000000-0000-4000-8000-000000000002";
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const config = {
  serviceUrl: "http://127.0.0.1:8091",
  token: "t".repeat(32),
};

type Settlement =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; error: unknown }
  | { status: "pending" };

function settleWithin(
  promise: Promise<unknown>,
  milliseconds = 100,
): Promise<Settlement> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: "pending" }), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ status: "fulfilled", value });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        resolve({ status: "rejected", error });
      },
    );
  });
}

describe("internal image search client", () => {
  it("keeps the legacy response limit as the shared reader alias", () => {
    expect(MAX_INTERNAL_IMAGE_SEARCH_RESPONSE_BYTES).toBe(
      MAX_INTERNAL_SEARCH_RESPONSE_BYTES,
    );
  });

  it("sends only the four locked multipart fields with bearer auth", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${config.token}`,
      );
      const form = init?.body as FormData;
      expect([...form.keys()].sort()).toEqual([
        "allowedPatternIds",
        "image",
        "ownerId",
        "requestId",
      ]);
      expect(form.has("activeVersion")).toBe(false);
      expect(form.get("ownerId")).toBe(ownerId);
      expect(form.get("allowedPatternIds")).toBe(JSON.stringify([patternId]));
      expect(form.get("requestId")).toBe(requestId);
      expect(form.get("image")).toBeInstanceOf(File);
      return Response.json({
        requestId,
        query: { width: 400, height: 368 },
        items: [{ patternId, kind: "possible_source", score: 0.91 }],
      });
    });
    const client = createInternalImageSearchClient(config, fetchImpl);

    const response = await client.search({
      ownerId,
      allowedPatternIds: [patternId],
      requestId,
      image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
      signal: new AbortController().signal,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8091/internal/search",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    expect(response.items[0]).toMatchObject({ patternId, score: 0.91 });
  });

  it.each([
    ["INVALID_FILE", "IMAGE_SEARCH_INVALID_FILE", 415],
    ["IMAGE_TOO_LARGE", "IMAGE_SEARCH_IMAGE_TOO_LARGE", 413],
    ["NO_INDEX", "IMAGE_SEARCH_NO_INDEX", 409],
    ["BUSY", "IMAGE_SEARCH_BUSY", 429],
    ["TIMEOUT", "IMAGE_SEARCH_TIMEOUT", 504],
    ["UNAVAILABLE", "IMAGE_SEARCH_UNAVAILABLE", 503],
  ] as const)("maps internal %s to public %s", async (internal, code, status) => {
    const client = createInternalImageSearchClient(
      config,
      vi.fn(async () =>
        Response.json({ detail: { code: internal } }, { status }),
      ),
    );

    await expect(
      client.search({
        ownerId,
        allowedPatternIds: [patternId],
        requestId,
        image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code, status });
  });

  it("collapses inherited Object prototype error codes to unavailable", async () => {
    const client = createInternalImageSearchClient(
      config,
      vi.fn(async () =>
        Response.json({ detail: { code: "toString" } }, { status: 500 }),
      ),
    );

    await expect(
      client.search({
        ownerId,
        allowedPatternIds: [patternId],
        requestId,
        image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "IMAGE_SEARCH_UNAVAILABLE",
      status: 503,
    });
  });

  it("maps invalid responses and network failures without leaking internals", async () => {
    for (const fetchImpl of [
      vi.fn(async () => Response.json({ token: config.token, items: [] })),
      vi.fn(async () => {
        throw new Error(`connect failed ${config.token} /private/model.onnx`);
      }),
    ]) {
      const client = createInternalImageSearchClient(config, fetchImpl);
      let thrown: unknown;
      try {
        await client.search({
          ownerId,
          allowedPatternIds: [patternId],
          requestId,
          image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
          signal: new AbortController().signal,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "IMAGE_SEARCH_UNAVAILABLE",
        status: 503,
      });
      expect(String(thrown)).not.toContain(config.token);
      expect(String(thrown)).not.toContain("model.onnx");
    }
  });

  it("rejects a response for a different request ID", async () => {
    const client = createInternalImageSearchClient(
      config,
      vi.fn(async () =>
        Response.json({
          requestId: randomUUID(),
          query: { width: 400, height: 368 },
          items: [],
        }),
      ),
    );

    await expect(
      client.search({
        ownerId,
        allowedPatternIds: [patternId],
        requestId,
        image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "IMAGE_SEARCH_UNAVAILABLE",
      status: 503,
    });
  });

  it.each([200, 500])(
    "bounds a %i response body without trusting Content-Length",
    async (status) => {
      const timeout = new AbortController();
      const timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(timeout.signal);
      const cancelBody = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024 + 1));
        },
        cancel: cancelBody,
      });
      let addListener: ReturnType<typeof vi.spyOn> | undefined;
      let removeListener: ReturnType<typeof vi.spyOn> | undefined;
      const client = createInternalImageSearchClient(
        config,
        vi.fn(async (_url, init) => {
          const signal = init?.signal;
          addListener = vi.spyOn(signal!, "addEventListener");
          removeListener = vi.spyOn(signal!, "removeEventListener");
          return new Response(body, {
            status,
            headers: { "content-length": "1" },
          });
        }),
      );
      const pending = client.search({
        ownerId,
        allowedPatternIds: [patternId],
        requestId,
        image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
        signal: new AbortController().signal,
      });

      const settlement = await settleWithin(pending);
      const cancelCallsBeforeCleanup = cancelBody.mock.calls.length;
      const removeCallsBeforeCleanup = removeListener?.mock.calls.length;
      const lockedBeforeCleanup = body.locked;
      timeout.abort(new DOMException("test cleanup", "TimeoutError"));
      await settleWithin(pending);
      timeoutSpy.mockRestore();

      expect(settlement).toMatchObject({
        status: "rejected",
        error: { code: "IMAGE_SEARCH_UNAVAILABLE", status: 503 },
      });
      expect(cancelCallsBeforeCleanup).toBe(1);
      expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), {
        once: true,
      });
      expect(removeCallsBeforeCleanup).toBe(1);
      expect(lockedBeforeCleanup).toBe(false);
    },
  );

  it("combines caller cancellation with a 12-second timeout", async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client = createInternalImageSearchClient(
      config,
      vi.fn((_url, init) => {
        receivedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason),
            { once: true },
          );
        });
      }),
    );
    const pending = client.search({
      ownerId,
      allowedPatternIds: [patternId],
      requestId: randomUUID(),
      image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
      signal: caller.signal,
    });

    caller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("maps its own 12-second timeout to a stable public error", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const client = createInternalImageSearchClient(
      config,
      vi.fn((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
      ),
    );
    const pending = client.search({
      ownerId,
      allowedPatternIds: [patternId],
      requestId,
      image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
      signal: new AbortController().signal,
    });

    timeout.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({
      code: "IMAGE_SEARCH_TIMEOUT",
      status: 504,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(12_000);
  });

  it("keeps the timeout mapping while reading a stalled response body", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    let receivedSignal: AbortSignal | undefined;
    let addListener: ReturnType<typeof vi.spyOn> | undefined;
    let removeListener: ReturnType<typeof vi.spyOn> | undefined;
    const cancelBody = vi.fn(() => new Promise<void>(() => undefined));
    const client = createInternalImageSearchClient(
      config,
      vi.fn(async (_url, init) => {
        receivedSignal = init?.signal ?? undefined;
        addListener = vi.spyOn(receivedSignal!, "addEventListener");
        removeListener = vi.spyOn(receivedSignal!, "removeEventListener");
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: cancelBody,
          }),
          { status: 200 },
        );
      }),
    );
    const pending = client.search({
      ownerId,
      allowedPatternIds: [patternId],
      requestId,
      image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    timeout.abort(new DOMException("timed out", "TimeoutError"));

    const settlement = await settleWithin(pending);
    expect(settlement).toMatchObject({
      status: "rejected",
      error: { code: "IMAGE_SEARCH_TIMEOUT", status: 504 },
    });
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  }, 1_000);

  it("propagates caller abort while stalled body cancellation never settles", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const caller = new AbortController();
    const abortReason = new DOMException("cancelled", "AbortError");
    let receivedSignal: AbortSignal | undefined;
    let addListener: ReturnType<typeof vi.spyOn> | undefined;
    let removeListener: ReturnType<typeof vi.spyOn> | undefined;
    const cancelBody = vi.fn(() => new Promise<void>(() => undefined));
    const client = createInternalImageSearchClient(
      config,
      vi.fn(async (_url, init) => {
        receivedSignal = init?.signal ?? undefined;
        addListener = vi.spyOn(receivedSignal!, "addEventListener");
        removeListener = vi.spyOn(receivedSignal!, "removeEventListener");
        return new Response(
          new ReadableStream<Uint8Array>({ cancel: cancelBody }),
          { status: 200 },
        );
      }),
    );
    const pending = client.search({
      ownerId,
      allowedPatternIds: [patternId],
      requestId,
      image: new File(["jpeg"], "query.jpg", { type: "image/jpeg" }),
      signal: caller.signal,
    });

    await vi.waitFor(() =>
      expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), {
        once: true,
      }),
    );
    caller.abort(abortReason);

    const settlement = await settleWithin(pending);
    expect(settlement.status).toBe("rejected");
    if (settlement.status === "rejected") {
      expect(settlement.error).toBe(abortReason);
    }
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(receivedSignal?.aborted).toBe(true);
  }, 1_000);
});
