import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_REQUEST_TIMEOUT_MS } from "./upload-timing";

const oss = vi.hoisted(() => ({
  client: {
    head: vi.fn().mockResolvedValue({
      res: {
        headers: {
          "content-length": "4",
          "content-type": "image/png",
        },
      },
    }),
  },
  constructor: vi.fn(),
}));

vi.mock("ali-oss", () => ({
  default: function MockOssClient(options: unknown) {
    oss.constructor(options);
    return oss.client;
  },
}));

import { sourceObjectKey } from "./object-keys";
import { createAlibabaOssAdapter } from "./oss-adapter";

const config = {
  region: "oss-cn-hangzhou",
  bucket: "melon-test-assets",
  endpoint: "https://assets.example.test",
  cname: true,
};

const credentials = {
  accessKeyId: "STS.test-access-key",
  accessKeySecret: "temporary-secret",
  securityToken: "temporary-token",
};

beforeEach(() => {
  oss.constructor.mockClear();
  oss.client.head.mockClear();
});

describe("default Alibaba OSS client", () => {
  it("pins one request timeout window and disables SDK retries", async () => {
    const adapter = createAlibabaOssAdapter(config, {
      getCredential: async () => credentials,
    });
    const key = sourceObjectKey({
      ownerId: randomUUID(),
      patternId: randomUUID(),
      assetId: randomUUID(),
      extension: "png",
    });

    await adapter.headObject(key);

    expect(oss.constructor).toHaveBeenCalledOnce();
    expect(oss.constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        retryMax: 0,
        timeout: UPLOAD_REQUEST_TIMEOUT_MS,
      }),
    );
  });
});
