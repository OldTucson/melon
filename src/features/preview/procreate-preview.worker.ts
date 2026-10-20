import type { PreviewWorkerResponse } from "./contracts";
import { previewErrorCode } from "./contracts";
import { extractProcreateThumbnail } from "./procreate-thumbnail";
import { createPreviewFromDrawable } from "./worker-output";

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  let response: PreviewWorkerResponse;
  let bitmap: ImageBitmap | undefined;
  try {
    const bytes = extractProcreateThumbnail(
      new Uint8Array(await event.data.file.arrayBuffer()),
    );
    bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(bytes).buffer], { type: "image/png" }),
    );
    response = {
      ok: true,
      result: await createPreviewFromDrawable({
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        hasAlpha: true,
      }),
    };
  } catch (error) {
    response = { ok: false, code: previewErrorCode(error) };
  } finally {
    bitmap?.close();
  }
  self.postMessage(response);
};
