import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UPLOAD_REQUEST_TIMEOUT_MS,
  UPLOAD_WRITE_DRAIN_SCHEDULING_MARGIN_MS,
} from "@/features/storage/upload-timing";

import { replaceManualPreview } from "./manual-preview-client";

const mocks = vi.hoisted(() => ({
  generateRasterPreview: vi.fn(),
  put: vi.fn(),
}));

vi.mock("./raster-preview", () => ({
  generateRasterPreview: (...args: unknown[]) =>
    mocks.generateRasterPreview(...args),
}));

vi.mock("@/features/uploads/oss-browser-client", () => ({
  alibabaBrowserMultipartClient: {
    put: (...args: unknown[]) => mocks.put(...args),
  },
}));

const credentials = {
  accessKeyId: "temporary-id",
  accessKeySecret: "temporary-secret",
  securityToken: "temporary-token",
  expiration: "2026-10-20T06:00:00.000Z",
  region: "oss-cn-hangzhou",
  bucket: "melon-test",
  endpoint: "https://assets.example.test",
  cname: true,
};

const completionRecoveryTimeoutMs =
  UPLOAD_REQUEST_TIMEOUT_MS * 2 + UPLOAD_WRITE_DRAIN_SCHEDULING_MARGIN_MS;

function initializationResponse() {
  return new Response(
    JSON.stringify({
      operationId: "operation-1",
      patternId: "pattern-1",
      version: 4,
      extension: "webp",
      assets: {
        preview: {
          assetId: "preview-id",
          role: "preview",
          objectKey: "derived/preview.webp",
          extension: "webp",
        },
        thumbnail: {
          assetId: "thumbnail-id",
          role: "thumbnail",
          objectKey: "derived/thumbnail.webp",
          extension: "webp",
        },
      },
      credentials,
    }),
    { status: 200 },
  );
}

function neverSettlingRequest(
  signal: AbortSignal | null | undefined,
  signals: AbortSignal[],
) {
  if (signal) signals.push(signal);
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<
    | { status: "resolved"; value: T }
    | { status: "rejected"; error: unknown }
    | { status: "pending" }
  >((resolve) => {
    const timer = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ status: "resolved", value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ status: "rejected", error });
      },
    );
  });
}

function expectAbortListenersReleased(
  added: ReturnType<typeof vi.spyOn>,
  removed: ReturnType<typeof vi.spyOn>,
) {
  const addedCount = added.mock.calls.filter(
    (call: unknown[]) => call[0] === "abort",
  ).length;
  const removedCount = removed.mock.calls.filter(
    (call: unknown[]) => call[0] === "abort",
  ).length;
  expect(addedCount).toBeGreaterThan(0);
  expect(removedCount).toBe(addedCount);
}

