import { runPreviewWorker } from "./preview-worker-client";

export const generatePsdPreview = (
  file: File,
  createWorker: () => Worker = () =>
    new Worker(new URL("./psd-preview.worker.ts", import.meta.url), {
      type: "module",
    }),
) => runPreviewWorker(file, createWorker);
