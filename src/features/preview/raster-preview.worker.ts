import {
  PREVIEW_LONG_EDGE,
  THUMBNAIL_LONG_EDGE,
  assertPixelBudget,
  fitWithin,
  selectOutputType,
  type RasterPreviewWorkerResponse,
} from "./contracts";

async function pngHasAlpha(file: Blob) {
  const bytes = new Uint8Array(await file.slice(0, 65_536).arrayBuffer());
  if (bytes.length < 26) return true;
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  const transparentChunk = [0x74, 0x52, 0x4e, 0x53];
  return bytes.some(
    (value, index) =>
      value === transparentChunk[0] &&
      transparentChunk.every((chunk, offset) => bytes[index + offset] === chunk),
  );
}

async function render(
  bitmap: ImageBitmap,
  dimensions: { width: number; height: number },
  outputType: "image/png" | "image/webp",
) {
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext("2d", { alpha: outputType === "image/png" });
  if (!context) throw new Error("PREVIEW_DECODE_FAILED");
  context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
  return canvas.convertToBlob({
    type: outputType,
    ...(outputType === "image/webp" ? { quality: 0.88 } : {}),
  });
}

async function generate(file: File) {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const source = { width: bitmap.width, height: bitmap.height };
    assertPixelBudget(source);
    const hasAlpha = file.type === "image/png" ? await pngHasAlpha(file) : false;
    const outputType = selectOutputType({ hasAlpha });
    const previewSize = fitWithin(source, PREVIEW_LONG_EDGE);
    const thumbnailSize = fitWithin(source, THUMBNAIL_LONG_EDGE);
    const [preview, thumbnail] = await Promise.all([
      render(bitmap, previewSize, outputType),
      render(bitmap, thumbnailSize, outputType),
    ]);
    return {
      preview,
      thumbnail,
      previewWidth: previewSize.width,
      previewHeight: previewSize.height,
      thumbnailWidth: thumbnailSize.width,
      thumbnailHeight: thumbnailSize.height,
      outputType,
    };
  } finally {
    bitmap?.close();
  }
}

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  let response: RasterPreviewWorkerResponse;
  try {
    response = { ok: true, result: await generate(event.data.file) };
  } catch (error) {
    response = {
      ok: false,
      code:
        error instanceof Error && error.message === "PREVIEW_PIXEL_LIMIT"
          ? "PREVIEW_PIXEL_LIMIT"
          : "PREVIEW_DECODE_FAILED",
    };
  }
  self.postMessage(response);
};
