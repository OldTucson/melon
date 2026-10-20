"use client";

import type { BrowserOssCredentials } from "@/features/storage/contracts";
import {
  UPLOAD_REQUEST_TIMEOUT_MS,
  UPLOAD_WRITE_DRAIN_SCHEDULING_MARGIN_MS,
} from "@/features/storage/upload-timing";
import { alibabaBrowserMultipartClient } from "@/features/uploads/oss-browser-client";
import { ApiResponseError, readApiResponse } from "@/lib/query/client";

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

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function requestTimeoutError() {
  const error = new Error("MANUAL_PREVIEW_REQUEST_TIMEOUT");
  error.name = "TimeoutError";
  return error;
}

function isRetryableRecoveryError(error: unknown) {
  return !(
    error instanceof ApiResponseError &&
    error.status >= 400 &&
    error.status < 500
  );
}

function nextRecoveryDelay(currentDelayMs: number, deadline: number) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return null;
  return Math.min(
    currentDelayMs === 0 ? 250 : currentDelayMs * 2,
    completionRecoveryMaxPollIntervalMs,
    remainingMs,
  );
}

async function post<T>(
  url: string,
  body: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? UPLOAD_REQUEST_TIMEOUT_MS;
  if (timeoutMs <= 0) throw requestTimeoutError();
  if (options.signal?.aborted) throw abortReason(options.signal);
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAbort(reason);
  };
  const abortFromCaller = () => abort(abortReason(options.signal!));
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = controller.signal.aborted
    ? undefined
    : setTimeout(() => abort(requestTimeoutError()), timeoutMs);
  try {
    const request = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).then((response) => readApiResponse<T>(response));
    return await Promise.race([request, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function waitFor(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function extensionFor(result: PreviewResult) {
  return result.outputType === "image/png" ? ("png" as const) : ("webp" as const);
}

export async function replaceManualPreview(input: {
  patternId: string;
  version: number;
  file: File;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) throw abortReason(input.signal);
  const generated = await generateRasterPreview(input.file);
  if (!generated) throw new Error("MANUAL_PREVIEW_FILE_UNSUPPORTED");
  const extension = extensionFor(generated);
  const operationId = crypto.randomUUID();
  input.onProgress?.(5);
  const initialized = await post<Initialization>(
    `/api/patterns/${input.patternId}/manual-preview/init`,
    { operationId, version: input.version, extension },
    { signal: input.signal },
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
  let completionDeadline: number | undefined;

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

    completionDeadline = Date.now() + completionRecoveryTimeoutMs;
    const result = await post<Completion>(completeUrl, completionInput, {
      signal: input.signal,
      timeoutMs: Math.min(
        UPLOAD_REQUEST_TIMEOUT_MS,
        completionDeadline - Date.now(),
      ),
    });
    input.onProgress?.(100);
    return result;
  } catch (error) {
    if (input.signal?.aborted) throw abortReason(input.signal);
    const cancelUrl = `/api/patterns/${input.patternId}/manual-preview/cancel`;
    const recoveryDeadline =
      completionDeadline ?? Date.now() + completionRecoveryTimeoutMs;
    let delayMs = 0;
    while (true) {
      if (delayMs > 0) {
        await waitFor(delayMs, input.signal);
      }
      const remainingMs = recoveryDeadline - Date.now();
      if (remainingMs <= 0) break;
      let cancellation: Cancellation | undefined;
      try {
        cancellation = await post<Cancellation>(
          cancelUrl,
          { operationId },
          {
            signal: input.signal,
            timeoutMs: Math.min(UPLOAD_REQUEST_TIMEOUT_MS, remainingMs),
          },
        );
      } catch (recoveryError) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        if (!isRetryableRecoveryError(recoveryError)) throw recoveryError;
        const nextDelayMs = nextRecoveryDelay(delayMs, recoveryDeadline);
        if (nextDelayMs === null) break;
        delayMs = nextDelayMs;
        continue;
      }
      if (cancellation?.state === "complete") {
        const replayRemainingMs = recoveryDeadline - Date.now();
        if (replayRemainingMs <= 0) break;
        try {
          const result = await post<Completion>(completeUrl, completionInput, {
            signal: input.signal,
            timeoutMs: Math.min(
              UPLOAD_REQUEST_TIMEOUT_MS,
              replayRemainingMs,
            ),
          });
          input.onProgress?.(100);
          return result;
        } catch (recoveryError) {
          if (input.signal?.aborted) throw abortReason(input.signal);
          if (!isRetryableRecoveryError(recoveryError)) throw recoveryError;
          const nextDelayMs = nextRecoveryDelay(delayMs, recoveryDeadline);
          if (nextDelayMs === null) break;
          delayMs = nextDelayMs;
          continue;
        }
      }
      if (cancellation?.state !== "verifying") break;
      const nextDelayMs = nextRecoveryDelay(delayMs, recoveryDeadline);
      if (nextDelayMs === null) break;
      delayMs = nextDelayMs;
    }
    throw error;
  }
}
