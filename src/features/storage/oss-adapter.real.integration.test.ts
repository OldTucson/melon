import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import OSS from "ali-oss";
import { config as loadDotEnv } from "dotenv";
import { describe, expect, it } from "vitest";

import {
  patternObjectPrefix,
  sourceObjectKey,
} from "@/features/storage/object-keys";
import {
  REAL_OSS_TEST_BODY_TIMEOUT_MS,
  REAL_OSS_TEST_CLEANUP_TIMEOUT_MS,
  REAL_OSS_TEST_SHUTDOWN_TIMEOUT_MS,
  REAL_OSS_TEST_TIMEOUT_MS,
  UPLOAD_REQUEST_TIMEOUT_MS,
} from "@/features/storage/upload-timing";

import { createAlibabaBrowserCredentialIssuer } from "./cloud-credentials";
import { createAlibabaOssAdapter } from "./oss-adapter";
import {
  fetchBytesWithTimeout,
  runRealOssTestLifecycle,
  runRequestWithTimeout,
} from "./real-oss-test-lifecycle";

type OssOptionsWithRetryMax = OSS.Options & { retryMax: number };

const runRealOssTests = process.env.RUN_REAL_OSS_TESTS === "1";
const localEnv = runRealOssTests
  ? loadDotEnv({ path: path.join(process.cwd(), ".env.local") }).parsed ?? {}
  : {};

for (const name of [
  "ALIBABA_CLOUD_ACCESS_KEY_ID",
  "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
] as const) {
  if (localEnv[name]) process.env[name] = localEnv[name];
}

function requiredRealEnv(name: string) {
  const value = localEnv[name] ?? process.env[name];
  if (!value?.trim()) throw new Error(`REAL_OSS_ENV_MISSING:${name}`);
  return value.trim();
}

function realOssConfig() {
  const endpoint = requiredRealEnv("ALIYUN_OSS_ENDPOINT");
  return {
    bucket: requiredRealEnv("ALIYUN_OSS_BUCKET"),
    cname: requiredRealEnv("ALIYUN_OSS_CNAME") === "true",
    endpoint,
    region: requiredRealEnv("ALIYUN_OSS_REGION"),
    roleArn: requiredRealEnv("ALIYUN_STS_ROLE_ARN"),
    secure: new URL(endpoint).protocol === "https:",
  };
}

function deterministicPayload(size: number) {
  const bytes = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + 17) % 251;
  }
  return bytes;
}

async function cleanupRealOssResources(input: {
  adapter: ReturnType<typeof createAlibabaOssAdapter>;
  completed: boolean;
  key: string;
  prefix: string;
  uploadClient?: OSS;
  uploadId?: string;
}) {
  const errors: unknown[] = [];
  if (!input.completed && input.uploadClient && input.uploadId) {
    try {
      await input.uploadClient.abortMultipartUpload(input.key, input.uploadId);
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    const keys = await input.adapter.listObjectKeys(input.prefix);
    await input.adapter.deleteObjectsUnderPrefix(input.prefix, keys);
  } catch (error) {
    errors.push(error);
    try {
      await input.adapter.deleteObjects([input.key]);
    } catch (fallbackError) {
      errors.push(fallbackError);
    }
  }

  try {
    const remaining = await input.adapter.listObjectKeys(input.prefix);
    if (remaining.length > 0) {
      throw new Error("REAL_OSS_CLEANUP_INCOMPLETE");
    }
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "REAL_OSS_CLEANUP_FAILED");
  }
}

const describeRealOss = runRealOssTests ? describe : describe.skip;

