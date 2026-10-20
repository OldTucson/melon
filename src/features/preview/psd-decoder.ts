import { initializeCanvas, readPsd } from "ag-psd";

import { assertPixelBudget } from "./contracts";

type PsdDecoderDependencies = {
  createImageData?: (width: number, height: number) => ImageData;
};

function assertPsdPixelBudget(buffer: ArrayBuffer) {
  if (buffer.byteLength < 22) return;
  const bytes = new Uint8Array(buffer, 0, 4);
  if (new TextDecoder("ascii").decode(bytes) !== "8BPS") return;
  const view = new DataView(buffer);
  const version = view.getUint16(4);
  if (version !== 1 && version !== 2) return;
  assertPixelBudget({ width: view.getUint32(18), height: view.getUint32(14) });
}

export function decodePsdComposite(
  buffer: ArrayBuffer,
  dependencies: PsdDecoderDependencies = {},
) {
  try {
    assertPsdPixelBudget(buffer);
    initializeCanvas(
      (width, height) =>
        new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
      dependencies.createImageData ??
        ((width, height) => new ImageData(width, height)),
    );
    const psd = readPsd(buffer, {
      useImageData: true,
      skipLayerImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
    });
    if (!psd.imageData) throw new Error("PREVIEW_DECODE_FAILED");
    return {
      width: psd.width,
      height: psd.height,
      pixels: new Uint8ClampedArray(psd.imageData.data),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      ["PREVIEW_DECODE_FAILED", "PREVIEW_PIXEL_LIMIT"].includes(error.message)
    ) {
      throw error;
    }
    throw new Error("PREVIEW_DECODE_FAILED");
  }
}
