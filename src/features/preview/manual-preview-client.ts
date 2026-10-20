"use client";

import type { BrowserOssCredentials } from "@/features/storage/contracts";
import {
  UPLOAD_REQUEST_TIMEOUT_MS,
  UPLOAD_WRITE_DRAIN_SCHEDULING_MARGIN_MS,
} from "@/features/storage/upload-timing";
import { alibabaBrowserMultipartClient } from "@/features/uploads/oss-browser-client";
import { readApiResponse } from "@/lib/query/client";

import type { PreviewResult } from "./contracts";
import { generateRasterPreview } from "./raster-preview";

type InitializedAsset = {
  assetId: string;
  role: "preview" | "thumbnail";
  objectKey: string;
  extension: "png" | "webp";
};

type Initialization = {
  operationId: string;
  patternId: string;
  version: number;
  extension: "png" | "webp";
  assets: {
    preview: InitializedAsset & { role: "preview" };
    thumbnail: InitializedAsset & { role: "thumbnail" };
  };
  credentials: BrowserOssCredentials;
};

type Completion = {
  pattern: { id: string; version: number; previewStatus: "manual" };
};

type Cancellation = {
  state: "complete" | "verifying" | "cancelled" | "cleanup_pending";
};

// Each asset verification runs HEAD then range-read; both assets run in parallel.
const completionRecoveryTimeoutMs =
  UPLOAD_REQUEST_TIMEOUT_MS * 2 + UPLOAD_WRITE_DRAIN_SCHEDULING_MARGIN_MS;
const completionRecoveryMaxPollIntervalMs = 5_000;

async function post<T>(url: string, body: unknown) {
  return readApiResponse<T>(
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function extensionFor(result: PreviewResult) {
  return result.outputType === "image/png" ? ("png" as const) : ("webp" as const);
}

export async function replaceManualPreview(input: {
  patternId: string;
  version: number;
  file: File;
  onProgress?: (progress: number) => void;
}) {
  const generated = await generateRasterPreview(input.file);
  if (!generated) throw new Error("MANUAL_PREVIEW_FILE_UNSUPPORTED");
  const extension = extensionFor(generated);
  const operationId = crypto.randomUUID();
  input.onProgress?.(5);
  const initialized = await post<Initialization>(
    `/api/patterns/${input.patternId}/manual-preview/init`,
    { operationId, version: input.version, extension },
  );
  const completionInput = {
    operationId,
    version: input.version,
    assets: [
      {
        ...initialized.assets.preview,
        sizeBytes: generated.preview.size,
        width: generated.previewWidth,
        height: generated.previewHeight,
      },
      {
        ...initialized.assets.thumbnail,
        sizeBytes: generated.thumbnail.size,
        width: generated.thumbnailWidth,
        height: generated.thumbnailHeight,
      },
    ],
  };
  const completeUrl = `/api/patterns/${input.patternId}/manual-preview/complete`;

  try {
    await alibabaBrowserMultipartClient.put({
      credentials: initialized.credentials,
      objectKey: initialized.assets.preview.objectKey,
      file: generated.preview,
      contentType: generated.outputType,
      onProgress: (fraction) =>
        input.onProgress?.(5 + Math.round(fraction * 68)),
    });
    await alibabaBrowserMultipartClient.put({
      credentials: initialized.credentials,
      objectKey: initialized.assets.thumbnail.objectKey,
      file: generated.thumbnail,
      contentType: generated.outputType,
      onProgress: (fraction) =>
        input.onProgress?.(73 + Math.round(fraction * 22)),
    });
    input.onProgress?.(96);

    const result = await post<Completion>(completeUrl, completionInput);
    input.onProgress?.(100);
    return result;
  } catch (error) {
    const cancelUrl = `/api/patterns/${input.patternId}/manual-preview/cancel`;
    const recoveryDeadline = Date.now() + completionRecoveryTimeoutMs;
    let delayMs = 0;
    while (true) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const cancellation = await post<Cancellation>(cancelUrl, {
        operationId,
      }).catch(() => undefined);
      if (cancellation?.state === "complete") {
        const result = await post<Completion>(completeUrl, completionInput);
        input.onProgress?.(100);
        return result;
      }
      if (cancellation?.state !== "verifying") break;
      const remainingMs = recoveryDeadline - Date.now();
      if (remainingMs <= 0) break;
      delayMs = Math.min(
        delayMs === 0 ? 250 : delayMs * 2,
        completionRecoveryMaxPollIntervalMs,
        remainingMs,
      );
    }
    throw error;
  }
}
