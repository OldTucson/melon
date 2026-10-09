import { randomUUID } from "node:crypto";

import OSS from "ali-oss";
import { describe, expect, it, vi } from "vitest";

import { sourceObjectKey } from "./object-keys";
import { createAlibabaOssAdapter } from "./oss-adapter";

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
    'bad"name.png',
    "bad'name.png",
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
