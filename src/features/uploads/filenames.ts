import { parseObjectKey } from "@/features/storage/object-keys";

const MAX_DOWNLOAD_NAME_BYTES = 180;
const MAX_PATTERN_NAME_LENGTH = 160;
const unsafeDownloadCharacters = /[\p{Cc}\p{Cf}/\\'"]/gu;

function withoutFinalExtension(filename: string) {
  const separator = filename.lastIndexOf(".");
  return separator >= 0 ? filename.slice(0, separator) : filename;
}

function truncateUtf8(value: string, maxBytes: number) {
  const encoder = new TextEncoder();
  let result = "";
  for (const character of value) {
    if (encoder.encode(result + character).byteLength > maxBytes) break;
    result += character;
  }
  return result;
}

function truncateStringLength(value: string, maxLength: number) {
  let result = "";
  for (const character of value) {
    if ((result + character).length > maxLength) break;
    result += character;
  }
  return result;
}

export function sanitizeDownloadName(filename: string, objectKey: string) {
  const extension = parseObjectKey(objectKey).extension;
  const suffix = `.${extension}`;
  const sanitizedStem = withoutFinalExtension(filename)
    .replace(unsafeDownloadCharacters, "")
    .trim();
  const stem = sanitizedStem || "download";
  const budget = MAX_DOWNLOAD_NAME_BYTES - new TextEncoder().encode(suffix).byteLength;
  return `${truncateUtf8(stem, budget) || "download"}${suffix}`;
}

export function derivePatternName(filename: string) {
  const stem = withoutFinalExtension(filename)
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(stem)) return "Untitled Pattern";
  return truncateStringLength(stem, MAX_PATTERN_NAME_LENGTH) || "Untitled Pattern";
}
