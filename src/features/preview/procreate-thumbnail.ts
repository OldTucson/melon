import { unzipSync } from "fflate";

const MAX_QUICKLOOK_BYTES = 50 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function normalizedEntryName(value: string) {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

export function extractProcreateThumbnail(archive: Uint8Array) {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive, {
      filter: (entry) =>
        normalizedEntryName(entry.name) === "quicklook/thumbnail.png" &&
        entry.originalSize <= MAX_QUICKLOOK_BYTES,
    });
  } catch {
    throw new Error("PREVIEW_DECODE_FAILED");
  }
  const match = Object.entries(entries).find(
    ([name]) => normalizedEntryName(name) === "quicklook/thumbnail.png",
  )?.[1];
  if (!match) throw new Error("PREVIEW_UNSUPPORTED");
  if (!PNG_SIGNATURE.every((byte, index) => match[index] === byte)) {
    throw new Error("PREVIEW_DECODE_FAILED");
  }
  return match;
}
