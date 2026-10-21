"use client";

import type { PixelCrop } from "react-image-crop";

import { ImageSearchFileError } from "./image-search-client";

export const MAX_CROPPED_IMAGE_BYTES = 20 * 1024 * 1024;

type DecodedCropSource = {
  close: () => void;
  height: number;
  source: CanvasImageSource;
  width: number;
};

export type CropImageDependencies = {
  createCanvas: () => HTMLCanvasElement;
  createObjectURL: (file: File) => string;
  decode: (file: File, objectUrl: string) => Promise<DecodedCropSource>;
  revokeObjectURL: (objectUrl: string) => void;
};

export type CropImageInput = {
  crop: PixelCrop;
  displayHeight: number;
  displayWidth: number;
  file: File;
};

async function decodeImage(
  file: File,
  objectUrl: string,
): Promise<DecodedCropSource> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        close: () => bitmap.close(),
        height: bitmap.height,
        source: bitmap,
        width: bitmap.width,
      };
    } catch {
      // Some browsers expose createImageBitmap but do not decode every type.
    }
  }

  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new ImageSearchFileError("unsupported"));
    image.src = objectUrl;
  });
  return {
    close: () => undefined,
    height: image.naturalHeight,
    source: image,
    width: image.naturalWidth,
  };
}

const defaultDependencies: CropImageDependencies = {
  createCanvas: () => document.createElement("canvas"),
  createObjectURL: (file) => URL.createObjectURL(file),
  decode: decodeImage,
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

function canvasBlob(
  canvas: HTMLCanvasElement,
  type: "image/png" | "image/webp",
  quality?: number,
) {
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality),
  );
}

export async function cropImage(
  input: CropImageInput,
  dependencies: CropImageDependencies = defaultDependencies,
) {
  if (
    input.crop.unit !== "px" ||
    !Number.isFinite(input.displayWidth) ||
    !Number.isFinite(input.displayHeight) ||
    input.displayWidth <= 0 ||
    input.displayHeight <= 0 ||
    input.crop.width <= 0 ||
    input.crop.height <= 0
  ) {
    throw new ImageSearchFileError("unsupported");
  }

  const objectUrl = dependencies.createObjectURL(input.file);
  let decoded: DecodedCropSource | undefined;
  try {
    decoded = await dependencies.decode(input.file, objectUrl);
    const scaleX = decoded.width / input.displayWidth;
    const scaleY = decoded.height / input.displayHeight;
    const sourceX = Math.max(0, input.crop.x * scaleX);
    const sourceY = Math.max(0, input.crop.y * scaleY);
    const sourceWidth = Math.min(
      input.crop.width * scaleX,
      decoded.width - sourceX,
    );
    const sourceHeight = Math.min(
      input.crop.height * scaleY,
      decoded.height - sourceY,
    );
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      throw new ImageSearchFileError("unsupported");
    }

    const canvas = dependencies.createCanvas();
    canvas.width = Math.max(1, Math.round(sourceWidth));
    canvas.height = Math.max(1, Math.round(sourceHeight));
    const context = canvas.getContext("2d");
    if (!context) throw new ImageSearchFileError("unsupported");
    context.drawImage(
      decoded.source,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    const webp = await canvasBlob(canvas, "image/webp", 0.92);
    const blob = webp ?? (await canvasBlob(canvas, "image/png"));
    if (!blob) throw new ImageSearchFileError("unsupported");
    if (blob.size > MAX_CROPPED_IMAGE_BYTES) {
      throw new ImageSearchFileError("too_large");
    }
    const extension = blob.type === "image/webp" ? "webp" : "png";
    const basename = input.file.name.replace(/\.[^.]+$/, "") || "query";
    return new File([blob], `${basename}-crop.${extension}`, {
      type: blob.type,
      lastModified: Date.now(),
    });
  } finally {
    decoded?.close();
    dependencies.revokeObjectURL(objectUrl);
  }
}
