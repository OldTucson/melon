import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_UPLOAD_SIZE_BYTES,
  parseUploadComplete,
  parseUploadInit,
} from "./contracts";

const validInit = () => ({
  patternId: randomUUID(),
  sourceAssetId: randomUUID(),
  operationId: randomUUID(),
  originalFilename: "Watermelon Bloom.psd",
  extension: "psd",
  sizeBytes: 1024,
  lastModified: 1_760_000_000_000,
  contentHash: "a".repeat(64),
});

describe("upload request contracts", () => {
  it("normalizes UUIDs while retaining strict lowercase file declarations", () => {
    const input = validInit();
    expect(
      parseUploadInit({
        ...input,
        patternId: input.patternId.toUpperCase(),
        sourceAssetId: input.sourceAssetId.toUpperCase(),
        operationId: input.operationId.toUpperCase(),
      }),
    ).toEqual(input);
  });

  it("accepts the exact 200 MiB boundary", () => {
    expect(
      parseUploadInit({ ...validInit(), sizeBytes: MAX_UPLOAD_SIZE_BYTES }),
    ).toMatchObject({ sizeBytes: 209_715_200 });
  });

  it("maps an oversized declaration to its stable error code", () => {
    expect(() =>
      parseUploadInit({
        ...validInit(),
        sizeBytes: MAX_UPLOAD_SIZE_BYTES + 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_FILE_TOO_LARGE", status: 413 }),
    );
  });

  it.each(["gif", "PSD", ".psd", "psd/escape"])(
    "maps unsupported extension %j to its stable error code",
    (extension) => {
      expect(() => parseUploadInit({ ...validInit(), extension })).toThrowError(
        expect.objectContaining({
          code: "UPLOAD_EXTENSION_UNSUPPORTED",
          status: 415,
        }),
      );
    },
  );

  it.each([
    "../secret.psd",
    "folder/secret.psd",
    "folder\\secret.psd",
    "bad\r\nname.psd",
    "bad\u0000name.psd",
  ])("rejects unsafe original filename %j", (originalFilename) => {
    expect(() =>
      parseUploadInit({ ...validInit(), originalFilename }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("requires a nonnegative lastModified and lowercase SHA-256", () => {
    expect(() =>
      parseUploadInit({ ...validInit(), lastModified: -1 }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      parseUploadInit({ ...validInit(), contentHash: "A".repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("requires one source and unique asset roles and IDs at completion", () => {
    const operationId = randomUUID();
    const source = {
      assetId: randomUUID(),
      role: "source",
      objectKey: "placeholder",
      extension: "psd",
      sizeBytes: 4,
    };

    expect(() =>
      parseUploadComplete({ operationId, assets: [{ ...source, role: "preview" }] }),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_OBJECT_INVALID" }));
    expect(() =>
      parseUploadComplete({ operationId, assets: [source, { ...source }] }),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_OBJECT_INVALID" }));
  });

  it("keeps derived assets at the currently verifiable image boundary", () => {
    expect(() =>
      parseUploadComplete({
        operationId: randomUUID(),
        assets: [
          {
            assetId: randomUUID(),
            role: "source",
            objectKey: "source-key",
            extension: "psd",
            sizeBytes: 4,
          },
          {
            assetId: randomUUID(),
            role: "preview",
            objectKey: "derived-key",
            extension: "webp",
            sizeBytes: 4,
            width: 10,
            height: 10,
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_EXTENSION_UNSUPPORTED" }),
    );
  });

  it("maps an oversized completion declaration to the stable size error", () => {
    expect(() =>
      parseUploadComplete({
        operationId: randomUUID(),
        assets: [
          {
            assetId: randomUUID(),
            role: "source",
            objectKey: "source-key",
            extension: "psd",
            sizeBytes: MAX_UPLOAD_SIZE_BYTES + 1,
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_FILE_TOO_LARGE", status: 413 }),
    );
  });
});
