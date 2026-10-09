import "server-only";

import Credential from "@alicloud/credentials";
import OSS from "ali-oss";
import { z } from "zod";

import type { OssAdapter, OssConnectionConfig } from "./contracts";
import { parseObjectKey } from "./object-keys";

const connectionConfigSchema = z.object({
  region: z.string().regex(/^oss-[a-z0-9-]+$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  endpoint: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === "https:"),
  cname: z.boolean(),
});

const signedGetSchema = z.object({
  key: z.string().min(1),
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "Invalid download filename",
    }),
  expiresSeconds: z.number().int().min(1).max(3600),
});

const resolvedCredentialSchema = z.object({
  accessKeyId: z.string().min(1),
  accessKeySecret: z.string().min(1),
  securityToken: z.string().min(1).optional(),
});

type OssSdkClient = Pick<
  OSS,
  "head" | "get" | "deleteMulti" | "signatureUrlV4"
>;

type OssSdkClientFactory = (
  config: OssConnectionConfig,
) => Promise<OssSdkClient>;

function encodeDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function createDefaultClient(
  input: OssConnectionConfig,
): Promise<OssSdkClient> {
  const config = connectionConfigSchema.parse(input);
  const credentialProvider = new Credential();
  const initial = resolvedCredentialSchema.parse(
    await credentialProvider.getCredential(),
  );
  const refreshSTSToken = async () => {
    const refreshed = resolvedCredentialSchema.extend({
      securityToken: z.string().min(1),
    }).parse(await credentialProvider.getCredential());

    return {
      accessKeyId: refreshed.accessKeyId,
      accessKeySecret: refreshed.accessKeySecret,
      stsToken: refreshed.securityToken,
    };
  };

  return new OSS({
    accessKeyId: initial.accessKeyId,
    accessKeySecret: initial.accessKeySecret,
    ...(initial.securityToken
      ? {
          stsToken: initial.securityToken,
          refreshSTSToken,
        }
      : {}),
    region: config.region,
    bucket: config.bucket,
    endpoint: config.endpoint,
    cname: config.cname,
    secure: new URL(config.endpoint).protocol === "https:",
    authorizationV4: true,
  });
}

function responseHeader(headers: object, name: string) {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

function copyResponseBytes(value: unknown) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw new Error("OSS_RANGE_RESPONSE_INVALID");
}

export function createAlibabaOssAdapter(
  inputConfig: OssConnectionConfig,
  dependencies: { createClient?: OssSdkClientFactory } = {},
): OssAdapter {
  const config = connectionConfigSchema.parse(inputConfig);
  const createClient = dependencies.createClient ?? createDefaultClient;
  let clientPromise: Promise<OssSdkClient> | undefined;
  const getClient = async () => {
    const attempt = (clientPromise ??= createClient(config));
    try {
      return await attempt;
    } catch (error) {
      if (clientPromise === attempt) clientPromise = undefined;
      throw error;
    }
  };

  return {
    async headObject(key) {
      parseObjectKey(key);
      const result = await (await getClient()).head(key);
      const contentLength = responseHeader(result.res.headers, "content-length");
      const sizeBytes = Number(contentLength);

      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new Error("OSS_HEAD_RESPONSE_INVALID");
      }

      const contentType = responseHeader(result.res.headers, "content-type");
      return {
        sizeBytes,
        contentType:
          typeof contentType === "string"
            ? contentType
            : "application/octet-stream",
      };
    },

    async readRange(key, start, endInclusive) {
      parseObjectKey(key);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(endInclusive) ||
        start < 0 ||
        endInclusive < start
      ) {
        throw new Error("OSS_RANGE_INVALID");
      }

      const result = await (await getClient()).get(key, {
        headers: { Range: `bytes=${start}-${endInclusive}` },
      });
      return copyResponseBytes(result.content);
    },

    async deleteObjects(keys) {
      keys.forEach(parseObjectKey);
      if (keys.length === 0) return;
      await (await getClient()).deleteMulti(keys, { quiet: true });
    },

    async createSignedGet(input) {
      const parsed = signedGetSchema.parse(input);
      parseObjectKey(parsed.key);
      return (await getClient()).signatureUrlV4(
        "GET",
        parsed.expiresSeconds,
        {
          queries: {
            "response-content-disposition": `attachment; filename*=UTF-8''${encodeDispositionFilename(parsed.filename)}`,
          },
        },
        parsed.key,
      );
    },
  };
}
