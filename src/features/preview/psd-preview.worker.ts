import type { PreviewWorkerResponse } from "./contracts";
import { previewErrorCode } from "./contracts";
import { decodePsdComposite } from "./psd-decoder";
import { createPreviewFromRgba } from "./worker-output";

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  let response: PreviewWorkerResponse;
  try {
    const decoded = decodePsdComposite(await event.data.file.arrayBuffer());
    response = { ok: true, result: await createPreviewFromRgba(decoded) };
  } catch (error) {
    response = { ok: false, code: previewErrorCode(error) };
  }
  self.postMessage(response);
};
