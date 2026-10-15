import { createSHA256 } from "hash-wasm";

import type { RasterPreviewResult } from "@/features/preview/contracts";
import type { BrowserOssCredentials } from "@/features/storage/contracts";
import { storageObjectKey } from "@/features/storage/object-keys";

import {
  MAX_UPLOAD_SIZE_BYTES,
  type UploadCompletionAsset,
  type UploadSourceExtension,
} from "./contracts";
import type {
  SafeSdkCheckpoint,
  UploadAssetKind,
  UploadCheckpointRow,
} from "./upload-db";

export type UploadTaskStatus =
  | "draft"
  | "hashing"
  | "uploading"
  | "processing"
  | "ready"
  | "failed"
  | "paused";

export type UploadTask = {
  localTaskId: string;
  patternId: string;
  sourceAssetId: string;
  previewAssetId: string;
  thumbnailAssetId: string;
  operationId: string;
  filename: string;
  extension: UploadSourceExtension;
  size: number;
  lastModified: number;
  contentHash?: string;
  sessionId?: string;
  status: UploadTaskStatus;
  progress: number;
  completionStartedAt?: number;
  canRecoverCompletion?: boolean;
  error?: string;
};

type UploadInitialization = {
  operationId: string;
  pattern: { id: string };
  sourceAsset: { id: string; objectKey: string };
  session: { id: string };
  credentials: BrowserOssCredentials;
};

export type UploadRunnerDependencies = {
  ownerId: string;
  api: {
    initialize(input: {
      patternId: string;
      sourceAssetId: string;
      operationId: string;
      originalFilename: string;
      extension: UploadSourceExtension;
      sizeBytes: number;
      lastModified: number;
      contentHash: string;
    }): Promise<UploadInitialization>;
    refreshCredentials(
      sessionId: string,
      operationId: string,
    ): Promise<{ credentials: BrowserOssCredentials }>;
    complete(
      sessionId: string,
      input: { operationId: string; assets: UploadCompletionAsset[] },
    ): Promise<unknown>;
    cancel(
      sessionId: string,
      input: {
        operationId: string;
        multipartAbort?: { attempted: boolean; succeeded: boolean };
      },
    ): Promise<unknown>;
  };
  multipart: {
    upload(input: {
      credentials: BrowserOssCredentials;
      objectKey: string;
      file: Blob;
      contentType: string;
      checkpoint?: SafeSdkCheckpoint;
      signal?: AbortSignal;
      onProgress(fraction: number): void;
      onCheckpoint(checkpoint: unknown): Promise<void>;
    }): Promise<void>;
    abort(input: {
      credentials: BrowserOssCredentials;
      objectKey: string;
      checkpoint: SafeSdkCheckpoint;
    }): Promise<boolean>;
  };
  checkpoints: {
    load(localTaskId: string): Promise<UploadCheckpointRow | undefined>;
    save(row: UploadCheckpointRow): Promise<void>;
    delete(localTaskId: string): Promise<void>;
  };
  generatePreview(file: File): Promise<RasterPreviewResult | null>;
  hashFile(file: File): Promise<string>;
  onUpdate(patch: Partial<UploadTask>): void;
  signal?: AbortSignal;
};

const supportedExtensions = new Set<UploadSourceExtension>([
  "psd",
  "ai",
  "jpg",
  "jpeg",
  "png",
  "procreate",
]);

export function extensionFromFilename(filename: string): UploadSourceExtension {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (!supportedExtensions.has(extension as UploadSourceExtension)) {
    throw new Error("UPLOAD_EXTENSION_UNSUPPORTED");
  }
  return extension as UploadSourceExtension;
}

export function assertUploadFile(file: File) {
  const extension = extensionFromFilename(file.name);
  if (file.size <= 0) throw new Error("UPLOAD_FILE_EMPTY");
  if (file.size > MAX_UPLOAD_SIZE_BYTES) throw new Error("UPLOAD_FILE_TOO_LARGE");
  return extension;
}

export function createUploadTask(
  file: File,
  dependencies: { randomUUID?: () => string } = {},
): UploadTask {
  const extension = assertUploadFile(file);
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  return {
    localTaskId: randomUUID(),
    patternId: randomUUID(),
    sourceAssetId: randomUUID(),
    previewAssetId: randomUUID(),
    thumbnailAssetId: randomUUID(),
    operationId: randomUUID(),
    filename: file.name,
    extension,
    size: file.size,
    lastModified: file.lastModified,
    status: "draft",
    progress: 0,
  };
}

