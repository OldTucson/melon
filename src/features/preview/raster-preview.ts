import type { RasterPreviewResult } from "./contracts";
import { runPreviewWorker } from "./preview-worker-client";

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
  return runPreviewWorker(file, createWorker);
}
