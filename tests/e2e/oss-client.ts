import { createHash } from "node:crypto";

import OSS from "ali-oss";

import { createAlibabaCredential } from "../../src/features/storage/alibaba-credential";
import { E2E_USERS } from "./environment";
import { assertE2eObjectKeys } from "./oss-safety";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`E2E_ENV_MISSING:${name}`);
  return value;
}

export async function createE2eOssClient() {
  const credential = createAlibabaCredential();
  const resolved = await credential.getCredential();
  if (
    typeof resolved.accessKeyId !== "string" ||
    typeof resolved.accessKeySecret !== "string"
  ) {
    throw new Error("E2E_OSS_CREDENTIALS_INVALID");
  }

  const endpoint = requiredEnv("ALIYUN_OSS_ENDPOINT");
  return new OSS({
    accessKeyId: resolved.accessKeyId,
    accessKeySecret: resolved.accessKeySecret,
    ...(typeof resolved.securityToken === "string"
      ? { stsToken: resolved.securityToken }
      : {}),
    region: requiredEnv("ALIYUN_OSS_REGION"),
    bucket: requiredEnv("ALIYUN_OSS_BUCKET"),
    endpoint,
    cname: process.env.ALIYUN_OSS_CNAME === "true",
    secure: new URL(endpoint).protocol === "https:",
    authorizationV4: true,
  });
}

export async function assertE2eOssListAccess() {
  const client = await createE2eOssClient();
  try {
    await client.listV2({
      prefix: `users/${E2E_USERS.designer.id}/patterns/`,
      "max-keys": 1,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "AccessDenied"
    ) {
      throw new Error("E2E_OSS_LIST_PERMISSION_MISSING");
    }
    throw error;
  }
}

export async function hashE2eOssObjects(
  assets: readonly { id: string; objectKey: string }[],
) {
  const keys = assets.map((asset) => asset.objectKey);
  assertE2eObjectKeys(keys);
  const client = await createE2eOssClient();
  const hashes: Record<string, string> = {};
  for (const asset of assets) {
    const result = await client.get(asset.objectKey);
    hashes[asset.id] = createHash("sha256").update(result.content).digest("hex");
  }
  return hashes;
}

function isNotFound(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  return (
    candidate.code === "NoSuchKey" ||
    candidate.status === 404 ||
    candidate.statusCode === 404
  );
}

export async function assertE2eOssObjectsMissing(objectKeys: readonly string[]) {
  assertE2eObjectKeys(objectKeys);
  const client = await createE2eOssClient();
  for (const objectKey of objectKeys) {
    try {
      await client.head(objectKey);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    throw new Error("E2E_OSS_OBJECT_STILL_PRESENT");
  }
}