export async function hashFileInChunks(file: File) {
  const hasher = await createSHA256();
  hasher.init();
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
    hasher.update(new Uint8Array(buffer));
  }
  return hasher.digest("hex");
}

function isCredentialExpired(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code) : "";
  const status = "status" in error ? Number(error.status) : 0;
  return (
    status === 401 ||
    status === 403 ||
    [
      "SecurityTokenExpired",
      "InvalidAccessKeyId",
      "AccessDenied",
      "RequestTimeTooSkewed",
    ].includes(code)
  );
}

function friendlyError(error: unknown) {
  if (!(error instanceof Error)) return "上传失败，请重试";
  if (error.message === "UPLOAD_RESELECT_MISMATCH") return "重新选择的文件与原文件不一致";
  if (error.message === "UPLOAD_COMPLETION_NOT_RECOVERABLE") {
    return "需要重新选择原文件以恢复上传";
  }
  if (error.message === "UPLOAD_FILE_TOO_LARGE") return "文件不能超过 200 MB";
  if (error.message === "UPLOAD_EXTENSION_UNSUPPORTED") return "不支持此文件格式";
  return "上传失败，请检查网络后重试";
}

function contentTypeForSource(extension: UploadSourceExtension) {
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "psd") return "image/vnd.adobe.photoshop";
  return "application/octet-stream";
}

function previewExtension(type: RasterPreviewResult["outputType"]) {
  return type === "image/png" ? ("png" as const) : ("webp" as const);
}

function checkpointRow(
  task: UploadTask,
  ownerId: string,
  hash: string,
  existing: UploadCheckpointRow | undefined,
  additions: Partial<UploadCheckpointRow> = {},
): UploadCheckpointRow {
  return {
    localTaskId: task.localTaskId,
    ownerId,
    patternId: task.patternId,
    sourceAssetId: task.sourceAssetId,
    previewAssetId: task.previewAssetId,
    thumbnailAssetId: task.thumbnailAssetId,
    operationId: task.operationId,
    filename: task.filename,
    extension: task.extension,
    size: task.size,
    lastModified: task.lastModified,
    contentHash: hash,
    objectKeys: existing?.objectKeys ?? {},
    sdkCheckpoints: existing?.sdkCheckpoints ?? {},
    updatedAt: Date.now(),
    ...existing,
    ...additions,
  };
}

function assertReselectedFile(
  task: UploadTask,
  file: File,
  checkpoint: UploadCheckpointRow | undefined,
) {
  const expected = checkpoint ?? task;
  if (
    file.name !== expected.filename ||
    file.size !== expected.size ||
    file.lastModified !== expected.lastModified
  ) {
    throw new Error("UPLOAD_RESELECT_MISMATCH");
  }
}

function completionAssetsForCheckpoint(checkpoint: UploadCheckpointRow) {
  if (checkpoint.completionAssets?.length) return checkpoint.completionAssets;
  if (
    checkpoint.objectKeys.source &&
    checkpoint.sdkCheckpoints.source?.completed === true &&
    !checkpoint.objectKeys.preview &&
    !checkpoint.objectKeys.thumbnail &&
    supportedExtensions.has(checkpoint.extension as UploadSourceExtension)
  ) {
    return [
      {
        assetId: checkpoint.sourceAssetId,
        role: "source" as const,
        objectKey: checkpoint.objectKeys.source,
        extension: checkpoint.extension as UploadSourceExtension,
        sizeBytes: checkpoint.size,
      },
    ];
  }
  return null;
}

export function canRecoverUploadCompletion(checkpoint: UploadCheckpointRow) {
  return Boolean(
    checkpoint.sessionId && completionAssetsForCheckpoint(checkpoint),
  );
}

async function completeFromCheckpoint(
  checkpoint: UploadCheckpointRow,
  dependencies: UploadRunnerDependencies,
) {
  const assets = completionAssetsForCheckpoint(checkpoint);
  if (!checkpoint.sessionId || !assets) {
    throw new Error("UPLOAD_COMPLETION_NOT_RECOVERABLE");
  }
  dependencies.onUpdate({
    status: "processing",
    progress: 99,
    completionStartedAt:
      checkpoint.completionStartedAt ?? checkpoint.updatedAt,
    canRecoverCompletion: true,
    error: undefined,
  });
  await dependencies.api.complete(checkpoint.sessionId, {
    operationId: checkpoint.operationId,
    assets,
  });
  await dependencies.checkpoints.delete(checkpoint.localTaskId);
  dependencies.onUpdate({
    status: "ready",
    progress: 100,
    canRecoverCompletion: false,
    error: undefined,
  });
  return { status: "ready" as const, patternId: checkpoint.patternId };
}

