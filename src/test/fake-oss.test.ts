import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sourceObjectKey } from "@/features/storage/object-keys";

import { FakeCredentialIssuer, FakeOssAdapter } from "./fake-oss";

const ownerId = randomUUID();
const patternId = randomUUID();
const key = sourceObjectKey({
  ownerId,
  patternId,
  assetId: randomUUID(),
  extension: "psd",
});

describe("FakeOssAdapter", () => {
  it("stores copies, reports metadata, and reads inclusive ranges", async () => {
    const fake = new FakeOssAdapter();
    const source = Uint8Array.from([1, 2, 3, 4]);

    fake.putObject(key, source, "image/vnd.adobe.photoshop");
    source[0] = 99;

    await expect(fake.headObject(key)).resolves.toEqual({
      sizeBytes: 4,
      contentType: "image/vnd.adobe.photoshop",
    });
    await expect(fake.readRange(key, 1, 2)).resolves.toEqual(
      Uint8Array.from([2, 3]),
    );
  });

  it("requires an object for reads and signing", async () => {
    const fake = new FakeOssAdapter();

    await expect(fake.headObject(key)).rejects.toThrow("OSS_OBJECT_NOT_FOUND");
    await expect(
      fake.createSignedGet({ key, filename: "missing.psd", expiresSeconds: 60 }),
    ).rejects.toThrow("OSS_OBJECT_NOT_FOUND");
  });

  it("deletes objects and resets all observable state", async () => {
    const fake = new FakeOssAdapter();
    fake.putObject(key, Uint8Array.from([1]));
    await fake.createSignedGet({
      key,
      filename: "source.psd",
      expiresSeconds: 60,
    });

    await fake.deleteObjects([key]);
    expect(fake.objects.has(key)).toBe(false);
    expect(fake.signedGets).toHaveLength(1);

    fake.putObject(key, Uint8Array.from([1]));
    fake.reset();
    expect(fake.objects.size).toBe(0);
    expect(fake.signedGets).toHaveLength(0);
  });

  it("fails invalid or unsatisfiable range requests", async () => {
    const fake = new FakeOssAdapter();
    fake.putObject(key, Uint8Array.from([1, 2]));

    await expect(fake.readRange(key, 2, 3)).rejects.toThrow(
      "OSS_RANGE_NOT_SATISFIABLE",
    );
    await expect(fake.readRange(key, -1, 0)).rejects.toThrow(
      "OSS_RANGE_INVALID",
    );
  });
});

describe("FakeCredentialIssuer", () => {
  it("issues deterministic temporary credentials and resets its history", async () => {
    const fake = new FakeCredentialIssuer({
      now: () => new Date("2026-10-09T10:00:00Z"),
    });

    const credential = await fake.issue({ ownerId, patternId });

    expect(credential).toMatchObject({
      accessKeyId: "STS.fake-1",
      accessKeySecret: "fake-temporary-secret-1",
      securityToken: "fake-security-token-1",
      expiration: "2026-10-09T10:15:00.000Z",
    });
    expect(fake.issues).toEqual([{ ownerId, patternId }]);

    fake.reset();
    expect(fake.issues).toHaveLength(0);
    await expect(fake.issue({ ownerId, patternId })).resolves.toMatchObject({
      accessKeyId: "STS.fake-1",
    });
  });
});
