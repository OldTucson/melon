import type { RasterPreviewResult } from "./contracts";
import { generatePdfPreview } from "./pdf-preview";
import { generateProcreatePreview } from "./procreate-preview";
import { generatePsdPreview } from "./psd-preview";
import { generateRasterPreview } from "./raster-preview";

export type PreviewKind = "raster" | "psd" | "ai" | "pdf" | "procreate";

export type PreviewRenderers = {
  raster(file: File): Promise<RasterPreviewResult | null>;
  psd(file: File): Promise<RasterPreviewResult | null>;
  pdf(file: File): Promise<RasterPreviewResult | null>;
  procreate(file: File): Promise<RasterPreviewResult | null>;
};

const defaultRenderers: PreviewRenderers = {
  raster: generateRasterPreview,
  psd: generatePsdPreview,
  pdf: generatePdfPreview,
  procreate: generateProcreatePreview,
};

export function resolvePreviewKind(filename: string): PreviewKind | null {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (["jpg", "jpeg", "png"].includes(extension)) return "raster";
  if (extension === "psd") return "psd";
  if (extension === "ai") return "ai";
  if (extension === "pdf") return "pdf";
  if (extension === "procreate") return "procreate";
  return null;
}

export function classifyAiPrefix(bytes: Uint8Array) {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  if (prefix.startsWith("%PDF-")) return "pdf" as const;
  if (prefix.startsWith("%!PS-Adobe")) return "postscript" as const;
  return "unknown" as const;
}

export async function generatePreview(
  file: File,
  renderers: PreviewRenderers = defaultRenderers,
): Promise<RasterPreviewResult | null> {
  const kind = resolvePreviewKind(file.name);
  if (!kind) return null;
  if (kind === "raster") return renderers.raster(file);
  if (kind === "psd") return renderers.psd(file);
  if (kind === "pdf") return renderers.pdf(file);
  if (kind === "procreate") return renderers.procreate(file);

  const prefix = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return classifyAiPrefix(prefix) === "pdf" ? renderers.pdf(file) : null;
}
