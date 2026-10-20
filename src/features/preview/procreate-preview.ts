import { runPreviewWorker } from "./preview-worker-client";

export const generateProcreatePreview = (
  file: File,
  createWorker: () => Worker = () =>
    new Worker(new URL("./procreate-preview.worker.ts", import.meta.url), {
      type: "module",
    }),
) => runPreviewWorker(file, createWorker);
