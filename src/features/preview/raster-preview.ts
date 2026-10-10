import {
  PREVIEW_TIMEOUT_MS,
  type RasterPreviewResult,
  type RasterPreviewWorkerResponse,
} from "./contracts";

const supportedRasterExtensions = new Set(["jpg", "jpeg", "png"]);

export function canGenerateRasterPreview(filename: string) {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return supportedRasterExtensions.has(extension);
}

export async function generateRasterPreview(
  file: File,
  createWorker: () => Worker = () =>
    new Worker(new URL("./raster-preview.worker.ts", import.meta.url), {
      type: "module",
    }),
): Promise<RasterPreviewResult | null> {
  if (!canGenerateRasterPreview(file.name)) return null;
  let worker: Worker;
  try {
    worker = createWorker();
  } catch {
    throw new Error("PREVIEW_DECODE_FAILED");
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("PREVIEW_TIMEOUT"));
    }, PREVIEW_TIMEOUT_MS);
    const finish = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<RasterPreviewWorkerResponse>) => {
      finish();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.code));
    };
    worker.onerror = () => {
      finish();
      reject(new Error("PREVIEW_DECODE_FAILED"));
    };
    worker.postMessage({ file });
  });
}
