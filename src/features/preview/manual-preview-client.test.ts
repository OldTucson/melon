import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_REQUEST_TIMEOUT_MS } from "@/features/storage/upload-timing";

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
