import { runPreviewWorker } from "./preview-worker-client";

export const generatePdfPreview = (
  file: File,
  createWorker: () => Worker = () =>
    new Worker(new URL("./pdf-preview.worker.ts", import.meta.url), {
      type: "module",
    }),
) => runPreviewWorker(file, createWorker);
