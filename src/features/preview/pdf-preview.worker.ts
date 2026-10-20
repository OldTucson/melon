import {
  MAX_PIXELS,
  PREVIEW_LONG_EDGE,
  assertPixelBudget,
  previewErrorCode,
  type PreviewWorkerResponse,
} from "./contracts";
import { createPreviewFromDrawable } from "./worker-output";

type CanvasAndContext = {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
};

class WorkerCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PREVIEW_DECODE_FAILED");
    return { canvas, context };
  }

  reset(target: CanvasAndContext, width: number, height: number) {
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target: CanvasAndContext) {
    target.canvas.width = 0;
    target.canvas.height = 0;
  }
}

async function renderFirstPage(file: File) {
  const { getDocument, PDFWorker } = await import("pdfjs-dist");
  const workerPort = new Worker(
    new URL("./pdfjs-core.worker.ts", import.meta.url),
    { type: "module" },
  );
  const worker = PDFWorker.create({ port: workerPort });
  const loadingTask = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    worker,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: true,
    maxImageSize: MAX_PIXELS,
    CanvasFactory: WorkerCanvasFactory,
  });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = PREVIEW_LONG_EDGE / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    assertPixelBudget({ width, height });
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("PREVIEW_DECODE_FAILED");
    await page.render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      background: "#ffffff",
      annotationMode: 0,
    }).promise;
    return createPreviewFromDrawable({
      source: canvas,
      width,
      height,
      hasAlpha: false,
    });
  } finally {
    await loadingTask.destroy();
    worker.destroy();
    workerPort.terminate();
  }
}

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  let response: PreviewWorkerResponse;
  try {
    response = { ok: true, result: await renderFirstPage(event.data.file) };
  } catch (error) {
    response = { ok: false, code: previewErrorCode(error) };
  }
  self.postMessage(response);
};
