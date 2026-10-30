import "server-only";

import { crc32 } from "node:zlib";

export type ImageMetadata = {
  contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  extension: "png" | "jpg" | "webp" | "gif";
  width: number;
  height: number;
};
type Dimensions = { width: number; height: number };

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid remote image bytes");
}
function dimensions(width: number, height: number): Dimensions {
  check(width > 0 && height > 0 && width <= 32768 && height <= 32768 && width * height <= 40_000_000);
  return { width, height };
}
function asciiToken(bytes: Buffer, start: number, end: number): string {
  check(end <= bytes.length);
  const token = bytes.subarray(start, end);
  check(token.every((byte) => byte <= 0x7f));
  // latin1 preserves bytes; Node's "ascii" decoder silently clears high bits.
  return token.toString("latin1");
}

function pngSize(bytes: Buffer): Dimensions {
  check(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  let offset = 8;
  let size: Dimensions | undefined;
  let seenData = false;
  let hasPayload = false;
  let dataEnded = false;
  let palette = false;
  let indexed = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = asciiToken(bytes, offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    check(end + 4 <= bytes.length && /^[A-Za-z]{4}$/.test(type));
    check(crc32(bytes.subarray(offset + 4, end)) === bytes.readUInt32BE(end));
    check(size || type === "IHDR");
    if (seenData && type !== "IDAT") dataEnded = true;
    if (type === "IHDR") {
      check(!size && length === 13);
      size = dimensions(bytes.readUInt32BE(start), bytes.readUInt32BE(start + 4));
      const depth = bytes[start + 8]!;
      const color = bytes[start + 9]!;
      const depths: Record<number, number[]> = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
      check(depths[color]?.includes(depth) && bytes[start + 10] === 0 && bytes[start + 11] === 0 && bytes[start + 12]! <= 1);
      indexed = color === 3;
    } else if (type === "PLTE") {
      check(!palette && !seenData && length > 0 && length <= 768 && length % 3 === 0);
      palette = true;
    } else if (type === "IDAT") {
      check(!dataEnded && (!indexed || palette));
      seenData = true;
      if (length) hasPayload = true;
    } else if (type === "IEND") {
      check(length === 0 && hasPayload && end + 4 === bytes.length && size);
      return size;
    } else {
      // Unknown critical chunks and animation are not an accepted single image.
      check(type[0] === type[0]!.toLowerCase() && !["acTL", "fcTL", "fdAT"].includes(type));
    }
    offset = end + 4;
  }
  throw new Error("Invalid remote image bytes");
}

function jpegSize(bytes: Buffer): Dimensions {
  check(bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8);
  let offset = 2;
  let size: Dimensions | undefined;
  let hasScan = false;
  while (offset < bytes.length) {
    check(bytes[offset++] === 0xff);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    check(marker !== undefined && marker !== 0 && marker !== 0xd8);
    if (marker === 0xd9) {
      check(size && hasScan && offset === bytes.length);
      return size;
    }
    check(marker < 0xd0 || marker > 0xd7);
    check(offset + 2 <= bytes.length);
    const length = bytes.readUInt16BE(offset);
    check(length >= 2 && offset + length <= bytes.length);
    const end = offset + length;
    if (marker === 0xc0 || marker === 0xc2) {
      check(!size && length >= 11 && bytes[offset + 2] === 8);
      const components = bytes[offset + 7]!;
      check(components >= 1 && components <= 4 && length === 8 + 3 * components);
      size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    } else if (marker === 0xda) {
      check(size && length >= 6);
      const components = bytes[offset + 2]!;
      check(components >= 1 && components <= 4 && length === 6 + 2 * components);
      hasScan = true;
      offset = end;
      const scanStart = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
      check(offset > scanStart);
      continue;
    } else {
      // Only table, restart interval, comment, and application segments.
      check(marker === 0xc4 || marker === 0xdb || marker === 0xdd || marker === 0xfe || (marker >= 0xe0 && marker <= 0xef));
    }
    offset = end;
  }
  throw new Error("Invalid remote image bytes");
}

function gifSize(bytes: Buffer): Dimensions {
  check(bytes.length >= 13 && /^(GIF87a|GIF89a)$/.test(asciiToken(bytes, 0, 6)));
  const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  let offset = 13;
  if (bytes[10]! & 0x80) offset += 3 * (2 ** ((bytes[10]! & 7) + 1));
  let frames = 0;
  let decodedPixels = 0;
  const subBlocks = () => {
    let total = 0;
    while (offset < bytes.length) {
      const length = bytes[offset++]!;
      if (!length) return total;
      check(offset + length <= bytes.length);
      offset += length; total += length;
    }
    throw new Error("Invalid remote image bytes");
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) { check(frames > 0 && offset === bytes.length); return size; }
    if (marker === 0x21) {
      const label = bytes[offset++];
      // Plain text rendering is outside the accepted raster-image subset.
      check(label === 0xf9 || label === 0xfe || label === 0xff);
      if (label === 0xf9) {
        check(offset + 6 <= bytes.length && bytes[offset] === 4 && bytes[offset + 5] === 0);
        offset += 6;
        continue;
      }
      if (label === 0xff) check(bytes[offset] === 11);
      subBlocks();
      continue;
    }
    check(marker === 0x2c && offset + 9 <= bytes.length);
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2);
    const frame = dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6));
    check(left + frame.width <= size.width && top + frame.height <= size.height);
    decodedPixels += size.width * size.height;
    check(decodedPixels <= 40_000_000);
    const packed = bytes[offset + 8]!;
    offset += 9;
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 7) + 1));
    check(offset < bytes.length && bytes[offset]! >= 2 && bytes[offset]! <= 8);
    offset++;
    check(subBlocks() > 0);
    frames++;
  }
  throw new Error("Invalid remote image bytes");
}