describeRealOss("real OSS adapter", () => {
  it(
    "resumes multipart upload, validates, signs, downloads, and deletes an isolated object",
    async () => {
      const config = realOssConfig();
      const ownerId = randomUUID();
      const patternId = randomUUID();
      const assetId = randomUUID();
      const key = sourceObjectKey({
        ownerId,
        patternId,
        assetId,
        extension: "png",
      });
      const prefix = patternObjectPrefix({ ownerId, patternId });
      const payload = deterministicPayload(2 * 1024 * 1024 + 257);
      const partSize = 1024 * 1024;
      const adapter = createAlibabaOssAdapter(config);
      const issuer = createAlibabaBrowserCredentialIssuer(config);
      let uploadClient: OSS | undefined;
      let uploadId: string | undefined;
      let completed = false;

      await runRealOssTestLifecycle({
        body: async (signal) => {
          signal.throwIfAborted();
          const credentials = await runRequestWithTimeout(
            () => issuer.issue({ ownerId, patternId }),
            UPLOAD_REQUEST_TIMEOUT_MS,
          );
          signal.throwIfAborted();
          const clientOptions: OssOptionsWithRetryMax = {
            accessKeyId: credentials.accessKeyId,
            accessKeySecret: credentials.accessKeySecret,
            stsToken: credentials.securityToken,
            refreshSTSTokenInterval: 86_400_000,
            region: config.region,
            bucket: config.bucket,
            endpoint: config.endpoint,
            cname: config.cname,
            secure: config.secure,
            authorizationV4: true,
            retryMax: 0,
            timeout: UPLOAD_REQUEST_TIMEOUT_MS,
          };
          const client = new OSS(clientOptions);
          uploadClient = client;
          const initiated = await client.initMultipartUpload(key, {
            mime: "image/png",
            headers: { "x-oss-forbid-overwrite": "true" },
          });
          uploadId = initiated.uploadId;
          signal.throwIfAborted();
          const firstPart = await client.uploadPart(
            key,
            uploadId,
            1,
            payload,
            0,
            partSize,
          );
          signal.throwIfAborted();
          const firstPartEtag = Object.entries(firstPart.res.headers).find(
            ([name]) => name.toLowerCase() === "etag",
          )?.[1];
          if (typeof firstPartEtag !== "string") {
            throw new Error("REAL_OSS_PART_ETAG_MISSING");
          }
          const checkpoint: OSS.Checkpoint = {
            file: payload,
            name: key,
            fileSize: payload.byteLength,
            partSize,
            uploadId,
            doneParts: [{ number: 1, etag: firstPartEtag }],
          };
          const resumedFractions: number[] = [];
          const resumedUploadIds: string[] = [];

          await client.multipartUpload(key, payload, {
            checkpoint,
            parallel: 1,
            partSize,
            mime: "image/png",
            headers: { "x-oss-forbid-overwrite": "true" },
            progress: (fraction: number, nextCheckpoint?: OSS.Checkpoint) => {
              resumedFractions.push(fraction);
              if (nextCheckpoint) {
                resumedUploadIds.push(nextCheckpoint.uploadId);
              }
            },
          });
          completed = true;
          signal.throwIfAborted();

          expect(resumedFractions[0]).toBeGreaterThanOrEqual(0.5);
          expect(resumedUploadIds).toContain(uploadId);
          const metadata = await adapter.headObject(key);
          signal.throwIfAborted();
          expect(metadata).toMatchObject({
            contentType: "image/png",
            sizeBytes: payload.byteLength,
          });
          const range = await adapter.readRange(key, 0, 63);
          signal.throwIfAborted();
          expect(range).toEqual(Uint8Array.from(payload.subarray(0, 64)));

          const signedUrl = await adapter.createSignedGet({
            key,
            filename: "real-oss-check.png",
            expiresSeconds: 300,
          });
          signal.throwIfAborted();
          const { bytes, response } = await fetchBytesWithTimeout(signedUrl, {
            signal,
            timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
          });
          signal.throwIfAborted();
          expect(response.status).toBe(200);
          const downloaded = Buffer.from(bytes);
          expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
            createHash("sha256").update(payload).digest("hex"),
          );
          const listed = await adapter.listObjectKeys(prefix);
          signal.throwIfAborted();
          expect(listed).toEqual([key]);
        },
        bodyTimeoutMs: REAL_OSS_TEST_BODY_TIMEOUT_MS,
        cancelBody: () => uploadClient?.cancel(),
        cleanup: () =>
          cleanupRealOssResources({
            adapter,
            completed,
            key,
            prefix,
            uploadClient,
            uploadId,
          }),
        cleanupTimeoutMs: REAL_OSS_TEST_CLEANUP_TIMEOUT_MS,
        shutdownTimeoutMs: REAL_OSS_TEST_SHUTDOWN_TIMEOUT_MS,
      });
    },
    REAL_OSS_TEST_TIMEOUT_MS,
  );
});
