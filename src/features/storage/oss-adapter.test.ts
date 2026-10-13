import { randomUUID } from "node:crypto";

import OSS from "ali-oss";
import { describe, expect, it, vi } from "vitest";

import { patternObjectPrefix, sourceObjectKey } from "./object-keys";
import {
  createAlibabaOssAdapter,
  createDefaultCredentialResolver,
} from "./oss-adapter";

const key = sourceObjectKey({
  ownerId: randomUUID(),
  patternId: randomUUID(),
  assetId: randomUUID(),
  extension: "png",
});

const config = {
  region: "oss-cn-hangzhou",
  bucket: "melon-test-assets",
  endpoint: "https://assets.example.test",
  cname: true,
};

const freshCredential = {
  accessKeyId: "STS.fresh-access-key",
  accessKeySecret: "fresh-access-secret",
  securityToken: "fresh-security-token",
};

function createObjectKeys(count: number) {
  return Array.from({ length: count }, () =>
    sourceObjectKey({
      ownerId: randomUUID(),
      patternId: randomUUID(),
      assetId: randomUUID(),
      extension: "png",
    }),
  );
}

function createSdk() {
  return {
    head: vi.fn().mockResolvedValue({
      res: {
        headers: {
          "content-length": "4",
          "content-type": "image/png",
        },
      },
    }),
    get: vi.fn().mockResolvedValue({
      content: Buffer.from([10, 20, 30, 40]),
    }),
    deleteMulti: vi.fn().mockResolvedValue({ deleted: [key] }),
    listV2: vi.fn().mockResolvedValue({
      objects: [],
      isTruncated: false,
      nextContinuationToken: "",
    }),
    signatureUrl: vi
      .fn()
      .mockReturnValue("https://assets.example.test/legacy-signed-object"),
    signatureUrlV4: vi
      .fn()
      .mockResolvedValue("https://assets.example.test/signed-object"),
  };
}