describe("manual preview client", () => {
  beforeEach(() => {
    mocks.generateRasterPreview.mockReset();
    mocks.put.mockReset();
    mocks.generateRasterPreview.mockResolvedValue({
      preview: new Blob(["preview"], { type: "image/webp" }),
      thumbnail: new Blob(["thumbnail"], { type: "image/webp" }),
      previewWidth: 1600,
      previewHeight: 1200,
      thumbnailWidth: 512,
      thumbnailHeight: 384,
      outputType: "image/webp",
    });
    mocks.put.mockImplementation(async ({ onProgress }) => onProgress(1));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uploads both generated assets before completing the replacement", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            operationId: "operation-1",
            patternId: "pattern-1",
            version: 4,
            extension: "webp",
            assets: {
              preview: {
                assetId: "preview-id",
                role: "preview",
                objectKey: "derived/preview.webp",
                extension: "webp",
              },
              thumbnail: {
                assetId: "thumbnail-id",
                role: "thumbnail",
                objectKey: "derived/thumbnail.webp",
                extension: "webp",
              },
            },
            credentials,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            pattern: { id: "pattern-1", version: 5, previewStatus: "manual" },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    const file = new File(["jpeg"], "cover.jpg", { type: "image/jpeg" });

    await expect(
      replaceManualPreview({
        patternId: "pattern-1",
        version: 4,
        file,
        onProgress: progress,
      }),
    ).resolves.toMatchObject({ pattern: { version: 5 } });

    expect(mocks.generateRasterPreview).toHaveBeenCalledWith(file);
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.put.mock.calls[0]![0]).toMatchObject({
      objectKey: "derived/preview.webp",
      contentType: "image/webp",
    });
    expect(mocks.put.mock.calls[1]![0]).toMatchObject({
      objectKey: "derived/thumbnail.webp",
      contentType: "image/webp",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/patterns/pattern-1/manual-preview/init",
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "/api/patterns/pattern-1/manual-preview/complete",
    );
    const completion = JSON.parse(
      (fetchMock.mock.calls[1]![1] as RequestInit).body as string,
    );
    expect(completion.assets).toEqual([
      expect.objectContaining({ role: "preview", width: 1600, height: 1200 }),
      expect.objectContaining({ role: "thumbnail", width: 512, height: 384 }),
    ]);
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it("replays completion when cancellation reports that completion committed", async () => {
    const completed = {
      pattern: { id: "pattern-1", version: 5, previewStatus: "manual" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            operationId: "operation-1",
            patternId: "pattern-1",
            version: 4,
            extension: "webp",
            assets: {
              preview: {
                assetId: "preview-id",
                role: "preview",
                objectKey: "derived/preview.webp",
                extension: "webp",
              },
              thumbnail: {
                assetId: "thumbnail-id",
                role: "thumbnail",
                objectKey: "derived/thumbnail.webp",
                extension: "webp",
              },
            },
            credentials,
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("COMPLETE_RESPONSE_LOST"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "complete" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completed), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();

    await expect(
      replaceManualPreview({
        patternId: "pattern-1",
        version: 4,
        file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
        onProgress: progress,
      }),
    ).resolves.toEqual(completed);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/patterns/pattern-1/manual-preview/init",
      "/api/patterns/pattern-1/manual-preview/complete",
      "/api/patterns/pattern-1/manual-preview/cancel",
      "/api/patterns/pattern-1/manual-preview/complete",
    ]);
    expect((fetchMock.mock.calls[3]![1] as RequestInit).body).toBe(
      (fetchMock.mock.calls[1]![1] as RequestInit).body,
    );
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it("retries a transient cancellation status failure within the recovery deadline", async () => {
    vi.useFakeTimers();
    const completed = {
      pattern: { id: "pattern-1", version: 5, previewStatus: "manual" },
    };
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(initializationResponse())
      .mockRejectedValueOnce(new Error("COMPLETE_RESPONSE_LOST"))
      .mockRejectedValueOnce(new TypeError("NETWORK_UNAVAILABLE"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "complete" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completed), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const replacement = replaceManualPreview({
      patternId: "pattern-1",
      version: 4,
      file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
      signal: caller.signal,
    });
    const assertion = expect(replacement).resolves.toEqual(completed);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/patterns/pattern-1/manual-preview/init",
      "/api/patterns/pattern-1/manual-preview/complete",
      "/api/patterns/pattern-1/manual-preview/cancel",
      "/api/patterns/pattern-1/manual-preview/cancel",
      "/api/patterns/pattern-1/manual-preview/complete",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expectAbortListenersReleased(added, removed);
  });

  it("retries a transient idempotent completion replay failure", async () => {
    vi.useFakeTimers();
    const completed = {
      pattern: { id: "pattern-1", version: 5, previewStatus: "manual" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(initializationResponse())
      .mockRejectedValueOnce(new Error("COMPLETE_RESPONSE_LOST"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "complete" }), { status: 200 }),
      )
      .mockRejectedValueOnce(new TypeError("REPLAY_RESPONSE_LOST"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "complete" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completed), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const replacement = replaceManualPreview({
      patternId: "pattern-1",
      version: 4,
      file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
    });
    const assertion = expect(replacement).resolves.toEqual(completed);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/patterns/pattern-1/manual-preview/init",
      "/api/patterns/pattern-1/manual-preview/complete",
      "/api/patterns/pattern-1/manual-preview/cancel",
      "/api/patterns/pattern-1/manual-preview/complete",
      "/api/patterns/pattern-1/manual-preview/cancel",
      "/api/patterns/pattern-1/manual-preview/complete",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a non-retryable cancellation status response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(initializationResponse())
      .mockRejectedValueOnce(new Error("COMPLETE_RESPONSE_LOST"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "MANUAL_PREVIEW_OPERATION_MISMATCH",
              message: "Operation does not match",
            },
          }),
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      replaceManualPreview({
        patternId: "pattern-1",
        version: 4,
        file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
      }),
    ).rejects.toMatchObject({
      code: "MANUAL_PREVIEW_OPERATION_MISMATCH",
      status: 409,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("waits for an in-flight completion before replaying it", async () => {
    vi.useFakeTimers();
    const completed = {
      pattern: { id: "pattern-1", version: 5, previewStatus: "manual" },
    };
    const recoveryStartedAt = Date.now();
    let completionRequests = 0;
    const fetchMock = vi.fn<
      (
        request: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response>
    >(async (request) => {
      const url = String(request);
      if (url.endsWith("/init")) {
        return new Response(
          JSON.stringify({
            operationId: "operation-1",
            patternId: "pattern-1",
            version: 4,
            extension: "webp",
            assets: {
              preview: {
                assetId: "preview-id",
                role: "preview",
                objectKey: "derived/preview.webp",
                extension: "webp",
              },
              thumbnail: {
                assetId: "thumbnail-id",
                role: "thumbnail",
                objectKey: "derived/thumbnail.webp",
                extension: "webp",
              },
            },
            credentials,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/complete")) {
        completionRequests += 1;
        if (completionRequests === 1) {
          throw new Error("COMPLETE_RESPONSE_LOST");
        }
        return new Response(JSON.stringify(completed), { status: 200 });
      }
      if (url.endsWith("/cancel")) {
        const state =
          Date.now() - recoveryStartedAt >= UPLOAD_REQUEST_TIMEOUT_MS * 2
            ? "complete"
            : "verifying";
        return new Response(JSON.stringify({ state }), { status: 200 });
      }
      throw new Error(`UNEXPECTED_REQUEST:${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const replacement = replaceManualPreview({
      patternId: "pattern-1",
      version: 4,
      file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
    });
    const assertion = expect(replacement).resolves.toEqual(completed);
    await vi.runAllTimersAsync();
    await assertion;

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/cancel"))
        .length,
    ).toBeGreaterThan(6);
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).body).toBe(
      (fetchMock.mock.calls[1]![1] as RequestInit).body,
    );
  });

  it("times out a never-settling initial completion request", async () => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(initializationResponse())
      .mockImplementationOnce((_url, init: RequestInit | undefined) =>
        neverSettlingRequest(init?.signal, requestSignals),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "cancelled" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const settlement = settleWithin(
      replaceManualPreview({
        patternId: "pattern-1",
        version: 4,
        file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
        signal: caller.signal,
      }),
      UPLOAD_REQUEST_TIMEOUT_MS + 1,
    );
    await vi.advanceTimersByTimeAsync(UPLOAD_REQUEST_TIMEOUT_MS + 1);

    expect(await settlement).toEqual({
      status: "rejected",
      error: expect.objectContaining({
        message: "MANUAL_PREVIEW_REQUEST_TIMEOUT",
      }),
    });
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]).toHaveProperty("aborted", true);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "/api/patterns/pattern-1/manual-preview/cancel",
    );
    expect(vi.getTimerCount()).toBe(0);
    expectAbortListenersReleased(added, removed);
  });

  it("bounds a never-settling cancellation status request", async () => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(initializationResponse())
      .mockRejectedValueOnce(new Error("COMPLETE_RESPONSE_LOST"))
      .mockImplementation((_url, init: RequestInit | undefined) =>
        neverSettlingRequest(init?.signal, requestSignals),
      );
    vi.stubGlobal("fetch", fetchMock);

    const settlement = settleWithin(
      replaceManualPreview({
        patternId: "pattern-1",
        version: 4,
        file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
        signal: caller.signal,
      }),
      completionRecoveryTimeoutMs + 1,
    );
    await vi.advanceTimersByTimeAsync(completionRecoveryTimeoutMs + 1);

    expect(await settlement).toEqual({
      status: "rejected",
      error: expect.objectContaining({ message: "COMPLETE_RESPONSE_LOST" }),
    });
    expect(requestSignals).toHaveLength(3);
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expectAbortListenersReleased(added, removed);
  });

  it("times out a never-settling idempotent completion replay", async () => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    const recoveryStartedAt = Date.now();
    let completionRequests = 0;
    const fetchMock = vi.fn(
      (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/init")) {
          return Promise.resolve(initializationResponse());
        }
        if (String(url).endsWith("/cancel")) {
          const state =
            Date.now() - recoveryStartedAt >= UPLOAD_REQUEST_TIMEOUT_MS * 2
              ? "complete"
              : "verifying";
          return Promise.resolve(
            new Response(JSON.stringify({ state }), { status: 200 }),
          );
        }
        completionRequests += 1;
        if (completionRequests === 1) {
          return Promise.reject(new Error("COMPLETE_RESPONSE_LOST"));
        }
        return neverSettlingRequest(init?.signal, requestSignals);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const settlement = settleWithin(
      replaceManualPreview({
        patternId: "pattern-1",
        version: 4,
        file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
        signal: caller.signal,
      }),
      completionRecoveryTimeoutMs + 1,
    );
    await vi.advanceTimersByTimeAsync(completionRecoveryTimeoutMs + 1);

    expect(await settlement).toEqual({
      status: "rejected",
      error: expect.objectContaining({ message: "COMPLETE_RESPONSE_LOST" }),
    });
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]).toHaveProperty("aborted", true);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/cancel"))
        .length,
    ).toBeGreaterThan(6);
    expect(vi.getTimerCount()).toBe(0);
    expectAbortListenersReleased(added, removed);
  });

  it("preserves an explicit caller abort without entering recovery polling", async () => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    let markCompletionStarted!: () => void;
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(initializationResponse())
      .mockImplementationOnce((_url, init: RequestInit | undefined) => {
        markCompletionStarted();
        return neverSettlingRequest(init?.signal, requestSignals);
      });
    vi.stubGlobal("fetch", fetchMock);
    const reason = new DOMException("Preview cancelled", "AbortError");
    const replacement = replaceManualPreview({
      patternId: "pattern-1",
      version: 4,
      file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
      signal: caller.signal,
    });
    await completionStarted;

    caller.abort(reason);
    const settlement = settleWithin(replacement, 1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await settlement).toEqual({ status: "rejected", error: reason });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]).toHaveProperty("aborted", true);
    expect(vi.getTimerCount()).toBe(0);
    expectAbortListenersReleased(added, removed);
  });

  it("requests durable cleanup when an object upload fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            operationId: "operation-1",
            patternId: "pattern-1",
            version: 4,
            extension: "webp",
            assets: {
              preview: {
                assetId: "preview-id",
                role: "preview",
                objectKey: "derived/preview.webp",
                extension: "webp",
              },
              thumbnail: {
                assetId: "thumbnail-id",
                role: "thumbnail",
                objectKey: "derived/thumbnail.webp",
                extension: "webp",
              },
            },
            credentials,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "cancelled" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    mocks.put
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("UPLOAD_FAILED"));

    await expect(
      replaceManualPreview({
        patternId: "pattern-1",
        version: 4,
        file: new File(["jpeg"], "cover.jpg", { type: "image/jpeg" }),
      }),
    ).rejects.toThrow("UPLOAD_FAILED");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "/api/patterns/pattern-1/manual-preview/cancel",
    );
    const initializedOperationId = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ).operationId;
    expect(
      JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string),
    ).toEqual({ operationId: initializedOperationId });
  });
});
