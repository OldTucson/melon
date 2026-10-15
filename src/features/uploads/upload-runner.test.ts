import { describe, expect, it, vi } from "vitest";

import type { BrowserOssCredentials } from "@/features/storage/contracts";

import {
  abandonUpload,
  createUploadTask,
  recoverUploadCompletion,
  runUpload,
  type UploadRunnerDependencies,
} from "./upload-runner";
import type { UploadCheckpointRow } from "./upload-db";

const credentials: BrowserOssCredentials = {
  accessKeyId: "STS.id",
  accessKeySecret: "temporary-secret",
  securityToken: "temporary-token",
  expiration: "2026-10-10T12:15:00.000Z",
  region: "oss-cn-hangzhou",
  bucket: "melon-test-assets",
  endpoint: "https://assets.example.test",
  cname: true,
};

function createHarness() {
  const transitions: string[] = [];
  const saved: unknown[] = [];
  const upload = vi.fn(async (input: { onCheckpoint: (value: unknown) => Promise<void> }) => {
    await input.onCheckpoint({ uploadId: "multipart-1", name: "source" });
  });
  const initialize = vi.fn(async (input: { patternId: string; sourceAssetId: string; operationId: string }) => ({
    operationId: input.operationId,
    pattern: { id: input.patternId },
    sourceAsset: {
      id: input.sourceAssetId,
      objectKey: `users/10000000-0000-4000-8000-000000000000/patterns/${input.patternId}/source/${input.sourceAssetId}.png`,
    },
    session: { id: "00000000-0000-4000-8000-000000000099" },
    credentials,
  }));
  const dependencies: UploadRunnerDependencies = {
    ownerId: "10000000-0000-4000-8000-000000000000",
    api: {
      initialize,
      refreshCredentials: vi.fn(async () => ({ credentials })),
      complete: vi.fn(async () => ({ pattern: { id: "pattern" } })),
      cancel: vi.fn(async () => undefined),
    },
    multipart: {
      upload,
      abort: vi.fn(async () => true),
    },
    checkpoints: {
      load: vi.fn(async () => undefined),
      save: vi.fn(async (value) => void saved.push(value)),
      delete: vi.fn(async () => undefined),
    },
    generatePreview: vi.fn(async () => null),
    hashFile: vi.fn(async () => "a".repeat(64)),
    onUpdate: (patch) => {
      if (patch.status) transitions.push(patch.status);
    },
  };
  return { dependencies, initialize, saved, transitions, upload };
}

function completionCheckpoint(
  task: ReturnType<typeof createUploadTask>,
  ownerId: string,
): UploadCheckpointRow {
  const objectKey = `users/${ownerId}/patterns/${task.patternId}/source/${task.sourceAssetId}.${task.extension}`;
  return {
    localTaskId: task.localTaskId,
    ownerId,
    patternId: task.patternId,
    sourceAssetId: task.sourceAssetId,
    previewAssetId: task.previewAssetId,
    thumbnailAssetId: task.thumbnailAssetId,
    operationId: task.operationId,
    sessionId: "00000000-0000-4000-8000-000000000099",
    filename: task.filename,
    extension: task.extension,
    size: task.size,
    lastModified: task.lastModified,
    contentHash: "a".repeat(64),
    objectKeys: { source: objectKey },
    sdkCheckpoints: { source: { completed: true } },
    completionAssets: [
      {
        assetId: task.sourceAssetId,
        role: "source",
        objectKey,
        extension: task.extension,
        sizeBytes: task.size,
      },
    ],
    completionStartedAt: 1,
    updatedAt: 1,
  };
}

