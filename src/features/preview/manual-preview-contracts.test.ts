import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_MANUAL_PREVIEW_SIZE_BYTES,
  parseManualPreviewCancel,
  parseManualPreviewComplete,
  parseManualPreviewInit,
} from "./manual-preview-contracts";

const derived = (role: "preview" | "thumbnail") => ({
  assetId: randomUUID(),
  role,
  objectKey: `users/${randomUUID()}/patterns/${randomUUID()}/derived/${randomUUID()}.png`,
  extension: "png" as const,
  sizeBytes: 100,
  width: role === "preview" ? 1200 : 300,
  height: role === "preview" ? 800 : 200,
});

describe("manual preview contracts", () => {
  it("accepts a versioned PNG or WebP initialization", () => {
    const operationId = randomUUID();
    expect(
      parseManualPreviewInit({ operationId, version: 2, extension: "webp" }),
    ).toEqual({ operationId, version: 2, extension: "webp" });
  });

  it("accepts only a public operation ID for cancellation", () => {
    const operationId = randomUUID();
    expect(parseManualPreviewCancel({ operationId })).toEqual({ operationId });
    expect(() =>
      parseManualPreviewCancel({ operationId, patternId: randomUUID() }),
    ).toThrowError(expect.objectContaining({ code: "MANUAL_PREVIEW_INVALID" }));
  });

  it("requires exactly one preview and one thumbnail", () => {
    const operationId = randomUUID();
    const preview = derived("preview");
    const thumbnail = derived("thumbnail");
    expect(
      parseManualPreviewComplete({
        operationId,
        version: 2,
        assets: [preview, thumbnail],
      }),
    ).toMatchObject({ assets: [{ role: "preview" }, { role: "thumbnail" }] });

    expect(() =>
      parseManualPreviewComplete({ operationId, version: 2, assets: [preview] }),
    ).toThrowError(expect.objectContaining({ code: "MANUAL_PREVIEW_INVALID" }));
    expect(() =>
      parseManualPreviewComplete({
        operationId,
        version: 2,
        assets: [preview, { ...thumbnail, assetId: preview.assetId }],
      }),
    ).toThrowError(expect.objectContaining({ code: "MANUAL_PREVIEW_INVALID" }));
  });

  it("enforces role dimensions and derived size limits", () => {
    const input = {
      operationId: randomUUID(),
      version: 0,
      assets: [derived("preview"), derived("thumbnail")],
    };
    expect(() =>
      parseManualPreviewComplete({
        ...input,
        assets: [{ ...input.assets[0], width: 2049 }, input.assets[1]],
      }),
    ).toThrowError(expect.objectContaining({ code: "MANUAL_PREVIEW_INVALID" }));
    expect(() =>
      parseManualPreviewComplete({
        ...input,
        assets: [
          { ...input.assets[0], sizeBytes: MAX_MANUAL_PREVIEW_SIZE_BYTES + 1 },
          input.assets[1],
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "MANUAL_PREVIEW_INVALID" }));
  });
});
