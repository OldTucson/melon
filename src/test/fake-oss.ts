import { z } from "zod";

import type {
  BrowserCredentialIssuer,
  BrowserOssCredentials,
  OssAdapter,
} from "@/features/storage/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import {
  assertCanonicalPatternPrefix,
  assertObjectKeyWithinPatternPrefix,
} from "@/features/storage/object-keys";
import {
  assertCanonicalObjectKey,
  assertValidObjectRange,
  OSS_DELETE_BATCH_SIZE,
  parseDeleteObjectKeys,
  parseSignedGetInput,
} from "@/features/storage/validation";

const issueInputSchema = z.object({
  ownerId: normalizedUuidSchema,
  patternId: normalizedUuidSchema,
});

type FakeCredentialIssuerOptions = Partial<
  Pick<
    BrowserOssCredentials,
    "region" | "bucket" | "endpoint" | "cname"
  >
> & {
  now?: () => Date;
};

export class FakeOssAdapter implements OssAdapter {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleteCalls: string[][] = [];
  readonly signedGets: Array<{
    key: string;
    filename: string;
    expiresSeconds: number;
  }> = [];
  failDeleteCall: number | null = null;
  private readonly contentTypes = new Map<string, string>();

  putObject(
    key: string,
    bytes: Uint8Array,
    contentType = "application/octet-stream",
  ) {
    const canonicalKey = assertCanonicalObjectKey(key);
    this.objects.set(canonicalKey, Uint8Array.from(bytes));
    this.contentTypes.set(canonicalKey, contentType);
  }

  async listObjectKeys(prefix: string) {
    const canonicalPrefix = assertCanonicalPatternPrefix(prefix);
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(canonicalPrefix))
      .sort();
  }

  async headObject(key: string) {
    const value = this.require(key);
    return {
      sizeBytes: value.byteLength,
      contentType:
        this.contentTypes.get(key) ?? "application/octet-stream",
    };
  }

  async readRange(key: string, start: number, endInclusive: number) {
    const canonicalKey = assertCanonicalObjectKey(key);
    assertValidObjectRange(start, endInclusive);

    const value = this.requireCanonical(canonicalKey);
    if (start >= value.byteLength) {
      throw new Error("OSS_RANGE_NOT_SATISFIABLE");
    }
    return value.slice(start, endInclusive + 1);
  }

  async deleteObjects(keys: string[]) {
    const parsedKeys = parseDeleteObjectKeys(keys);

    for (
      let start = 0;
      start < parsedKeys.length;
      start += OSS_DELETE_BATCH_SIZE
    ) {
      const batch = parsedKeys.slice(start, start + OSS_DELETE_BATCH_SIZE);
      this.deleteCalls.push(batch);
      if (this.failDeleteCall === this.deleteCalls.length) {
        throw new Error("OSS_DELETE_FAILED");
      }
      for (const key of batch) {
        this.objects.delete(key);
        this.contentTypes.delete(key);
      }
    }
  }

  async deleteObjectsUnderPrefix(prefix: string, keys: string[]) {
    const canonicalPrefix = assertCanonicalPatternPrefix(prefix);
    const parsedKeys = keys.map((key) =>
      assertObjectKeyWithinPatternPrefix(canonicalPrefix, key),
    );

    for (
      let start = 0;
      start < parsedKeys.length;
      start += OSS_DELETE_BATCH_SIZE
    ) {
      const batch = parsedKeys.slice(start, start + OSS_DELETE_BATCH_SIZE);
      this.deleteCalls.push(batch);
      if (this.failDeleteCall === this.deleteCalls.length) {
        throw new Error("OSS_DELETE_FAILED");
      }
      for (const key of batch) {
        this.objects.delete(key);
        this.contentTypes.delete(key);
      }
    }
  }

  async createSignedGet(input: {
    key: string;
    filename: string;
    expiresSeconds: number;
  }) {
    const parsed = parseSignedGetInput(input);
    this.requireCanonical(parsed.key);
    this.signedGets.push(parsed);
    const query = new URLSearchParams({
      filename: parsed.filename,
      expires: String(parsed.expiresSeconds),
    });
    return `http://127.0.0.1/fake-oss/${encodeURIComponent(parsed.key)}?${query.toString()}`;
  }

  reset() {
    this.objects.clear();
    this.contentTypes.clear();
    this.deleteCalls.splice(0);
    this.signedGets.splice(0);
    this.failDeleteCall = null;
  }

  private require(key: string) {
    return this.requireCanonical(assertCanonicalObjectKey(key));
  }

  private requireCanonical(key: string) {
    const value = this.objects.get(key);
    if (!value) throw new Error("OSS_OBJECT_NOT_FOUND");
    return value;
  }
}

export class FakeCredentialIssuer implements BrowserCredentialIssuer {
  readonly issues: Array<{ ownerId: string; patternId: string }> = [];
  private readonly config: Required<
    Pick<
      BrowserOssCredentials,
      "region" | "bucket" | "endpoint" | "cname"
    >
  >;
  private readonly now: () => Date;
  private sequence = 0;

  constructor(options: FakeCredentialIssuerOptions = {}) {
    this.config = {
      region: options.region ?? "oss-cn-hangzhou",
      bucket: options.bucket ?? "melon-test-assets",
      endpoint: options.endpoint ?? "http://127.0.0.1/fake-oss",
      cname: options.cname ?? false,
    };
    this.now = options.now ?? (() => new Date());
  }

  async issue(input: { ownerId: string; patternId: string }) {
    const parsed = issueInputSchema.parse(input);
    this.issues.push(parsed);
    this.sequence += 1;

    return {
      accessKeyId: `STS.fake-${this.sequence}`,
      accessKeySecret: `fake-temporary-secret-${this.sequence}`,
      securityToken: `fake-security-token-${this.sequence}`,
      expiration: new Date(
        this.now().getTime() + 15 * 60 * 1000,
      ).toISOString(),
      ...this.config,
    };
  }

  reset() {
    this.issues.splice(0);
    this.sequence = 0;
  }
}