describe("createAlibabaOssAdapter", () => {
  it("lazily creates one explicitly configured SDK client", async () => {
    const sdk = createSdk();
    const createClient = vi.fn().mockResolvedValue(sdk);
    const adapter = createAlibabaOssAdapter(config, { createClient });

    expect(createClient).not.toHaveBeenCalled();

    await expect(adapter.headObject(key)).resolves.toEqual({
      sizeBytes: 4,
      contentType: "image/png",
    });
    await adapter.readRange(key, 1, 2);

    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(config);
  });

  it.each([
    "not-a-url",
    "http://assets.example.test",
    "https://@assets.example.test",
    "https://:@assets.example.test",
    "https://user:secret@assets.example.test",
    "https://assets.example.test/objects",
    "https://assets.example.test/a/..",
    "https://assets.example.test/%2e",
    "https://assets.example.test?",
    "https://assets.example.test?mode=unsafe",
    "https://assets.example.test#",
    "https://assets.example.test#fragment",
    "https://[::1]",
    "https://[2001:db8::1]:8443",
    "https://assets.example.test:0",
    "https://assets.example.test:65536",
  ])("rejects non-origin real OSS endpoint %s before client creation", (endpoint) => {
    const createClient = vi.fn();

    expect(() =>
      createAlibabaOssAdapter({ ...config, endpoint }, { createClient }),
    ).toThrow(/HTTPS origin/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("accepts an HTTPS origin with an explicit port", async () => {
    const sdk = createSdk();
    const createClient = vi.fn().mockResolvedValue(sdk);
    const adapter = createAlibabaOssAdapter(
      { ...config, endpoint: "https://assets.example.test:8443" },
      { createClient },
    );

    await adapter.headObject(key);

    expect(createClient).toHaveBeenCalledWith({
      ...config,
      endpoint: "https://assets.example.test:8443",
    });
  });

  it("allows a later operation to retry transient client initialization", async () => {
    const sdk = createSdk();
    const createClient = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary credential failure"))
      .mockResolvedValueOnce(sdk);
    const adapter = createAlibabaOssAdapter(config, { createClient });

    await expect(adapter.headObject(key)).rejects.toThrow(
      "temporary credential failure",
    );
    await expect(adapter.headObject(key)).resolves.toEqual({
      sizeBytes: 4,
      contentType: "image/png",
    });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the default credential provider after its full chain fails", async () => {
    const events: string[] = [];
    const createCredentialProvider = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("factory:first");
        return {
          async getCredential() {
            events.push("first:primary");
            events.push("first:fallback");
            throw new Error("credential chain exhausted");
          },
        };
      })
      .mockImplementationOnce(() => {
        events.push("factory:second");
        return {
          async getCredential() {
            events.push("second:primary");
            return freshCredential;
          },
        };
      });
    const resolveCredential = createDefaultCredentialResolver(
      createCredentialProvider,
    );

    await expect(resolveCredential()).rejects.toThrow(
      "credential chain exhausted",
    );
    await expect(resolveCredential()).resolves.toEqual(freshCredential);
    await expect(resolveCredential()).resolves.toEqual(freshCredential);

    expect(createCredentialProvider).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "factory:first",
      "first:primary",
      "first:fallback",
      "factory:second",
      "second:primary",
      "second:primary",
    ]);
  });

  it("shares concurrent credential initialization and caches a successful provider", async () => {
    let resolveFirst!: (credential: typeof freshCredential) => void;
    const firstCredential = new Promise<typeof freshCredential>((resolve) => {
      resolveFirst = resolve;
    });
    const getCredential = vi
      .fn()
      .mockImplementationOnce(() => firstCredential)
      .mockResolvedValue(freshCredential);
    const createCredentialProvider = vi.fn(() => ({ getCredential }));
    const resolveCredential = createDefaultCredentialResolver(
      createCredentialProvider,
    );
    const first = resolveCredential();
    const concurrent = resolveCredential();
    await Promise.resolve();

    expect(createCredentialProvider).toHaveBeenCalledOnce();
    expect(getCredential).toHaveBeenCalledOnce();
    resolveFirst(freshCredential);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      freshCredential,
      freshCredential,
    ]);

    await expect(resolveCredential()).resolves.toEqual(freshCredential);
    expect(createCredentialProvider).toHaveBeenCalledOnce();
    expect(getCredential).toHaveBeenCalledTimes(2);
  });

  it("performs an inclusive HTTP range read and returns an isolated byte view", async () => {
    const sdk = createSdk();
    const content = Buffer.from([10, 20, 30, 40]);
    sdk.get.mockResolvedValueOnce({ content });
    const adapter = createAlibabaOssAdapter(config, {
      createClient: async () => sdk,
    });

    const bytes = await adapter.readRange(key, 1, 2);

    expect(sdk.get).toHaveBeenCalledWith(key, {
      headers: { Range: "bytes=1-2" },
    });
    expect(bytes).toEqual(Uint8Array.from([10, 20, 30, 40]));
    content[0] = 99;
    expect(bytes[0]).toBe(10);
  });

  it("validates ranges before any SDK or credential work", async () => {
    const createClient = vi.fn();
    const adapter = createAlibabaOssAdapter(config, { createClient });

    await expect(adapter.readRange(key, 4, 3)).rejects.toThrow(/range/i);
    await expect(adapter.readRange(key, -1, 3)).rejects.toThrow(/range/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("deletes canonical keys in one quiet request and treats an empty set as a no-op", async () => {
    const sdk = createSdk();
    const adapter = createAlibabaOssAdapter(config, {
      createClient: async () => sdk,
    });

    await adapter.deleteObjects([]);
    expect(sdk.deleteMulti).not.toHaveBeenCalled();

    await adapter.deleteObjects([key]);
    expect(sdk.deleteMulti).toHaveBeenCalledWith([key], { quiet: true });
  });

  it("lists every object under a canonical pattern prefix with V2 pagination", async () => {
    const sdk = createSdk();
    const prefix = patternObjectPrefix({
      ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      patternId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const first = `${prefix}source/uncommitted-one.tmp`;
    const second = `${prefix}derived/uncommitted-two.tmp`;
    sdk.listV2
      .mockResolvedValueOnce({
        objects: [{ name: first }],
        isTruncated: true,
        nextContinuationToken: "next-page",
      })
      .mockResolvedValueOnce({
        objects: [{ name: second }],
        isTruncated: false,
        nextContinuationToken: "",
      });
    const adapter = createAlibabaOssAdapter(config, {
      createClient: async () => sdk,
    });

    await expect(adapter.listObjectKeys(prefix)).resolves.toEqual([
      first,
      second,
    ]);
    expect(sdk.listV2).toHaveBeenNthCalledWith(1, {
      prefix,
      "max-keys": 1_000,
    });
    expect(sdk.listV2).toHaveBeenNthCalledWith(2, {
      prefix,
      "max-keys": 1_000,
      "continuation-token": "next-page",
    });
  });

  it("validates list prefixes and rejects an OSS response outside its scope", async () => {
    const sdk = createSdk();
    const createClient = vi.fn().mockResolvedValue(sdk);
    const adapter = createAlibabaOssAdapter(config, { createClient });

    await expect(adapter.listObjectKeys("users/not-a-prefix/")).rejects.toThrow(
      /prefix/i,
    );
    expect(createClient).not.toHaveBeenCalled();

    const prefix = patternObjectPrefix({
      ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      patternId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    sdk.listV2.mockResolvedValueOnce({
      objects: [{ name: `${prefix}../outside.tmp` }, { name: "foreign/key" }],
      isTruncated: false,
      nextContinuationToken: "",
    });
    await expect(adapter.listObjectKeys(prefix)).rejects.toThrow(/outside/i);
    expect(sdk.deleteMulti).not.toHaveBeenCalled();
  });

  it("deletes arbitrary listed keys only within their canonical pattern prefix", async () => {
    const sdk = createSdk();
    const adapter = createAlibabaOssAdapter(config, {
      createClient: async () => sdk,
    });
    const prefix = patternObjectPrefix({
      ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      patternId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const uncommitted = `${prefix}derived/uncommitted-preview.tmp`;

    await adapter.deleteObjectsUnderPrefix(prefix, [uncommitted]);
    expect(sdk.deleteMulti).toHaveBeenCalledWith([uncommitted], { quiet: true });
    await expect(
      adapter.deleteObjectsUnderPrefix(prefix, ["foreign/key"]),
    ).rejects.toThrow(/outside/i);
    expect(sdk.deleteMulti).toHaveBeenCalledOnce();
  });

  it("deletes 1001 prefix-scoped keys in OSS-sized batches", async () => {
    const sdk = createSdk();
    const adapter = createAlibabaOssAdapter(config, {
      createClient: async () => sdk,
    });
    const prefix = patternObjectPrefix({
      ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      patternId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const keys = Array.from(
      { length: 1_001 },
      (_, index) => `${prefix}uncommitted/${index}.tmp`,
    );

    await adapter.deleteObjectsUnderPrefix(prefix, keys);

    expect(sdk.deleteMulti.mock.calls.map(([batch]) => batch.length)).toEqual([
      1_000,
      1,
    ]);
    expect(sdk.deleteMulti.mock.calls.flatMap(([batch]) => batch)).toEqual(
      keys,
    );
  });

  it.each([
    [1_001, [1_000, 1]],
    [2_001, [1_000, 1_000, 1]],
  ] as const)(
    "deletes %i canonical keys in batches of at most 1000",
    async (count, batchSizes) => {
      const sdk = createSdk();
      const keys = createObjectKeys(count);
      const adapter = createAlibabaOssAdapter(config, {
        createClient: async () => sdk,
      });

      await adapter.deleteObjects(keys);

      expect(sdk.deleteMulti).toHaveBeenCalledTimes(batchSizes.length);
      expect(
        sdk.deleteMulti.mock.calls.map(([batch]) => batch.length),
      ).toEqual(batchSizes);
      expect(sdk.deleteMulti.mock.calls.flatMap(([batch]) => batch)).toEqual(
        keys,
      );
    },
  );

  it("validates every delete key before deleting any earlier batch", async () => {
    const sdk = createSdk();
    const createClient = vi.fn().mockResolvedValue(sdk);
    const adapter = createAlibabaOssAdapter(config, { createClient });
    const keys = [...createObjectKeys(1_001), "not/a/canonical/key"];

    await expect(adapter.deleteObjects(keys)).rejects.toThrow(/object key/i);

    expect(createClient).not.toHaveBeenCalled();
    expect(sdk.deleteMulti).not.toHaveBeenCalled();
  });

  it("surfaces a later delete failure and safely retries the full idempotent list", async () => {
    const sdk = createSdk();
    const keys = createObjectKeys(1_001);
    const deleted = new Set<string>();
    let failSecondBatch = true;
    sdk.deleteMulti.mockImplementation(async (batch) => {
      if (batch.length === 1 && failSecondBatch) {
        failSecondBatch = false;
        throw new Error("second delete batch failed");
      }
      batch.forEach((item: string) => deleted.add(item));
      return { deleted: batch };
    });
    const adapter = createAlibabaOssAdapter(config, {
      createClient: async () => sdk,
    });

    await expect(adapter.deleteObjects(keys)).rejects.toThrow(
      "second delete batch failed",
    );
    expect(deleted.size).toBe(1_000);
    expect(deleted.has(keys[1_000]!)).toBe(false);

    await expect(adapter.deleteObjects(keys)).resolves.toBeUndefined();
    expect(deleted.size).toBe(1_001);
    expect(sdk.deleteMulti.mock.calls.map(([batch]) => batch.length)).toEqual([
      1_000,
      1,
      1_000,
      1,
    ]);
  });

  it("creates a short signed GET with an encoded download disposition", async () => {
    const sdk = createSdk();
    const getCredential = vi.fn().mockResolvedValue(freshCredential);
    const createSignerClient = vi.fn().mockReturnValue(sdk);
    const adapter = createAlibabaOssAdapter(config, {
      createClient: async () => sdk,
      getCredential,
      createSignerClient,
    });

    await expect(
      adapter.createSignedGet({
        key,
        filename: "leaf study.png",
        expiresSeconds: 300,
      }),
    ).resolves.toBe("https://assets.example.test/signed-object");
    expect(sdk.signatureUrlV4).toHaveBeenCalledWith(
      "GET",
      300,
      {
        queries: {
          "response-content-disposition":
            "attachment; filename*=UTF-8''leaf%20study.png",
        },
      },
      key,
    );
    expect(sdk.signatureUrl).not.toHaveBeenCalled();
    expect(getCredential).toHaveBeenCalledOnce();
    expect(createSignerClient).toHaveBeenCalledWith(config, freshCredential);
  });

  it("signs with one fresh credential snapshot using the real ali-oss SDK", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T10:00:00.000Z"));

    try {
      const oldCredential = {
        accessKeyId: "STS.old-access-key",
        accessKeySecret: "old-access-secret",
        securityToken: "old-security-token",
      };
      const staleClient = new OSS({
        accessKeyId: oldCredential.accessKeyId,
        accessKeySecret: oldCredential.accessKeySecret,
        stsToken: oldCredential.securityToken,
        refreshSTSTokenInterval: 1,
        refreshSTSToken: async () => ({
          accessKeyId: freshCredential.accessKeyId,
          accessKeySecret: freshCredential.accessKeySecret,
          stsToken: freshCredential.securityToken,
        }),
        ...config,
        secure: true,
        authorizationV4: true,
      });
      (
        staleClient as unknown as { stsTokenFreshTime: Date }
      ).stsTokenFreshTime = new Date(0);
      const createClient = vi.fn().mockResolvedValue(staleClient);
      const getCredential = vi.fn().mockResolvedValue(freshCredential);
      const adapter = createAlibabaOssAdapter(config, {
        createClient,
        getCredential,
      });
      const request = {
        queries: {
          "response-content-disposition":
            "attachment; filename*=UTF-8''leaf%20study.png",
        },
      };

      const actualUrl = new URL(
        await adapter.createSignedGet({
          key,
          filename: "leaf study.png",
          expiresSeconds: 300,
        }),
      );
      const expectedSigner = new OSS({
        accessKeyId: freshCredential.accessKeyId,
        accessKeySecret: freshCredential.accessKeySecret,
        stsToken: freshCredential.securityToken,
        refreshSTSTokenInterval: 86_400_000,
        ...config,
        secure: true,
        authorizationV4: true,
      });
      const wrongSecretSigner = new OSS({
        accessKeyId: freshCredential.accessKeyId,
        accessKeySecret: oldCredential.accessKeySecret,
        stsToken: freshCredential.securityToken,
        refreshSTSTokenInterval: 86_400_000,
        ...config,
        secure: true,
        authorizationV4: true,
      });
      const expectedUrl = new URL(
        await expectedSigner.signatureUrlV4("GET", 300, request, key),
      );
      const wrongSecretUrl = new URL(
        await wrongSecretSigner.signatureUrlV4("GET", 300, request, key),
      );

      expect(actualUrl.searchParams.get("x-oss-credential")).toBe(
        expectedUrl.searchParams.get("x-oss-credential"),
      );
      expect(actualUrl.searchParams.get("x-oss-security-token")).toBe(
        freshCredential.securityToken,
      );
      expect(actualUrl.searchParams.get("x-oss-signature")).toBe(
        expectedUrl.searchParams.get("x-oss-signature"),
      );
      expect(actualUrl.searchParams.get("x-oss-signature")).not.toBe(
        wrongSecretUrl.searchParams.get("x-oss-signature"),
      );
      expect(getCredential).toHaveBeenCalledOnce();
      expect(createClient).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["Kid's Pattern.psd", "Kid%27s%20Pattern.psd", "Kid%2527s%2520Pattern.psd"],
    ['"Bloom".ai', "%22Bloom%22.ai", "%2522Bloom%2522.ai"],
  ])(
    "accepts and RFC 5987-encodes quoted filename %j",
    async (filename, encodedFilename, encodedUrlFilename) => {
      const adapter = createAlibabaOssAdapter(config, {
        getCredential: async () => freshCredential,
      });

      const signedUrl = await adapter.createSignedGet({
        key,
        filename,
        expiresSeconds: 60,
      });
      const disposition = new URL(signedUrl).searchParams.get(
        "response-content-disposition",
      );

      expect(disposition).toBe(
        `attachment; filename*=UTF-8''${encodedFilename}`,
      );
      expect(signedUrl).toContain(encodedUrlFilename);
      expect(signedUrl).not.toContain(filename);
      expect(signedUrl).not.toMatch(/[\r\n]/);
    },
  );

  it("rejects malformed keys and header injection before signing", async () => {
    const sdk = createSdk();
    const createClient = vi.fn().mockResolvedValue(sdk);
    const adapter = createAlibabaOssAdapter(config, { createClient });

    await expect(
      adapter.createSignedGet({
        key: "outside/the/canonical/prefix",
        filename: "safe.png",
        expiresSeconds: 60,
      }),
    ).rejects.toThrow(/object key/i);
    await expect(
      adapter.createSignedGet({
        key,
        filename: "bad\r\nname.png",
        expiresSeconds: 60,
      }),
    ).rejects.toThrow(/filename/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    "bad\u0001name.png",
    "folder/name.png",
    "folder\\name.png",
  ])("rejects unsafe signed GET filename %j", async (filename) => {
    const createClient = vi.fn();
    const getCredential = vi.fn();
    const createSignerClient = vi.fn();
    const adapter = createAlibabaOssAdapter(config, {
      createClient,
      getCredential,
      createSignerClient,
    });

    await expect(
      adapter.createSignedGet({ key, filename, expiresSeconds: 60 }),
    ).rejects.toThrow(/filename/i);
    expect(createClient).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    expect(createSignerClient).not.toHaveBeenCalled();
  });

  it.each([0, 3_601])(
    "rejects signed GET expiry %i before credential work",
    async (expiresSeconds) => {
      const createClient = vi.fn();
      const getCredential = vi.fn();
      const createSignerClient = vi.fn();
      const adapter = createAlibabaOssAdapter(config, {
        createClient,
        getCredential,
        createSignerClient,
      });

      await expect(
        adapter.createSignedGet({
          key,
          filename: "safe.png",
          expiresSeconds,
        }),
      ).rejects.toThrow();
      expect(createClient).not.toHaveBeenCalled();
      expect(getCredential).not.toHaveBeenCalled();
      expect(createSignerClient).not.toHaveBeenCalled();
    },
  );
});
