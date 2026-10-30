import "server-only";

import OSS from "ali-oss";
import { z } from "zod";

import type { OssConnectionConfig } from "@/features/storage/contracts";
import { createDefaultCredentialResolver } from "@/features/storage/oss-adapter";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "@/features/storage/upload-timing";
import { OSS_DELETE_BATCH_SIZE, parseOssConnectionConfig } from "@/features/storage/validation";

import { parseVisualObjectKey } from "./visual-object-keys";

export interface VisualObjectStore {
  put(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  delete(keys: readonly string[]): Promise<void>;
}

const credentialSchema = z.object({ accessKeyId: z.string().min(1), accessKeySecret: z.string().min(1), securityToken: z.string().min(1).optional() });
const contentTypes = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
type Client = Pick<OSS, "put" | "get" | "deleteMulti">;
const unavailable = () => new Error("Visual object unavailable");

export function createVisualObjectStore(input: OssConnectionConfig, dependencies: {
  getCredential?: () => Promise<unknown>;
  createClient?: (options: OSS.Options & { retryMax: number }) => Client;
} = {}): VisualObjectStore {
  let config: OssConnectionConfig;
  try { config = parseOssConnectionConfig(input); } catch { throw unavailable(); }
  const resolve = dependencies.getCredential ?? createDefaultCredentialResolver();
  const createClient = dependencies.createClient ?? ((options) => new OSS(options));
  let clientPromise: Promise<Client> | undefined;
  const makeClient = async () => {
    const initial = credentialSchema.parse(await resolve());
    return createClient({
      accessKeyId: initial.accessKeyId,
      accessKeySecret: initial.accessKeySecret,
      ...(initial.securityToken ? {
        stsToken: initial.securityToken,
        refreshSTSToken: async () => {
          const refreshed = credentialSchema.extend({ securityToken: z.string().min(1) }).parse(await resolve());
          return { accessKeyId: refreshed.accessKeyId, accessKeySecret: refreshed.accessKeySecret, stsToken: refreshed.securityToken };
        },
      } : {}),
      ...config,
      secure: true,
      authorizationV4: true,
      retryMax: 0,
      timeout: UPLOAD_REQUEST_TIMEOUT_MS,
    });
  };
  const withClient = async <T>(operation: (client: Client) => Promise<T>) => {
    const attempt = (clientPromise ??= makeClient());
    try { return await operation(await attempt); }
    catch {
      // An invalid credential, failed creation or failed SDK request must not poison reuse.
      if (clientPromise === attempt) clientPromise = undefined;
      throw unavailable();
    }
  };

  return {
    async put({ key, bytes, contentType }) {
      try {
        const parts = parseVisualObjectKey(key);
        if (contentType !== contentTypes[parts.extension] || !(bytes instanceof Uint8Array) || bytes.length === 0) throw unavailable();
        await withClient(async (client) => { await client.put(key, Buffer.from(bytes), { mime: contentType }); });
      } catch { throw unavailable(); }
    },
    async get(key) {
      try {
        const parts = parseVisualObjectKey(key);
        return await withClient(async (client) => {
          const result = await client.get(key);
          const header = Object.entries(result.res.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];
          if (!(result.content instanceof Uint8Array) || header !== contentTypes[parts.extension]) throw unavailable();
          return { bytes: Uint8Array.from(result.content), contentType: header };
        });
      } catch { throw unavailable(); }
    },
    async delete(keys) {
      try {
        keys.forEach(parseVisualObjectKey);
        if (keys.length === 0) return;
        await withClient(async (client) => {
          for (let start = 0; start < keys.length; start += OSS_DELETE_BATCH_SIZE) {
            await client.deleteMulti(keys.slice(start, start + OSS_DELETE_BATCH_SIZE), { quiet: true });
          }
        });
      } catch { throw unavailable(); }
    },
  };
}
