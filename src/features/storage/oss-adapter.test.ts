import { randomUUID } from "node:crypto";

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

  it("rejects an insecure real OSS endpoint before client creation", () => {
    const createClient = vi.fn();

    expect(() =>
      createAlibabaOssAdapter(
        { ...config, endpoint: "http://assets.example.test" },
        { createClient },
      ),
    ).toThrow();
    expect(createClient).not.toHaveBeenCalled();
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

  it("creates a short signed GET with an encoded download disposition", async () => {
    const sdk = createSdk();
    const adapter = createAlibabaOssAdapter(config, {
      createClient: async () => sdk,
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
});
