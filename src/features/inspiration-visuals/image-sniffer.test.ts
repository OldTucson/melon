// @vitest-environment node
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { sniffImage } from "./image-sniffer";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
// Correct CRC independently, since this common sample is circulated with a bad IDAT CRC.
png.writeUInt32BE(crc32(png.subarray(37, 52)), 52);
const gif = Buffer.from("47494638396101000100800000000000ffffff2c00000000010001000002024401003b", "hex");
function jpeg(progressive = false, width = 1, height = 1) {
  const b = Buffer.from([0xff,0xd8,0xff,progressive ? 0xc2 : 0xc0,0,11,8,0,0,0,0,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0x12,0xff,0x00,0x34,0xff,0xd9]);
  b.writeUInt16BE(height, 7); b.writeUInt16BE(width, 9); return b;
}
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8); head.write(type); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}
function pngChunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 4, "latin1");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}
function webp(kind: "VP8 " | "VP8L" | "VP8X") {
  const payload = kind === "VP8L" ? Buffer.from([0x2f,0,0,0,0,1]) : Buffer.from([0x10,0,0,0x9d,1,0x2a,1,0,1,0,1]);
  const chunks = kind === "VP8X" ? [chunk("VP8X", Buffer.alloc(10)), chunk("VP8 ", payload)] : [chunk(kind, payload)];
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const head = Buffer.alloc(8); head.write("RIFF"); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]);
}
const fixtures = [
  { bytes: png, mime: "image/png", extension: "png" },
  { bytes: jpeg(), mime: "image/jpeg", extension: "jpg" },
  { bytes: jpeg(true), mime: "image/jpeg", extension: "jpg" },
  ...(["VP8 ", "VP8L", "VP8X"] as const).map((kind) => ({ bytes: webp(kind), mime: "image/webp", extension: "webp" })),
  { bytes: gif, mime: "image/gif", extension: "gif" },
  { bytes: Buffer.concat([Buffer.from("GIF87a"), gif.subarray(6)]), mime: "image/gif", extension: "gif" },
];
describe("structural image boundary (not a codec decoder)", () => {
  it.each(fixtures)("accepts complete $mime/$extension container", ({ bytes, mime, extension }) => {
    expect(sniffImage(bytes, mime)).toEqual({ contentType: mime, extension, width: 1, height: 1 });
  });
  it.each(fixtures)("rejects truncated and trailing $mime payloads", ({ bytes, mime }) => {
    for (const length of [0, 4, 10, bytes.length - 1]) expect(() => sniffImage(bytes.subarray(0, length), mime)).toThrow();
    expect(() => sniffImage(Buffer.concat([bytes, Buffer.from("<script>evil()</script>")]), mime)).toThrow();
  });
  it.each(["text/html", "image/svg+xml", "multipart/mixed", "image/jpeg", "image/png, image/png"])("rejects MIME mismatch or ambiguity %s", (mime) => {
    expect(() => sniffImage(png, mime)).toThrow();
  });
  it.each(["<html>evil</html>", "<svg></svg>", "<script>evil()</script>"])("rejects active content disguised as PNG", (body) => {
    expect(() => sniffImage(Buffer.from(body), "image/png")).toThrow();
  });
  it("rejects invalid CRC and duplicate PNG header", () => {
    const bad = Buffer.from(png); bad[45] = bad[45]! ^ 1;
    expect(() => sniffImage(bad, "image/png")).toThrow();
    expect(() => sniffImage(Buffer.concat([png.subarray(0, 33), png.subarray(8)]), "image/png")).toThrow();
  });
  it.each([[0,1], [32769,1], [8000,5001]])("rejects zero/oversized dimensions and >40M pixels (%i x %i)", (w,h) => {
    expect(() => sniffImage(jpeg(false,w,h), "image/jpeg")).toThrow();
  });
  it("accepts the 40M pixel boundary", () => {
    expect(sniffImage(jpeg(false,8000,5000), "image/jpeg").width).toBe(8000);
  });
  it("rejects malformed JPEG segment lengths and missing scan", () => {
    const bad = jpeg(); bad.writeUInt16BE(1, 4);
    expect(() => sniffImage(bad, "image/jpeg")).toThrow();
    expect(() => sniffImage(Buffer.concat([jpeg().subarray(0,15), Buffer.from([0xff,0xd9])]), "image/jpeg")).toThrow();
  });
  it("rejects mismatched WebP canvas dimensions and RIFF size", () => {
    const bad = webp("VP8X"); bad[24] = 1;
    expect(() => sniffImage(bad, "image/webp")).toThrow();
    const size = webp("VP8 "); size.writeUInt32LE(0,4);
    expect(() => sniffImage(size, "image/webp")).toThrow();
  });
  it("rejects GIF frame extending beyond canvas and unterminated sub-blocks", () => {
    const bad = Buffer.from(gif); bad.writeUInt16LE(2,24);
    expect(() => sniffImage(bad, "image/gif")).toThrow();
    const blocks = Buffer.from(gif); blocks[30] = 99;
    expect(() => sniffImage(blocks, "image/gif")).toThrow();
  });
  it("rejects a GIF graphic control extension with an extra sub-block", () => {
    const gce = Buffer.from([0x21,0xf9,4,0,0,0,0,1,0,0]);
    expect(() => sniffImage(Buffer.concat([gif.subarray(0,19), gce, gif.subarray(19)]), "image/gif")).toThrow();
  });
  it("rejects WebP feature flags without matching chunks", () => {
    const bad = webp("VP8X"); bad[20] = 0x20;
    expect(() => sniffImage(bad, "image/webp")).toThrow();
  });
  it.each([
    { name: "GIF87a", bytes: Buffer.concat([Buffer.from("GIF87a"), gif.subarray(6)]), mime: "image/gif", start: 0, length: 6 },
    { name: "GIF89a", bytes: gif, mime: "image/gif", start: 0, length: 6 },
    { name: "RIFF", bytes: webp("VP8 "), mime: "image/webp", start: 0, length: 4 },
    { name: "WEBP", bytes: webp("VP8 "), mime: "image/webp", start: 8, length: 4 },
  ])("rejects high-bit mutations of every $name signature byte", ({ bytes, mime, start, length }) => {
    for (let index = start; index < start + length; index++) {
      const mutated = Buffer.from(bytes);
      mutated[index] = mutated[index]! | 0x80;
      expect(() => sniffImage(mutated, mime)).toThrow();
    }
  });
  it.each(["VP8 ", "VP8L", "VP8X"] as const)("rejects high-bit mutations of %s chunk identifiers", (kind) => {
    for (let index = 12; index < 16; index++) {
      const mutated = webp(kind);
      mutated[index] = mutated[index]! | 0x80;
      expect(() => sniffImage(mutated, "image/webp")).toThrow();
    }
  });
  it.each([
    { name: "IHDR", offset: 8 },
    { name: "IDAT", offset: 33 },
    { name: "IEND", offset: 56 },
  ])("rejects high-bit PNG $name chunk bytes even with matching CRC", ({ offset }) => {
    for (let index = offset + 4; index < offset + 8; index++) {
      const mutated = Buffer.from(png);
      mutated[index] = mutated[index]! | 0x80;
      const crcOffset = offset + 8 + mutated.readUInt32BE(offset);
      mutated.writeUInt32BE(crc32(mutated.subarray(offset + 4, crcOffset)), crcOffset);
      expect(() => sniffImage(mutated, "image/png")).toThrow();
    }
  });
  it("rejects high-bit PNG ancillary chunk identifiers with matching CRC", () => {
    const textChunk = pngChunk("tEXt", Buffer.from("name\0value"));
    for (let index = 4; index < 8; index++) {
      const mutated = Buffer.from(textChunk);
      mutated[index] = mutated[index]! | 0x80;
      mutated.writeUInt32BE(crc32(mutated.subarray(4, mutated.length - 4)), mutated.length - 4);
      expect(() => sniffImage(Buffer.concat([png.subarray(0, 33), mutated, png.subarray(33)]), "image/png")).toThrow();
    }
  });
  it.each([
    { name: "ancillary chunk", interrupt: pngChunk("tEXt", Buffer.from("name\0value")) },
    { name: "palette chunk", interrupt: pngChunk("PLTE", Buffer.from([0, 0, 0])) },
  ])("rejects an empty PNG IDAT followed by a $name before more IDAT", ({ interrupt }) => {
    const emptyData = pngChunk("IDAT", Buffer.alloc(0));
    const malformed = Buffer.concat([png.subarray(0, 33), emptyData, interrupt, png.subarray(33)]);
    expect(() => sniffImage(malformed, "image/png")).toThrow();
  });
  it("accepts contiguous empty PNG IDAT chunks around nonempty image data", () => {
    const emptyData = pngChunk("IDAT", Buffer.alloc(0));
    const contiguous = Buffer.concat([png.subarray(0, 33), emptyData, png.subarray(33, 56), emptyData, png.subarray(56)]);
    expect(sniffImage(contiguous, "image/png")).toMatchObject({ width: 1, height: 1 });
  });
});
