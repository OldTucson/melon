import {
  PREVIEW_TIMEOUT_MS,
  type PreviewResult,
  type PreviewWorkerResponse,
} from "./contracts";

export async function runPreviewWorker(
  file: File,
  createWorker: () => Worker,
): Promise<PreviewResult> {
  let worker: Worker;
  try {
    worker = createWorker();
  } catch {
    throw new Error("PREVIEW_DECODE_FAILED");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      globalThis.clearTimeout(timeout);
      worker.terminate();
      return true;
    };
    const timeout = globalThis.setTimeout(() => {
      if (finish()) reject(new Error("PREVIEW_TIMEOUT"));
    }, PREVIEW_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<PreviewWorkerResponse>) => {
      if (!finish()) return;
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.code));
    };
    worker.onerror = () => {
      if (finish()) reject(new Error("PREVIEW_DECODE_FAILED"));
    };
    worker.postMessage({ file });
  });
}
