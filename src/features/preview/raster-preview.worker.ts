import {
  previewErrorCode,
  type RasterPreviewWorkerResponse,
} from "./contracts";
import { createPreviewFromDrawable } from "./worker-output";

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

async function generate(file: File) {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const hasAlpha = file.type === "image/png" ? await pngHasAlpha(file) : false;
    return createPreviewFromDrawable({
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      hasAlpha,
    });
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
      code: previewErrorCode(error),
    };
  }
  self.postMessage(response);
};