export async function recoverUploadCompletion(
  task: UploadTask,
  dependencies: UploadRunnerDependencies,
) {
  try {
    const checkpoint = await dependencies.checkpoints.load(task.localTaskId);
    if (!checkpoint) throw new Error("UPLOAD_COMPLETION_NOT_RECOVERABLE");
    return await completeFromCheckpoint(checkpoint, dependencies);
  } catch (error) {
    dependencies.onUpdate({ status: "failed", error: friendlyError(error) });
    throw error;
  }
}

export async function runUpload(
  task: UploadTask,
  file: File,
  dependencies: UploadRunnerDependencies,
): Promise<{ status: "ready" | "paused"; patternId: string }> {
  const { signal } = dependencies;
  let checkpoint = await dependencies.checkpoints.load(task.localTaskId);
  const throwIfPaused = () => {
    if (signal?.aborted) throw new DOMException("Paused", "AbortError");
  };
  try {
    if (
      checkpoint?.sessionId &&
      completionAssetsForCheckpoint(checkpoint)
    ) {
      return await completeFromCheckpoint(checkpoint, dependencies);
    }
    throwIfPaused();
    assertUploadFile(file);
    assertReselectedFile(task, file, checkpoint);
    dependencies.onUpdate({ status: "hashing", progress: 0, error: undefined });
    const contentHash = await dependencies.hashFile(file);
    throwIfPaused();
    const expectedHash = checkpoint?.contentHash ?? task.contentHash;
    if (expectedHash && expectedHash !== contentHash) {
      throw new Error("UPLOAD_RESELECT_MISMATCH");
    }
    dependencies.onUpdate({ contentHash });
    checkpoint = checkpointRow(task, dependencies.ownerId, contentHash, checkpoint);
    await dependencies.checkpoints.save(checkpoint);

    let preview: RasterPreviewResult | null = null;
    try {
      preview = await dependencies.generatePreview(file);
    } catch {
      preview = null;
    }
    throwIfPaused();

    const initialized = await dependencies.api.initialize({
      patternId: task.patternId,
      sourceAssetId: task.sourceAssetId,
      operationId: task.operationId,
      originalFilename: task.filename,
      extension: task.extension,
      sizeBytes: task.size,
      lastModified: task.lastModified,
      contentHash,
    });
    throwIfPaused();
    const derivedExtension = preview ? previewExtension(preview.outputType) : undefined;
    const objectKeys: UploadCheckpointRow["objectKeys"] = {
      source: initialized.sourceAsset.objectKey,
      ...(derivedExtension
        ? {
            preview: storageObjectKey({
              ownerId: dependencies.ownerId,
              patternId: task.patternId,
              assetId: task.previewAssetId,
              role: "preview",
              extension: derivedExtension,
            }),
            thumbnail: storageObjectKey({
              ownerId: dependencies.ownerId,
              patternId: task.patternId,
              assetId: task.thumbnailAssetId,
              role: "thumbnail",
              extension: derivedExtension,
            }),
          }
        : {}),
    };
    checkpoint = checkpointRow(task, dependencies.ownerId, contentHash, checkpoint, {
      sessionId: initialized.session.id,
      objectKeys,
    });
    await dependencies.checkpoints.save(checkpoint);
    dependencies.onUpdate({
      sessionId: initialized.session.id,
      status: "uploading",
      progress: 1,
    });

    let credentials = initialized.credentials;
    let refreshed = false;
    const uploadAsset = async (
      role: UploadAssetKind,
      blob: Blob,
      contentType: string,
      start: number,
      span: number,
    ) => {
      const objectKey = objectKeys[role];
      if (!objectKey) throw new Error("UPLOAD_OBJECT_KEY_MISSING");
      if (checkpoint?.sdkCheckpoints[role]?.completed === true) {
        dependencies.onUpdate({ progress: Math.min(99, start + span) });
        return;
      }
      const perform = () =>
        dependencies.multipart.upload({
          credentials,
          objectKey,
          file: blob,
          contentType,
          checkpoint: checkpoint?.sdkCheckpoints[role],
          signal,
          onProgress: (fraction) =>
            dependencies.onUpdate({
              progress: Math.min(99, Math.round(start + fraction * span)),
            }),
          onCheckpoint: async (sdkCheckpoint) => {
            checkpoint = checkpointRow(
              task,
              dependencies.ownerId,
              contentHash,
              checkpoint,
              {
              sdkCheckpoints: {
                ...checkpoint?.sdkCheckpoints,
                [role]: sdkCheckpoint as SafeSdkCheckpoint,
              },
              },
            );
            await dependencies.checkpoints.save(checkpoint);
          },
        });
      try {
        await perform();
      } catch (error) {
        if (!refreshed && isCredentialExpired(error) && !signal?.aborted) {
          refreshed = true;
          credentials = (
            await dependencies.api.refreshCredentials(
              initialized.session.id,
              task.operationId,
            )
          ).credentials;
          await perform();
        } else {
          throw error;
        }
      }
      checkpoint = checkpointRow(
        task,
        dependencies.ownerId,
        contentHash,
        checkpoint,
        {
          sdkCheckpoints: {
            ...checkpoint?.sdkCheckpoints,
            [role]: {
              ...checkpoint?.sdkCheckpoints[role],
              completed: true,
            },
          },
        },
      );
      await dependencies.checkpoints.save(checkpoint);
    };

    await uploadAsset(
      "source",
      file,
      contentTypeForSource(task.extension),
      1,
      preview ? 78 : 96,
    );

    const assets: UploadCompletionAsset[] = [
      {
        assetId: task.sourceAssetId,
        role: "source",
        objectKey: objectKeys.source!,
        extension: task.extension,
        sizeBytes: task.size,
      },
    ];
    if (preview && derivedExtension) {
      await uploadAsset("preview", preview.preview, preview.outputType, 79, 14);
      await uploadAsset("thumbnail", preview.thumbnail, preview.outputType, 93, 6);
      assets.push(
        {
          assetId: task.previewAssetId,
          role: "preview",
          objectKey: objectKeys.preview!,
          extension: derivedExtension,
          sizeBytes: preview.preview.size,
          width: preview.previewWidth,
          height: preview.previewHeight,
        },
        {
          assetId: task.thumbnailAssetId,
          role: "thumbnail",
          objectKey: objectKeys.thumbnail!,
          extension: derivedExtension,
          sizeBytes: preview.thumbnail.size,
          width: preview.thumbnailWidth,
          height: preview.thumbnailHeight,
        },
      );
    }

    const completionStartedAt = Date.now();
    checkpoint = checkpointRow(
      task,
      dependencies.ownerId,
      contentHash,
      checkpoint,
      { completionAssets: assets, completionStartedAt },
    );
    await dependencies.checkpoints.save(checkpoint);
    dependencies.onUpdate({
      status: "processing",
      progress: 99,
      completionStartedAt,
      canRecoverCompletion: true,
    });
    await dependencies.api.complete(initialized.session.id, {
      operationId: task.operationId,
      assets,
    });
    await dependencies.checkpoints.delete(task.localTaskId);
    dependencies.onUpdate({
      status: "ready",
      progress: 100,
      canRecoverCompletion: false,
    });
    return { status: "ready", patternId: task.patternId };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      dependencies.onUpdate({ status: "paused" });
      return { status: "paused", patternId: task.patternId };
    }
    dependencies.onUpdate({ status: "failed", error: friendlyError(error) });
    throw error;
  }
}

