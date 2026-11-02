import "server-only";

import sharp from "sharp";
import { AppError } from "@/lib/http/app-error";

/** Only private stored bytes enter this function. It never loads a URL or file. */
export async function prepareConceptInput(input: { bytes: Uint8Array; contentType: string }): Promise<string> {
  try {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > 16 * 1024 * 1024) throw new Error();
    const source = Buffer.from(input.bytes);
    const formats: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" };
    const expectedFormat = formats[input.contentType];
    if (!expectedFormat) throw new Error();
    const image = sharp(source, { animated: false, limitInputPixels: 40_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) throw new Error();
    const bytes = await image.rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 }).toBuffer();
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error();
    return `data:image/webp;base64,${bytes.toString("base64")}`;
  } catch {
    throw new AppError("INSPIRATION_CONCEPT_REFERENCE_INVALID", 502, "INSPIRATION_CONCEPT_REFERENCE_INVALID");
  }
}