describe("upload runner", () => {
  it("uses stable IDs through init, multipart, and complete", async () => {
    const file = new File(["png"], "leaf.png", {
      type: "image/png",
      lastModified: 123,
    });
    const task = createUploadTask(file, {
      randomUUID: vi.fn()
        .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
        .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
        .mockReturnValueOnce("00000000-0000-4000-8000-000000000003")
        .mockReturnValueOnce("00000000-0000-4000-8000-000000000004")
        .mockReturnValueOnce("00000000-0000-4000-8000-000000000005")
        .mockReturnValueOnce("00000000-0000-4000-8000-000000000006"),
    });
    const harness = createHarness();

    const result = await runUpload(task, file, harness.dependencies);

    expect(result).toMatchObject({ status: "ready", patternId: task.patternId });
    expect(harness.transitions).toEqual([
      "hashing",
      "uploading",
      "processing",
      "ready",
    ]);
    expect(harness.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        patternId: task.patternId,
        sourceAssetId: task.sourceAssetId,
        operationId: task.operationId,
      }),
    );
    expect(harness.dependencies.api.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ operationId: task.operationId }),
    );
  });

  it("refreshes expired credentials once and resumes from the saved checkpoint", async () => {
    const file = new File(["png"], "leaf.png", { lastModified: 123 });
    const task = createUploadTask(file);
    const harness = createHarness();
    harness.upload
      .mockRejectedValueOnce(Object.assign(new Error("expired"), { code: "SecurityTokenExpired" }))
      .mockResolvedValueOnce(undefined);

    await runUpload(task, file, harness.dependencies);

    expect(harness.dependencies.api.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(harness.upload).toHaveBeenCalledTimes(2);
  });

  it("retries completion without uploading an already completed source again", async () => {
    const file = new File(["png"], "leaf.png", { lastModified: 123 });
    const task = createUploadTask(file);
    const harness = createHarness();
    let stored: unknown;
    harness.dependencies.checkpoints.save = vi.fn(async (row) => {
      stored = structuredClone(row);
    });
    harness.dependencies.checkpoints.load = vi.fn(async () => stored as never);
    harness.dependencies.api.complete = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ pattern: { id: task.patternId } });

    await expect(runUpload(task, file, harness.dependencies)).rejects.toThrow(
      "offline",
    );
    await expect(runUpload(task, file, harness.dependencies)).resolves.toMatchObject({
      status: "ready",
    });
    expect(harness.upload).toHaveBeenCalledTimes(1);
    expect(harness.initialize).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.hashFile).toHaveBeenCalledTimes(1);
  });

  it("replays a persisted completion without hashing, initializing, or uploading", async () => {
    const file = new File(["png"], "leaf.png", { lastModified: 123 });
    const task = createUploadTask(file);
    const harness = createHarness();
    const checkpoint = completionCheckpoint(
      task,
      harness.dependencies.ownerId,
    );
    harness.dependencies.checkpoints.load = vi.fn(async () => checkpoint);

    await expect(
      recoverUploadCompletion(task, harness.dependencies),
    ).resolves.toEqual({ status: "ready", patternId: task.patternId });

    expect(harness.dependencies.api.complete).toHaveBeenCalledWith(
      checkpoint.sessionId,
      {
        operationId: task.operationId,
        assets: checkpoint.completionAssets,
      },
    );
    expect(harness.initialize).not.toHaveBeenCalled();
    expect(harness.upload).not.toHaveBeenCalled();
    expect(harness.dependencies.hashFile).not.toHaveBeenCalled();
    expect(harness.dependencies.checkpoints.delete).toHaveBeenCalledWith(
      task.localTaskId,
    );
  });

  it("recovers a legacy source-only completion checkpoint", async () => {
    const task = createUploadTask(
      new File(["png"], "leaf.png", { lastModified: 123 }),
    );
    const harness = createHarness();
    const current = completionCheckpoint(task, harness.dependencies.ownerId);
    const legacy: UploadCheckpointRow = { ...current };
    delete legacy.completionAssets;
    harness.dependencies.checkpoints.load = vi.fn(async () => legacy);

    await expect(
      recoverUploadCompletion(task, harness.dependencies),
    ).resolves.toMatchObject({ status: "ready" });

    expect(harness.dependencies.api.complete).toHaveBeenCalledWith(
      current.sessionId,
      {
        operationId: task.operationId,
        assets: current.completionAssets,
      },
    );
  });

  it("does not guess missing metadata for a legacy derived preview", async () => {
    const task = createUploadTask(
      new File(["png"], "leaf.png", { lastModified: 123 }),
    );
    const harness = createHarness();
    const current = completionCheckpoint(task, harness.dependencies.ownerId);
    const legacy: UploadCheckpointRow = { ...current };
    delete legacy.completionAssets;
    legacy.objectKeys = {
      ...legacy.objectKeys,
      preview: "users/u/patterns/p/preview/id.webp",
    };
    harness.dependencies.checkpoints.load = vi.fn(async () => legacy);

    await expect(
      recoverUploadCompletion(task, harness.dependencies),
    ).rejects.toThrow("UPLOAD_COMPLETION_NOT_RECOVERABLE");
    expect(harness.dependencies.api.complete).not.toHaveBeenCalled();
  });

  it("verifies a reselected file before any OSS call", async () => {
    const original = new File(["original"], "leaf.png", { lastModified: 123 });
    const selected = new File(["changed"], "leaf.png", { lastModified: 123 });
    const task = {
      ...createUploadTask(original),
      contentHash: "a".repeat(64),
    };
    const harness = createHarness();
    harness.dependencies.hashFile = vi.fn(async () => "b".repeat(64));

    await expect(runUpload(task, selected, harness.dependencies)).rejects.toThrow(
      "UPLOAD_RESELECT_MISMATCH",
    );
    expect(harness.initialize).not.toHaveBeenCalled();
    expect(harness.upload).not.toHaveBeenCalled();
  });

  it("pauses without deleting recovery state and abandons by aborting and deleting it", async () => {
    const file = new File(["png"], "leaf.png", { lastModified: 123 });
    const task = createUploadTask(file);
    const harness = createHarness();
    const controller = new AbortController();
    harness.dependencies.signal = controller.signal;
    harness.upload.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException("Paused", "AbortError");
    });

    const paused = await runUpload(task, file, harness.dependencies);
    expect(paused.status).toBe("paused");
    expect(harness.dependencies.checkpoints.delete).not.toHaveBeenCalled();

    const checkpoint = {
      localTaskId: task.localTaskId,
      sessionId: "00000000-0000-4000-8000-000000000099",
      operationId: task.operationId,
      objectKeys: { source: "source" },
      sdkCheckpoints: { source: { name: "source", uploadId: "multipart-1" } },
    };
    harness.dependencies.checkpoints.load = vi.fn(async () => checkpoint as never);
    await abandonUpload(task, harness.dependencies);
    expect(harness.dependencies.multipart.abort).toHaveBeenCalled();
    expect(harness.dependencies.api.cancel).toHaveBeenCalled();
    expect(harness.dependencies.checkpoints.delete).toHaveBeenCalledWith(
      task.localTaskId,
    );
  });

  it("deletes the local checkpoint even when server cancellation fails", async () => {
    const task = createUploadTask(
      new File(["png"], "leaf.png", { lastModified: 123 }),
    );
    const harness = createHarness();
    harness.dependencies.checkpoints.load = vi.fn(async () => ({
      localTaskId: task.localTaskId,
      ownerId: harness.dependencies.ownerId,
      patternId: task.patternId,
      sourceAssetId: task.sourceAssetId,
      previewAssetId: task.previewAssetId,
      thumbnailAssetId: task.thumbnailAssetId,
      operationId: task.operationId,
      sessionId: "00000000-0000-4000-8000-000000000099",
      filename: task.filename,
      extension: task.extension,
      size: task.size,
      lastModified: task.lastModified,
      contentHash: "a".repeat(64),
      objectKeys: {},
      sdkCheckpoints: {},
      updatedAt: 1,
    }));
    harness.dependencies.api.cancel = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(abandonUpload(task, harness.dependencies)).rejects.toThrow("offline");
    expect(harness.dependencies.checkpoints.delete).toHaveBeenCalledWith(
      task.localTaskId,
    );
  });
});
