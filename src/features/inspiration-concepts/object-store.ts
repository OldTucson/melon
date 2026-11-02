import "server-only";

import OSS from "ali-oss";
import { z } from "zod";
import type { OssConnectionConfig } from "@/features/storage/contracts";
import { createDefaultCredentialResolver } from "@/features/storage/oss-adapter";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "@/features/storage/upload-timing";
import { OSS_DELETE_BATCH_SIZE, parseOssConnectionConfig } from "@/features/storage/validation";
import { parseVisualObjectKey } from "@/features/inspiration-visuals/visual-object-keys";
import { assertConceptSetObjectPrefix, parseConceptObjectKey } from "./object-keys";

export interface ConceptObjectStore {
  put(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  delete(keys: readonly string[]): Promise<void>;
  listObjectKeys(prefix: string): Promise<string[]>;
}
export interface ConceptCleanupStore {
  listObjects(prefix: string): Promise<{ key: string; lastModified: Date }[]>;
  delete(keys: readonly string[]): Promise<void>;
  researchObjectLastModified(key: string): Promise<Date | null>;
  deleteResearchObjects(keys: readonly string[]): Promise<void>;
}
const credentialSchema = z.object({ accessKeyId: z.string().min(1), accessKeySecret: z.string().min(1), securityToken: z.string().min(1).optional() });
// ali-oss 6.x returns raw XML Deleted entries; its string[] declaration is stale.
const deleteResultSchema = z.object({ deleted: z.array(z.object({ Key: z.string() })) });
type Client = Pick<OSS, "put" | "get" | "deleteMulti" | "listV2"> & Partial<Pick<OSS, "head">>;
const unavailable = () => new Error("Concept object unavailable");

/** Shared private client; each operation validates its own strict namespace. */
function createScopedConceptStore(input: OssConnectionConfig, dependencies: {
  getCredential?: () => Promise<unknown>;
  createClient?: (options: OSS.Options & { retryMax: number }) => Client;
} = {}): ConceptObjectStore & ConceptCleanupStore {
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
  const deleteValidated = async (keys: readonly string[], validate: (key: string) => unknown) => {
    try {
      keys.forEach(validate);
      if (!keys.length) return;
      await withClient(async (client) => {
        for (let offset = 0; offset < keys.length; offset += OSS_DELETE_BATCH_SIZE) {
          const batch = keys.slice(offset, offset + OSS_DELETE_BATCH_SIZE);
          const result = deleteResultSchema.parse(await client.deleteMulti(batch, { quiet: false }));
          const remaining = new Set(batch);
          for (const { Key } of result.deleted) if (!remaining.delete(Key)) throw unavailable();
          if (remaining.size) throw unavailable();
        }
      });
    } catch { throw unavailable(); }
  };
  return {
    async researchObjectLastModified(key) {
      try {
        parseVisualObjectKey(key);
        return await withClient(async (client) => {
          try {
            if (!client.head) throw unavailable();
            const result = await client.head(key);
            const header = Object.entries(result.res.headers).find(([name]) => name.toLowerCase() === "last-modified")?.[1];
            if (typeof header !== "string") throw unavailable();
            const date = new Date(header);
            if (!Number.isFinite(date.getTime())) throw unavailable();
            return date;
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "NoSuchKey") return null;
            throw unavailable();
          }
        });
      } catch { throw unavailable(); }
    },
    deleteResearchObjects: (keys) => deleteValidated(keys, parseVisualObjectKey),
    async listObjects(inputPrefix) {
      try {
        const prefix = assertConceptSetObjectPrefix(inputPrefix);
        return await withClient(async (client) => {
          const objects: { key: string; lastModified: Date }[] = [];
          const keys = new Set<string>(), tokens = new Set<string>();
          let token: string | undefined;
          for (let page = 0; page < 10; page++) {
            const result = await client.listV2({ prefix, "max-keys": 1000, ...(token ? { "continuation-token": token } : {}) });
            if (!Array.isArray(result.objects) || result.objects.length > 1000 || typeof result.isTruncated !== "boolean") throw unavailable();
            for (const object of result.objects) {
              parseConceptObjectKey(object.name);
              if (!object.name.startsWith(prefix) || keys.has(object.name) || typeof object.lastModified !== "string") throw unavailable();
              const lastModified = new Date(object.lastModified);
              if (!Number.isFinite(lastModified.getTime())) throw unavailable();
              keys.add(object.name); objects.push({ key: object.name, lastModified });
            }
            if (!result.isTruncated) return objects;
            const next = result.nextContinuationToken;
            if (typeof next !== "string" || !next.length || tokens.has(next)) throw unavailable();
            tokens.add(next); token = next;
          }
          throw unavailable();
        });
      } catch { throw unavailable(); }
    },
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
    delete: (keys) => deleteValidated(keys, parseConceptObjectKey),
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

export function createConceptObjectStore(...args: Parameters<typeof createScopedConceptStore>): ConceptObjectStore {
  return createScopedConceptStore(...args);
}
export function createConceptCleanupStore(...args: Parameters<typeof createScopedConceptStore>): ConceptCleanupStore {
  return createScopedConceptStore(...args);
}
