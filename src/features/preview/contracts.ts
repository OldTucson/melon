export const PREVIEW_LONG_EDGE = 2048;
export const THUMBNAIL_LONG_EDGE = 512;
export const MAX_PIXELS = 100_000_000;
export const PREVIEW_TIMEOUT_MS = 30_000;

export type ImageDimensions = { width: number; height: number };

export function fitWithin(dimensions: ImageDimensions, longEdge: number) {
  if (
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    !Number.isFinite(longEdge) ||
    longEdge <= 0
  ) {
    throw new Error("PREVIEW_DIMENSIONS_INVALID");
  }
  const scale = Math.min(1, longEdge / Math.max(dimensions.width, dimensions.height));
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

export function assertPixelBudget(dimensions: ImageDimensions) {
  if (
    !Number.isSafeInteger(dimensions.width) ||
    !Number.isSafeInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new Error("PREVIEW_DIMENSIONS_INVALID");
  }
  if (dimensions.width * dimensions.height > MAX_PIXELS) {
    throw new Error("PREVIEW_PIXEL_LIMIT");
  }
}

export function selectOutputType({ hasAlpha }: { hasAlpha: boolean }) {
  return hasAlpha ? ("image/png" as const) : ("image/webp" as const);
}

export type PreviewResult = {
  preview: Blob;
  thumbnail: Blob;
  previewWidth: number;
  previewHeight: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  outputType: "image/png" | "image/webp";
};

export type RasterPreviewResult = PreviewResult;

export type PreviewWorkerErrorCode =
  | "PREVIEW_UNSUPPORTED"
  | "PREVIEW_PIXEL_LIMIT"
  | "PREVIEW_DECODE_FAILED";

export type PreviewWorkerResponse =
  | { ok: true; result: PreviewResult }
  | {
      ok: false;
      code: PreviewWorkerErrorCode;
    };

export type RasterPreviewWorkerResponse = PreviewWorkerResponse;

export function previewErrorCode(error: unknown): PreviewWorkerErrorCode {
  if (
    error instanceof Error &&
    [
      "PREVIEW_UNSUPPORTED",
      "PREVIEW_PIXEL_LIMIT",
      "PREVIEW_DECODE_FAILED",
    ].includes(error.message)
  ) {
    return error.message as PreviewWorkerErrorCode;
  }
  return "PREVIEW_DECODE_FAILED";
}
