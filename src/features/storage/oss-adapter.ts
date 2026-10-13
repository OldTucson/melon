import "server-only";

import OSS from "ali-oss";
import { z } from "zod";

import { createAlibabaCredential } from "./alibaba-credential";
import type { OssAdapter, OssConnectionConfig } from "./contracts";
import {
  assertCanonicalPatternPrefix,
  assertObjectKeyWithinPatternPrefix,
} from "./object-keys";
import {
  assertCanonicalObjectKey,
  assertValidObjectRange,
  OSS_DELETE_BATCH_SIZE,
  parseDeleteObjectKeys,
  parseOssConnectionConfig,
  parseSignedGetInput,
} from "./validation";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "./upload-timing";

const resolvedCredentialSchema = z.object({
  accessKeyId: z.string().min(1),
  accessKeySecret: z.string().min(1),
  securityToken: z.string().min(1).optional(),
});
const resolvedTemporaryCredentialSchema = resolvedCredentialSchema.extend({
  securityToken: z.string().min(1),
});

type ResolvedCredential = z.output<typeof resolvedCredentialSchema>;
type OssOptionsWithRetryMax = OSS.Options & { retryMax: number };

type OssSdkClient = Pick<
  OSS,
  "head" | "get" | "listV2" | "deleteMulti" | "signatureUrlV4"
>;

type OssSdkClientFactory = (
  config: OssConnectionConfig,
) => Promise<OssSdkClient>;

type OssSignerClientFactory = (
  config: OssConnectionConfig,
  credential: ResolvedCredential,
) => Pick<OSS, "signatureUrlV4">;

type OssCredentialResolver = () => Promise<unknown>;
type OssCredentialProvider = {
  getCredential(): Promise<unknown>;
};
type OssCredentialProviderFactory = () => OssCredentialProvider;

function encodeDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createDefaultCredentialResolver(
  createCredentialProvider: OssCredentialProviderFactory = () =>
    createAlibabaCredential(),
): OssCredentialResolver {
  let credentialProvider: OssCredentialProvider | undefined;
  let inFlight: Promise<unknown> | undefined;

  return async () => {
    if (inFlight) return inFlight;

    const currentProvider = (credentialProvider ??=
      createCredentialProvider());
    const attempt = Promise.resolve().then(() =>
      currentProvider.getCredential(),
    );
    inFlight = attempt;

    try {
      return await attempt;
    } catch (error) {
      if (credentialProvider === currentProvider) {
        credentialProvider = undefined;
      }
      throw error;
    } finally {
      if (inFlight === attempt) inFlight = undefined;
    }
  };
}

async function createDefaultClient(
  input: OssConnectionConfig,
  getCredential: () => Promise<ResolvedCredential>,
): Promise<OssSdkClient> {
  const config = parseOssConnectionConfig(input);
  const initial = await getCredential();
  const refreshSTSToken = async () => {
    const refreshed = resolvedTemporaryCredentialSchema.parse(
      await getCredential(),
    );

    return {
      accessKeyId: refreshed.accessKeyId,
      accessKeySecret: refreshed.accessKeySecret,
      stsToken: refreshed.securityToken,
    };
  };

  const options: OssOptionsWithRetryMax = {
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
    retryMax: 0,
    timeout: UPLOAD_REQUEST_TIMEOUT_MS,
  };
  return new OSS(options);
}

function createSnapshotSignerClient(
  input: OssConnectionConfig,
  credential: ResolvedCredential,
) {
  const config = parseOssConnectionConfig(input);

  return new OSS({
    accessKeyId: credential.accessKeyId,
    accessKeySecret: credential.accessKeySecret,
    ...(credential.securityToken
      ? {
          stsToken: credential.securityToken,
          refreshSTSTokenInterval: 86_400_000,
        }
      : {}),
    region: config.region,
    bucket: config.bucket,
    endpoint: config.endpoint,
    cname: config.cname,
    secure: true,
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
  dependencies: {
    createClient?: OssSdkClientFactory;
    getCredential?: OssCredentialResolver;
    createSignerClient?: OssSignerClientFactory;
  } = {},
): OssAdapter {
  const config = parseOssConnectionConfig(inputConfig);
  const resolveCredential =
    dependencies.getCredential ?? createDefaultCredentialResolver();
  const getCredential = async () =>
    resolvedCredentialSchema.parse(await resolveCredential());
  const createClient =
    dependencies.createClient ??
    ((clientConfig) => createDefaultClient(clientConfig, getCredential));
  const createSignerClient =
    dependencies.createSignerClient ?? createSnapshotSignerClient;
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
    async listObjectKeys(prefix) {
      const canonicalPrefix = assertCanonicalPatternPrefix(prefix);
      const client = await getClient();
      const keys: string[] = [];
      const seenTokens = new Set<string>();
      let continuationToken: string | undefined;

      do {
        const result = await client.listV2({
          prefix: canonicalPrefix,
          "max-keys": 1_000,
          ...(continuationToken
            ? { "continuation-token": continuationToken }
            : {}),
        });
        if (!Array.isArray(result.objects)) {
          throw new Error("OSS_LIST_RESPONSE_INVALID");
        }
        for (const object of result.objects) {
          keys.push(
            assertObjectKeyWithinPatternPrefix(
              canonicalPrefix,
              object.name,
            ),
          );
        }
        if (!result.isTruncated) break;
        const next = result.nextContinuationToken;
        if (
          typeof next !== "string" ||
          next.length === 0 ||
          seenTokens.has(next)
        ) {
          throw new Error("OSS_LIST_RESPONSE_INVALID");
        }
        seenTokens.add(next);
        continuationToken = next;
      } while (true);

      return keys;
    },

    async headObject(key) {
      assertCanonicalObjectKey(key);
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
      assertCanonicalObjectKey(key);
      assertValidObjectRange(start, endInclusive);

      const result = await (await getClient()).get(key, {
        headers: { Range: `bytes=${start}-${endInclusive}` },
      });
      return copyResponseBytes(result.content);
    },

    async deleteObjects(keys) {
      const parsedKeys = parseDeleteObjectKeys(keys);
      if (parsedKeys.length === 0) return;
      const client = await getClient();

      for (
        let start = 0;
        start < parsedKeys.length;
        start += OSS_DELETE_BATCH_SIZE
      ) {
        await client.deleteMulti(
          parsedKeys.slice(start, start + OSS_DELETE_BATCH_SIZE),
          { quiet: true },
        );
      }
    },

    async deleteObjectsUnderPrefix(prefix, keys) {
      const canonicalPrefix = assertCanonicalPatternPrefix(prefix);
      const parsedKeys = keys.map((key) =>
        assertObjectKeyWithinPatternPrefix(canonicalPrefix, key),
      );
      if (parsedKeys.length === 0) return;
      const client = await getClient();

      for (
        let start = 0;
        start < parsedKeys.length;
        start += OSS_DELETE_BATCH_SIZE
      ) {
        await client.deleteMulti(
          parsedKeys.slice(start, start + OSS_DELETE_BATCH_SIZE),
          { quiet: true },
        );
      }
    },

    async createSignedGet(input) {
      const parsed = parseSignedGetInput(input);
      const credential = await getCredential();
      const signerClient = createSignerClient(config, credential);
      return signerClient.signatureUrlV4(
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
