import { afterEach, describe, expect, it, vi } from "vitest";

import { createPreviewFromDrawable } from "./worker-output";

describe("preview worker output", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to PNG when the browser does not encode requested WebP", async () => {
    const requestedTypes: string[] = [];
    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext() {
        return {
          drawImage() {},
          fillRect() {},
          fillStyle: "",
        };
      }

      async convertToBlob({ type }: { type: string }) {
        requestedTypes.push(type);
        return new Blob(["preview"], {
          type: type === "image/webp" ? "image/png" : type,
        });
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);

    const result = await createPreviewFromDrawable({
      source: {} as CanvasImageSource,
      width: 800,
      height: 600,
      hasAlpha: false,
    });

    expect(result.outputType).toBe("image/png");
    expect(result.preview.type).toBe("image/png");
    expect(result.thumbnail.type).toBe("image/png");
    expect(requestedTypes).toEqual([
      "image/webp",
      "image/webp",
      "image/png",
      "image/png",
    ]);
  });
});
