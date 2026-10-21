import { describe, expect, it, vi } from "vitest";

import {
  cropImage,
  MAX_CROPPED_IMAGE_BYTES,
  type CropImageDependencies,
} from "./crop-image";

function dependencies(output: Blob | null = new Blob(["png"], { type: "image/png" })) {
  const drawImage = vi.fn();
  const close = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn(
      (callback: BlobCallback, type?: string) =>
        callback(type === "image/webp" ? null : output),
    ),
  };
  const createObjectURL = vi.fn(() => "blob:crop-source");
  const revokeObjectURL = vi.fn();
  const deps: CropImageDependencies = {
    createCanvas: () => canvas as unknown as HTMLCanvasElement,
    createObjectURL,
    decode: vi.fn(async () => ({
      close,
      height: 800,
      source: {} as CanvasImageSource,
      width: 1200,
    })),
    revokeObjectURL,
  };
  return { canvas, close, createObjectURL, deps, drawImage, revokeObjectURL };
}

describe("cropImage", () => {
  it("scales display pixels to natural pixels and falls back from WebP to PNG", async () => {
    const fixture = dependencies();
    const file = new File(["jpeg"], "query.jpg", { type: "image/jpeg" });

    const output = await cropImage(
      {
        crop: { height: 80, unit: "px", width: 100, x: 50, y: 40 },
        displayHeight: 400,
        displayWidth: 600,
        file,
      },
      fixture.deps,
    );

    expect(fixture.canvas).toMatchObject({ width: 200, height: 160 });
    expect(fixture.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      100,
      80,
      200,
      160,
      0,
      0,
      200,
      160,
    );
    expect(fixture.canvas.toBlob).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      "image/webp",
      0.92,
    );
    expect(output).toMatchObject({ name: "query-crop.png", type: "image/png" });
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith("blob:crop-source");
  });

  it("rejects an oversized result and still closes and revokes resources", async () => {
    const oversized = new Blob(["x"], { type: "image/png" });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: MAX_CROPPED_IMAGE_BYTES + 1,
    });
    const fixture = dependencies(oversized);

    await expect(
      cropImage(
        {
          crop: { height: 20, unit: "px", width: 20, x: 0, y: 0 },
          displayHeight: 100,
          displayWidth: 100,
          file: new File(["png"], "query.png", { type: "image/png" }),
        },
        fixture.deps,
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
