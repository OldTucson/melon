// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { prepareConceptInput } from "./image-input";
const image = (width = 24, height = 12) => sharp({ create: { width, height, channels: 3, background: "#23854a" } });
const decode = (uri: string) => Buffer.from(uri.split(",", 2)[1]!, "base64");
describe("private image preparation", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)("decodes %s and emits metadata-free WebP", async (format) => {
    const bytes = await image().toFormat(format).toBuffer();
    const prepared = await prepareConceptInput({ bytes, contentType: `image/${format}` });
    expect(prepared).toMatch(/^data:image\/webp;base64,/);
    expect(await sharp(decode(prepared)).metadata()).toMatchObject({ format: "webp", width: 24, height: 12 });
    expect(await sharp(decode(prepared)).metadata()).not.toHaveProperty("exif");
  });
  it("rotates JPEG using EXIF before sizing", async () => {
    const bytes = await image(800, 1200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const prepared = await prepareConceptInput({ bytes, contentType: "image/jpeg" });
    expect(await sharp(decode(prepared)).metadata()).toMatchObject({ width: 1200, height: 800 });
  });
  it("bounds the longest side to 2048 without enlargement", async () => {
    const bytes = await image(4096, 1024).png().toBuffer();
    const prepared = await prepareConceptInput({ bytes, contentType: "image/png" });
    expect(await sharp(decode(prepared)).metadata()).toMatchObject({ width: 2048, height: 512 });
    expect(decode(prepared).length).toBeLessThanOrEqual(10 * 1024 * 1024);
  });
  it("uses only the first animated GIF frame", async () => {
    const bytes = await sharp({ create: { width: 16, height: 32, channels: 3, background: "red", pageHeight: 16 } }).gif({ loop: 0 }).toBuffer();
    const prepared = await prepareConceptInput({ bytes, contentType: "image/gif" });
    expect(await sharp(decode(prepared)).metadata()).toMatchObject({ width: 16, height: 16 });
  });
  it("rejects invalid bytes, MIME mismatch, SVG and over-40MP sources without exposing inputs", async () => {
    const large = await image(8000, 5001).png().toBuffer();
    for (const source of [{ bytes: Buffer.from("private-result"), contentType: "image/png" }, { bytes: await image().png().toBuffer(), contentType: "image/jpeg" }, { bytes: Buffer.from('<svg width="10" height="10"></svg>'), contentType: "image/svg+xml" }, { bytes: large, contentType: "image/png" }, { bytes: Buffer.alloc(16 * 1024 * 1024 + 1), contentType: "image/png" }]) {
      const error = await prepareConceptInput(source).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "INSPIRATION_CONCEPT_REFERENCE_INVALID" });
      expect(String(error) + JSON.stringify(error)).not.toMatch(/private-result|svg|Input buffer|pixels/);
    }
  });
});