export async function abandonUpload(
  task: UploadTask,
  dependencies: UploadRunnerDependencies,
) {
  const checkpoint = await dependencies.checkpoints.load(task.localTaskId);
  let attempted = false;
  let succeeded = false;
  try {
    if (checkpoint?.sessionId) {
      const multipartEntries = Object.entries(checkpoint.sdkCheckpoints).filter(
        (entry): entry is [UploadAssetKind, SafeSdkCheckpoint] =>
          Boolean(entry[1]) &&
          entry[1].completed !== true &&
          Boolean(checkpoint.objectKeys[entry[0] as UploadAssetKind]),
      );
      if (multipartEntries.length > 0) {
        attempted = true;
        try {
          const { credentials } = await dependencies.api.refreshCredentials(
            checkpoint.sessionId,
            task.operationId,
          );
          const results = await Promise.all(
            multipartEntries.map(([role, sdkCheckpoint]) =>
              dependencies.multipart.abort({
                credentials,
                objectKey: checkpoint.objectKeys[role]!,
                checkpoint: sdkCheckpoint,
              }),
            ),
          );
          succeeded = results.every(Boolean);
        } catch {
          succeeded = false;
        }
      }
      await dependencies.api.cancel(checkpoint.sessionId, {
        operationId: task.operationId,
        ...(attempted ? { multipartAbort: { attempted, succeeded } } : {}),
      });
    }
  } finally {
    await dependencies.checkpoints.delete(task.localTaskId);
  }
}
