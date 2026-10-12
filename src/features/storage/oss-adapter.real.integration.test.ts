import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import OSS from "ali-oss";
import { config as loadDotEnv } from "dotenv";
import { describe, expect, it } from "vitest";

import { sourceObjectKey } from "@/features/storage/object-keys";

import { createAlibabaBrowserCredentialIssuer } from "./cloud-credentials";
import { createAlibabaOssAdapter } from "./oss-adapter";

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
      const payload = deterministicPayload(2 * 1024 * 1024 + 257);
      const partSize = 1024 * 1024;
      const adapter = createAlibabaOssAdapter(config);
      const issuer = createAlibabaBrowserCredentialIssuer(config);
      const credentials = await issuer.issue({ ownerId, patternId });
      const uploadClient = new OSS({
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
        timeout: 120_000,
      });
      let uploadId: string | undefined;
      let completed = false;

      try {
        const initiated = await uploadClient.initMultipartUpload(key, {
          mime: "image/png",
          headers: { "x-oss-forbid-overwrite": "true" },
        });
        uploadId = initiated.uploadId;
        const firstPart = await uploadClient.uploadPart(
          key,
          uploadId,
          1,
          payload,
          0,
          partSize,
        );
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

        await uploadClient.multipartUpload(key, payload, {
          checkpoint,
          parallel: 1,
          partSize,
          mime: "image/png",
          headers: { "x-oss-forbid-overwrite": "true" },
          progress: (fraction: number, nextCheckpoint?: OSS.Checkpoint) => {
            resumedFractions.push(fraction);
            if (nextCheckpoint) resumedUploadIds.push(nextCheckpoint.uploadId);
          },
        });
        completed = true;

        expect(resumedFractions[0]).toBeGreaterThanOrEqual(0.5);
        expect(resumedUploadIds).toContain(uploadId);
        await expect(adapter.headObject(key)).resolves.toMatchObject({
          contentType: "image/png",
          sizeBytes: payload.byteLength,
        });
        await expect(adapter.readRange(key, 0, 63)).resolves.toEqual(
          Uint8Array.from(payload.subarray(0, 64)),
        );

        const signedUrl = await adapter.createSignedGet({
          key,
          filename: "real-oss-check.png",
          expiresSeconds: 300,
        });
        const response = await fetch(signedUrl);
        expect(response.status).toBe(200);
        const downloaded = Buffer.from(await response.arrayBuffer());
        expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
          createHash("sha256").update(payload).digest("hex"),
        );
      } finally {
        if (!completed && uploadId) {
          await uploadClient
            .abortMultipartUpload(key, uploadId)
            .catch(() => undefined);
        }
        await adapter.deleteObjects([key]);
      }

      await expect(adapter.headObject(key)).rejects.toBeDefined();
    },
    120_000,
  );
});
