import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sourceObjectKey } from "@/features/storage/object-keys";

import { FakeCredentialIssuer, FakeOssAdapter } from "./fake-oss";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const patternId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = sourceObjectKey({
  ownerId,
  patternId,
  assetId: randomUUID(),
  extension: "psd",
});
const anotherKey = sourceObjectKey({
  ownerId,
  patternId,
  assetId: randomUUID(),
  extension: "png",
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

  it("rejects noncanonical keys for every fake operation", async () => {
    const fake = new FakeOssAdapter();
    const uppercaseKey = key.replace(ownerId, ownerId.toUpperCase());

    expect(() => fake.putObject(uppercaseKey, Uint8Array.from([1]))).toThrow(
      /object key/i,
    );
    await expect(fake.headObject(uppercaseKey)).rejects.toThrow(/object key/i);
    await expect(fake.readRange(uppercaseKey, 0, 0)).rejects.toThrow(
      /object key/i,
    );
    await expect(fake.deleteObjects([uppercaseKey])).rejects.toThrow(
      /object key/i,
    );
    await expect(
      fake.createSignedGet({
        key: uppercaseKey,
        filename: "safe.psd",
        expiresSeconds: 60,
      }),
    ).rejects.toThrow(/object key/i);
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

  it("validates every delete key before mutating fake storage", async () => {
    const fake = new FakeOssAdapter();
    fake.putObject(key, Uint8Array.from([1]));
    fake.putObject(anotherKey, Uint8Array.from([2]));

    await expect(
      fake.deleteObjects([key, "not/a/canonical/key", anotherKey]),
    ).rejects.toThrow(/object key/i);

    expect(fake.objects.has(key)).toBe(true);
    expect(fake.objects.has(anotherKey)).toBe(true);
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

  it.each([
    "bad\r\nname.psd",
    "bad\u0001name.psd",
    "folder/name.psd",
    "folder\\name.psd",
  ])("rejects unsafe signed GET filename %j", async (filename) => {
    const fake = new FakeOssAdapter();
    fake.putObject(key, Uint8Array.from([1]));

    await expect(
      fake.createSignedGet({ key, filename, expiresSeconds: 60 }),
    ).rejects.toThrow(/filename/i);
    expect(fake.signedGets).toHaveLength(0);
  });

  it.each([
    ["Kid's Pattern.psd", "Kid%27s+Pattern.psd"],
    ['"Bloom".ai', "%22Bloom%22.ai"],
  ])(
    "accepts and URL-encodes quoted filename %j",
    async (filename, encodedFilename) => {
      const fake = new FakeOssAdapter();
      fake.putObject(key, Uint8Array.from([1]));

      const signedUrl = await fake.createSignedGet({
        key,
        filename,
        expiresSeconds: 60,
      });

      expect(signedUrl).toContain(`filename=${encodedFilename}`);
      expect(signedUrl).not.toMatch(/["']/);
      expect(signedUrl).not.toMatch(/[\r\n]/);
      expect(new URL(signedUrl).searchParams.get("filename")).toBe(filename);
    },
  );

  it.each([0, 3_601])("rejects signed GET expiry %i", async (expiresSeconds) => {
    const fake = new FakeOssAdapter();
    fake.putObject(key, Uint8Array.from([1]));

    await expect(
      fake.createSignedGet({
        key,
        filename: "safe.psd",
        expiresSeconds,
      }),
    ).rejects.toThrow();
    expect(fake.signedGets).toHaveLength(0);
  });

  it.each([1, 3_600])("accepts signed GET expiry boundary %i", async (expiresSeconds) => {
    const fake = new FakeOssAdapter();
    fake.putObject(key, Uint8Array.from([1]));

    await expect(
      fake.createSignedGet({
        key,
        filename: "safe.psd",
        expiresSeconds,
      }),
    ).resolves.toContain(`expires=${expiresSeconds}`);
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
    await expect(
      fake.issue({
        ownerId: ownerId.toUpperCase(),
        patternId: patternId.toUpperCase(),
      }),
    ).resolves.toMatchObject({
      accessKeyId: "STS.fake-1",
    });
    expect(fake.issues).toEqual([{ ownerId, patternId }]);
  });
});
