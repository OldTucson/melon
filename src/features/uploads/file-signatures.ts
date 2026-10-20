import { AppError } from "@/lib/http/app-error";

import type {
  UploadDerivedExtension,
  UploadSourceExtension,
} from "./contracts";

type VerifiableExtension = UploadSourceExtension | UploadDerivedExtension;

export type DetectedFileSignature =
  | { format: "jpeg"; mimeType: "image/jpeg" }
  | { format: "png"; mimeType: "image/png" }
  | { format: "webp"; mimeType: "image/webp" }
  | { format: "psd"; mimeType: "image/vnd.adobe.photoshop" }
  | { format: "pdf"; mimeType: "application/pdf" }
  | { format: "ai-pdf"; mimeType: "application/pdf" }
  | { format: "ai-postscript"; mimeType: "application/postscript" }
  | { format: "procreate"; mimeType: "application/zip" };

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.byteLength >= signature.length &&
  signature.every((value, index) => bytes[index] === value);

const asciiSignature = (value: string) =>
  Array.from(value, (character) => character.charCodeAt(0));

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PSD = asciiSignature("8BPS");
const RIFF = asciiSignature("RIFF");
const WEBP = asciiSignature("WEBP");
const PDF = asciiSignature("%PDF-");
const POSTSCRIPT = asciiSignature("%!PS-Adobe-");
const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
] as const;

export function requiredSignatureBytes(extension: VerifiableExtension) {
  if (extension === "jpg" || extension === "jpeg") return JPEG.length;
  if (extension === "png") return PNG.length;
  if (extension === "psd") return PSD.length;
  if (extension === "pdf") return PDF.length;
  if (extension === "ai") return POSTSCRIPT.length;
  if (extension === "webp") return 12;
  return ZIP_SIGNATURES[0].length;
}

export function detectFileSignature(
  extension: VerifiableExtension,
  bytes: Uint8Array,
): DetectedFileSignature {
  let result: DetectedFileSignature | undefined;

  if ((extension === "jpg" || extension === "jpeg") && startsWith(bytes, JPEG)) {
    result = { format: "jpeg", mimeType: "image/jpeg" };
  } else if (extension === "png" && startsWith(bytes, PNG)) {
    result = { format: "png", mimeType: "image/png" };
  } else if (extension === "psd" && startsWith(bytes, PSD)) {
    result = { format: "psd", mimeType: "image/vnd.adobe.photoshop" };
  } else if (extension === "pdf" && startsWith(bytes, PDF)) {
    result = { format: "pdf", mimeType: "application/pdf" };
  } else if (
    extension === "webp" &&
    startsWith(bytes, RIFF) &&
    bytes.byteLength >= 12 &&
    WEBP.every((value, index) => bytes[index + 8] === value)
  ) {
    result = { format: "webp", mimeType: "image/webp" };
  } else if (extension === "ai" && startsWith(bytes, PDF)) {
    result = { format: "ai-pdf", mimeType: "application/pdf" };
  } else if (extension === "ai" && startsWith(bytes, POSTSCRIPT)) {
    result = { format: "ai-postscript", mimeType: "application/postscript" };
  } else if (
    extension === "procreate" &&
    ZIP_SIGNATURES.some((signature) => startsWith(bytes, signature))
  ) {
    result = { format: "procreate", mimeType: "application/zip" };
  }

  if (!result) {
    throw new AppError(
      "UPLOAD_SIGNATURE_MISMATCH",
      422,
      "Upload signature does not match its extension",
    );
  }
  return result;
}
