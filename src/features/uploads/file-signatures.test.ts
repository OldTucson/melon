import { describe, expect, it } from "vitest";

import {
  detectFileSignature,
  requiredSignatureBytes,
} from "./file-signatures";

const ascii = (value: string) => new TextEncoder().encode(value);

describe("upload file signatures", () => {
  it.each([
    ["jpg", Uint8Array.from([0xff, 0xd8, 0xff]), "jpeg", "image/jpeg"],
    ["jpeg", Uint8Array.from([0xff, 0xd8, 0xff]), "jpeg", "image/jpeg"],
    [
      "png",
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "png",
      "image/png",
    ],
    ["psd", ascii("8BPS"), "psd", "image/vnd.adobe.photoshop"],
    ["webp", ascii("RIFF1234WEBP"), "webp", "image/webp"],
    ["ai", ascii("%PDF-1.7"), "ai-pdf", "application/pdf"],
    ["pdf", ascii("%PDF-1.7"), "pdf", "application/pdf"],
    [
      "ai",
      ascii("%!PS-Adobe-3.0"),
      "ai-postscript",
      "application/postscript",
    ],
  ] as const)(
    "detects a declared %s signature without trusting content-type",
    (extension, bytes, format, mimeType) => {
      expect(detectFileSignature(extension, bytes)).toEqual({
        format,
        mimeType,
      });
    },
  );

  it.each([
    Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
    Uint8Array.from([0x50, 0x4b, 0x05, 0x06]),
    Uint8Array.from([0x50, 0x4b, 0x07, 0x08]),
  ])("accepts common Procreate ZIP signature %#", (bytes) => {
    expect(detectFileSignature("procreate", bytes)).toEqual({
      format: "procreate",
      mimeType: "application/zip",
    });
  });

  it("does not accept a ZIP container under any non-Procreate declaration", () => {
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
    expect(() => detectFileSignature("psd", zip)).toThrowError(
      expect.objectContaining({ code: "UPLOAD_SIGNATURE_MISMATCH" }),
    );
  });

  it.each([
    ["png", Uint8Array.from([0xff, 0xd8, 0xff])],
    ["jpg", ascii("8BPS")],
    ["ai", ascii("not-an-ai-file")],
    ["procreate", ascii("8BPS")],
    ["webp", ascii("RIFF1234NOPE")],
  ] as const)("rejects a %s extension/signature mismatch", (extension, bytes) => {
    expect(() => detectFileSignature(extension, bytes)).toThrowError(
      expect.objectContaining({
        code: "UPLOAD_SIGNATURE_MISMATCH",
        status: 422,
      }),
    );
  });

  it("exposes only the minimum prefix length needed by each detector", () => {
    expect(requiredSignatureBytes("jpg")).toBe(3);
    expect(requiredSignatureBytes("png")).toBe(8);
    expect(requiredSignatureBytes("psd")).toBe(4);
    expect(requiredSignatureBytes("ai")).toBe(11);
    expect(requiredSignatureBytes("pdf")).toBe(5);
    expect(requiredSignatureBytes("procreate")).toBe(4);
    expect(requiredSignatureBytes("webp")).toBe(12);
  });
});