function webpSize(bytes: Buffer): Dimensions {
  check(bytes.length >= 20 && asciiToken(bytes, 0, 4) === "RIFF" && asciiToken(bytes, 8, 12) === "WEBP");
  check(bytes.readUInt32LE(4) + 8 === bytes.length);
  let offset = 12;
  let canvas: Dimensions | undefined;
  let size: Dimensions | undefined;
  let flags = 0;
  let losslessAlpha = false;
  const seen = new Set<string>();
  while (offset + 8 <= bytes.length) {
    const type = asciiToken(bytes, offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    check(end + length % 2 <= bytes.length && !seen.has(type));
    seen.add(type);
    if (length % 2) check(bytes[end] === 0);
    if (type === "VP8X") {
      check(offset === 12 && length === 10 && (bytes[start]! & 0xc3) === 0 && bytes.readUIntBE(start + 1, 3) === 0);
      flags = bytes[start]!;
      canvas = dimensions(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3));
    } else if (type === "VP8 ") {
      check(!size && length > 10 && (bytes[start]! & 1) === 0 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d,1,0x2a])));
      size = dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
    } else if (type === "VP8L") {
      check(!size && length > 5 && bytes[start] === 0x2f && (bytes[start + 4]! & 0xe0) === 0);
      const packed = bytes.readUInt32LE(start + 1);
      losslessAlpha = (packed & 0x10000000) !== 0;
      size = dimensions(1 + (packed & 0x3fff), 1 + ((packed >>> 14) & 0x3fff));
    } else {
      check(canvas && ["ALPH", "ICCP", "EXIF", "XMP "].includes(type) && length > 0);
      if (type === "ALPH" || type === "ICCP") check(!size);
    }
    offset = end + length % 2;
  }
  check(offset === bytes.length && size);
  check(!canvas || (canvas.width === size.width && canvas.height === size.height));
  if (canvas) {
    check(Boolean(flags & 0x20) === seen.has("ICCP"));
    check(Boolean(flags & 0x08) === seen.has("EXIF"));
    check(Boolean(flags & 0x04) === seen.has("XMP "));
    check(Boolean(flags & 0x10) === (seen.has("ALPH") || losslessAlpha));
    check(!seen.has("ALPH") || seen.has("VP8 "));
  }
  return size;
}

/** Validates complete container framing and dimensions, not compressed codec entropy. */
export function sniffImage(bytes: Buffer, mime: string): ImageMetadata {
  check(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
  // No parameters or multiple media types: an image response has one exact type.
  const contentType = mime.trim().toLowerCase();
  switch (contentType) {
    case "image/png": return { ...pngSize(bytes), contentType, extension: "png" };
    case "image/jpeg": return { ...jpegSize(bytes), contentType, extension: "jpg" };
    case "image/gif": return { ...gifSize(bytes), contentType, extension: "gif" };
    case "image/webp": return { ...webpSize(bytes), contentType, extension: "webp" };
    default: throw new Error("Invalid remote image type");
  }
}
