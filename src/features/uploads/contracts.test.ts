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

  it("accepts PDF as a standalone source format", () => {
    expect(
      parseUploadInit({
        ...validInit(),
        originalFilename: "Pattern catalog.PDF",
        extension: "pdf",
      }),
    ).toMatchObject({ originalFilename: "Pattern catalog.PDF", extension: "pdf" });
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

    expect(() =>
      parseUploadComplete({
        operationId,
        assets: [
          source,
          {
            ...source,
            assetId: source.assetId.toUpperCase(),
            role: "preview",
            extension: "png",
            width: 10,
            height: 10,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_OBJECT_INVALID" }));
  });

  it("accepts WebP only for derived assets", () => {
    expect(
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
            sizeBytes: 12,
            width: 10,
            height: 10,
          },
        ],
      }),
    ).toMatchObject({ assets: [{ role: "source" }, { extension: "webp" }] });

    expect(() =>
      parseUploadInit({ ...validInit(), originalFilename: "source.webp", extension: "webp" }),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_EXTENSION_UNSUPPORTED" }));
  });

  it("enforces role-aware derived dimensions within PostgreSQL integer bounds", () => {
    const source = {
      assetId: randomUUID(),
      role: "source" as const,
      objectKey: "source-key",
      extension: "psd" as const,
      sizeBytes: 4,
    };
    const derived = {
      assetId: randomUUID(),
      role: "preview" as const,
      objectKey: "preview-key",
      extension: "png" as const,
      sizeBytes: 8,
      width: 2048,
      height: 2048,
    };

    expect(parseUploadComplete({ operationId: randomUUID(), assets: [source, derived] })).toBeDefined();
    for (const asset of [
      { ...derived, width: 2049 },
      { ...derived, assetId: randomUUID(), role: "thumbnail", width: 513, height: 512 },
      { ...derived, width: 2_147_483_648 },
    ]) {
      expect(() =>
        parseUploadComplete({ operationId: randomUUID(), assets: [source, asset] }),
      ).toThrowError(expect.objectContaining({ code: "UPLOAD_OBJECT_INVALID" }));
    }
    expect(() =>
      parseUploadComplete({
        operationId: randomUUID(),
        assets: [{ ...source, width: 1, height: 1 }],
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("requires the filename suffix to match the declared source extension", () => {
    expect(() =>
      parseUploadInit({ ...validInit(), originalFilename: "flora.png" }),
    ).toThrowError(expect.objectContaining({ code: "UPLOAD_OBJECT_INVALID" }));
    expect(
      parseUploadInit({
        ...validInit(),
        originalFilename: "flora.JPEG",
        extension: "jpg",
      }),
    ).toMatchObject({ originalFilename: "flora.JPEG", extension: "jpg" });
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
