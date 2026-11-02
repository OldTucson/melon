import "server-only";

import OSS from "ali-oss";
import { z } from "zod";
import type { OssConnectionConfig } from "@/features/storage/contracts";
import { createDefaultCredentialResolver } from "@/features/storage/oss-adapter";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "@/features/storage/upload-timing";
import { OSS_DELETE_BATCH_SIZE, parseOssConnectionConfig } from "@/features/storage/validation";
import { assertConceptSetObjectPrefix, parseConceptObjectKey } from "./object-keys";

export interface ConceptObjectStore {
  put(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  delete(keys: readonly string[]): Promise<void>;
  listObjectKeys(prefix: string): Promise<string[]>;
}
const credentialSchema = z.object({ accessKeyId: z.string().min(1), accessKeySecret: z.string().min(1), securityToken: z.string().min(1).optional() });
type Client = Pick<OSS, "put" | "get" | "deleteMulti" | "listV2">;
const unavailable = () => new Error("Concept object unavailable");

/** Dedicated private concept namespace; never accepts pattern/research keys. */
export function createConceptObjectStore(input: OssConnectionConfig, dependencies: {
  getCredential?: () => Promise<unknown>;
  createClient?: (options: OSS.Options & { retryMax: number }) => Client;
} = {}): ConceptObjectStore {
  let config: OssConnectionConfig;
  try { config = parseOssConnectionConfig(input); } catch { throw unavailable(); }
  const resolve = dependencies.getCredential ?? createDefaultCredentialResolver();
  const createClient = dependencies.createClient ?? ((options) => new OSS(options));
  let clientPromise: Promise<Client> | undefined;
  const makeClient = async () => {
    const initial = credentialSchema.parse(await resolve());
    return createClient({
      accessKeyId: initial.accessKeyId, accessKeySecret: initial.accessKeySecret,
      ...(initial.securityToken ? {
        stsToken: initial.securityToken,
        refreshSTSToken: async () => {
          try {
            const next = credentialSchema.extend({ securityToken: z.string().min(1) }).parse(await resolve());
            return { accessKeyId: next.accessKeyId, accessKeySecret: next.accessKeySecret, stsToken: next.securityToken };
          } catch { throw unavailable(); }
        },
      } : {}),
      ...config, secure: true, authorizationV4: true, retryMax: 0, timeout: UPLOAD_REQUEST_TIMEOUT_MS,
    });
  };
  const withClient = async <T>(operation: (client: Client) => Promise<T>) => {
    const attempt = (clientPromise ??= makeClient());
    try { return await operation(await attempt); }
    catch {
      if (clientPromise === attempt) clientPromise = undefined;
      throw unavailable();
    }
  };
  return {
    async put({ key, bytes, contentType }) {
      try {
        parseConceptObjectKey(key);
        if (contentType !== "image/png" || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16 * 1024 * 1024) throw unavailable();
        await withClient(async (client) => { await client.put(key, Buffer.from(bytes), { mime: contentType, headers: { "x-oss-object-acl": "private" } }); });
      } catch { throw unavailable(); }
    },
    async get(key) {
      try {
        parseConceptObjectKey(key);
        return await withClient(async (client) => {
          const result = await client.get(key);
          const mime = Object.entries(result.res.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];
          if (!(result.content instanceof Uint8Array) || !result.content.length || result.content.length > 16 * 1024 * 1024 || mime !== "image/png") throw unavailable();
          return { bytes: Uint8Array.from(result.content), contentType: mime };
        });
      } catch { throw unavailable(); }
    },
    async delete(keys) {
      try {
        keys.forEach(parseConceptObjectKey);
        if (!keys.length) return;
        await withClient(async (client) => {
          for (let offset = 0; offset < keys.length; offset += OSS_DELETE_BATCH_SIZE) {
            await client.deleteMulti(keys.slice(offset, offset + OSS_DELETE_BATCH_SIZE), { quiet: true });
          }
        });
      } catch { throw unavailable(); }
    },
    async listObjectKeys(inputPrefix) {
      try {
        const prefix = assertConceptSetObjectPrefix(inputPrefix);
        return await withClient(async (client) => {
          const keys: string[] = [];
          const tokens = new Set<string>();
          let token: string | undefined;
          do {
            const result = await client.listV2({ prefix, "max-keys": 1000, ...(token ? { "continuation-token": token } : {}) });
            if (!Array.isArray(result.objects) || typeof result.isTruncated !== "boolean") throw unavailable();
            for (const object of result.objects) {
              parseConceptObjectKey(object.name);
              if (!object.name.startsWith(prefix)) throw unavailable();
              keys.push(object.name);
            }
            if (!result.isTruncated) return keys;
            const next = result.nextContinuationToken;
            if (typeof next !== "string" || !next.length || tokens.has(next)) throw unavailable();
            tokens.add(next); token = next;
          } while (true);
        });
      } catch { throw unavailable(); }
    },
  };
}
