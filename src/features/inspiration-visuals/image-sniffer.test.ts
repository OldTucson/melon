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
});
