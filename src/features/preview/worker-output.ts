import {
  PREVIEW_LONG_EDGE,
  THUMBNAIL_LONG_EDGE,
  assertPixelBudget,
  fitWithin,
  selectOutputType,
  type ImageDimensions,
  type PreviewResult,
} from "./contracts";

function containsTransparency(pixels: Uint8ClampedArray) {
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 255) return true;
  }
  return false;
}

async function render(
  source: CanvasImageSource,
  dimensions: ImageDimensions,
  outputType: PreviewResult["outputType"],
) {
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
  const context = canvas.getContext("2d", { alpha: outputType === "image/png" });
  if (!context) throw new Error("PREVIEW_DECODE_FAILED");
  if (outputType !== "image/png") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, dimensions.width, dimensions.height);
  }
  context.drawImage(source, 0, 0, dimensions.width, dimensions.height);
  return canvas.convertToBlob({
    type: outputType,
    ...(outputType === "image/webp" ? { quality: 0.88 } : {}),
  });
}

export async function createPreviewFromDrawable(input: {
  source: CanvasImageSource;
  width: number;
  height: number;
  hasAlpha: boolean;
}): Promise<PreviewResult> {
  const sourceDimensions = { width: input.width, height: input.height };
  assertPixelBudget(sourceDimensions);
  const previewSize = fitWithin(sourceDimensions, PREVIEW_LONG_EDGE);
  const thumbnailSize = fitWithin(sourceDimensions, THUMBNAIL_LONG_EDGE);
  const renderPair = (outputType: PreviewResult["outputType"]) =>
    Promise.all([
      render(input.source, previewSize, outputType),
      render(input.source, thumbnailSize, outputType),
    ]);
  let outputType = selectOutputType({ hasAlpha: input.hasAlpha });
  let [preview, thumbnail] = await renderPair(outputType);
  if (
    outputType === "image/webp" &&
    (preview.type !== outputType || thumbnail.type !== outputType)
  ) {
    outputType = "image/png";
    [preview, thumbnail] = await renderPair(outputType);
  }
  return {
    preview,
    thumbnail,
    previewWidth: previewSize.width,
    previewHeight: previewSize.height,
    thumbnailWidth: thumbnailSize.width,
    thumbnailHeight: thumbnailSize.height,
    outputType,
  };
}

export async function createPreviewFromRgba(input: {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}) {
  assertPixelBudget(input);
  if (input.pixels.length !== input.width * input.height * 4) {
    throw new Error("PREVIEW_DECODE_FAILED");
  }
  const canvas = new OffscreenCanvas(input.width, input.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PREVIEW_DECODE_FAILED");
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(input.pixels),
      input.width,
      input.height,
    ),
    0,
    0,
  );
  return createPreviewFromDrawable({
    source: canvas,
    width: input.width,
    height: input.height,
    hasAlpha: containsTransparency(input.pixels),
  });
}
