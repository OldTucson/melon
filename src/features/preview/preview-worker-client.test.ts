import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_TIMEOUT_MS } from "./contracts";
import { runPreviewWorker } from "./preview-worker-client";

describe("preview worker client", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the generated preview and terminates the worker", async () => {
    const terminate = vi.fn();
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate,
    } as unknown as Worker;
    const file = new File(["source"], "source.psd");
    const pending = runPreviewWorker(file, () => worker);
    const result = {
      preview: new Blob(["preview"]),
      thumbnail: new Blob(["thumbnail"]),
      previewWidth: 20,
      previewHeight: 10,
      thumbnailWidth: 10,
      thumbnailHeight: 5,
      outputType: "image/webp" as const,
    };

    worker.onmessage?.(
      new MessageEvent("message", { data: { ok: true, result } }),
    );

    await expect(pending).resolves.toBe(result);
    expect(worker.postMessage).toHaveBeenCalledWith({ file });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("preserves stable worker error codes", async () => {
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    const pending = runPreviewWorker(new File(["source"], "source.psd"), () => worker);

    worker.onmessage?.(
      new MessageEvent("message", {
        data: { ok: false, code: "PREVIEW_UNSUPPORTED" },
      }),
    );

    await expect(pending).rejects.toThrow("PREVIEW_UNSUPPORTED");
  });

  it("terminates a worker at the shared timeout", async () => {
    vi.useFakeTimers();
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    } as unknown as Worker;
    const pending = runPreviewWorker(new File(["source"], "source.pdf"), () => worker);
    const rejection = expect(pending).rejects.toThrow("PREVIEW_TIMEOUT");

    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS);
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
