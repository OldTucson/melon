import { z } from "zod";

import type {
  BrowserCredentialIssuer,
  BrowserOssCredentials,
  OssAdapter,
} from "@/features/storage/contracts";

const issueInputSchema = z.object({
  ownerId: z.string().uuid(),
  patternId: z.string().uuid(),
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
  readonly signedGets: Array<{
    key: string;
    filename: string;
    expiresSeconds: number;
  }> = [];
  private readonly contentTypes = new Map<string, string>();

  putObject(
    key: string,
    bytes: Uint8Array,
    contentType = "application/octet-stream",
  ) {
    this.objects.set(key, Uint8Array.from(bytes));
    this.contentTypes.set(key, contentType);
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
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endInclusive) ||
      start < 0 ||
      endInclusive < start
    ) {
      throw new Error("OSS_RANGE_INVALID");
    }

    const value = this.require(key);
    if (start >= value.byteLength) {
      throw new Error("OSS_RANGE_NOT_SATISFIABLE");
    }
    return value.slice(start, endInclusive + 1);
  }

  async deleteObjects(keys: string[]) {
    for (const key of keys) {
      this.objects.delete(key);
      this.contentTypes.delete(key);
    }
  }

  async createSignedGet(input: {
    key: string;
    filename: string;
    expiresSeconds: number;
  }) {
    this.require(input.key);
    this.signedGets.push({ ...input });
    const query = new URLSearchParams({
      filename: input.filename,
      expires: String(input.expiresSeconds),
    });
    return `http://127.0.0.1/fake-oss/${encodeURIComponent(input.key)}?${query.toString()}`;
  }

  reset() {
    this.objects.clear();
    this.contentTypes.clear();
    this.signedGets.splice(0);
  }

  private require(key: string) {
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
