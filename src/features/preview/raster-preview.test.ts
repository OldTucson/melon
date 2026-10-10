import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_TIMEOUT_MS } from "./contracts";
import { generateRasterPreview } from "./raster-preview";

describe("raster preview worker wrapper", () => {
  afterEach(() => vi.useRealTimers());

  it("maps a worker startup failure to a stable preview error", async () => {
    const file = new File(["png"], "leaf.png", { type: "image/png" });
    await expect(
      generateRasterPreview(file, () => {
        throw new Error("browser implementation detail");
      }),
    ).rejects.toThrow("PREVIEW_DECODE_FAILED");
  });

  it("terminates an unresponsive worker after 30 seconds", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate,
    } as unknown as Worker;
    const promise = generateRasterPreview(
      new File(["png"], "leaf.png", { type: "image/png" }),
      () => worker,
    );
    const rejection = expect(promise).rejects.toThrow("PREVIEW_TIMEOUT");

    await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS);
    await rejection;
    expect(terminate).toHaveBeenCalledOnce();
  });
});
