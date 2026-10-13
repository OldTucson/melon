"use client";

import OSS from "ali-oss";

import type { BrowserOssCredentials } from "@/features/storage/contracts";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "@/features/storage/upload-timing";

import type { SafeSdkCheckpoint } from "./upload-db";

function createClient(credentials: BrowserOssCredentials) {
  return new OSS({
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    stsToken: credentials.securityToken,
    region: credentials.region,
    bucket: credentials.bucket,
    endpoint: credentials.endpoint,
    cname: credentials.cname,
    secure: new URL(credentials.endpoint).protocol === "https:",
    authorizationV4: true,
    timeout: UPLOAD_REQUEST_TIMEOUT_MS,
  });
}

export const alibabaBrowserMultipartClient = {
  async upload(input: {
    credentials: BrowserOssCredentials;
    objectKey: string;
    file: Blob;
    contentType: string;
    checkpoint?: SafeSdkCheckpoint;
    signal?: AbortSignal;
    onProgress(fraction: number): void;
    onCheckpoint(checkpoint: unknown): Promise<void>;
  }) {
    if (input.signal?.aborted) throw new DOMException("Paused", "AbortError");
    const client = createClient(input.credentials);
    const cancel = () => client.cancel();
    input.signal?.addEventListener("abort", cancel, { once: true });
    try {
      await client.multipartUpload(input.objectKey, input.file, {
        checkpoint: input.checkpoint
          ? ({ ...input.checkpoint, file: input.file } as unknown as OSS.Checkpoint)
          : undefined,
        parallel: 4,
        partSize: 1024 * 1024,
        mime: input.contentType,
        headers: { "x-oss-forbid-overwrite": "true" },
        progress: async (fraction: number, checkpoint: unknown) => {
          input.onProgress(fraction);
          if (checkpoint) await input.onCheckpoint(checkpoint);
        },
      });
    } finally {
      input.signal?.removeEventListener("abort", cancel);
    }
  },

  async abort(input: {
    credentials: BrowserOssCredentials;
    objectKey: string;
    checkpoint: SafeSdkCheckpoint;
  }) {
    const uploadId = input.checkpoint.uploadId;
    if (typeof uploadId !== "string" || uploadId.length === 0) return false;
    const client = createClient(input.credentials);
    await client.abortMultipartUpload(input.objectKey, uploadId);
    return true;
  },
};
