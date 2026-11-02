import "server-only";

import sharp from "sharp";
import { z } from "zod";
import { sniffImage } from "@/features/inspiration-visuals/image-sniffer";
import { fetchRemoteImage, type RemoteImageDependencies } from "@/features/inspiration-visuals/safe-image-fetch";
import { AppError } from "@/lib/http/app-error";
import { conceptOutputObjectKey, type ConceptObjectKeyParts } from "./object-keys";
import type { ConceptObjectStore } from "./object-store";

const limits = { maxBytes: 16 * 1024 * 1024, maxPixels: 40_000_000 };
const displaySchema = z.object({ title: z.string().trim().min(1).max(300), altText: z.string().trim().min(1).max(500) });
export type ImportedConceptAsset = { id: string; title: string; altText: string; objectKey: string; contentType: "image/png"; width: number; height: number };

/** No temporary URL crosses this return boundary. Caller deletes writtenKey if DB publication fails. */
export async function importConceptOutput(input: ConceptObjectKeyParts & { temporaryImageUrl: string; title: string; altText: string; signal?: AbortSignal }, dependencies: {
  store: ConceptObjectStore;
  remote?: Omit<RemoteImageDependencies, "signal">;
}): Promise<{ asset: ImportedConceptAsset; writtenKey: string }> {
  let writtenKey: string | undefined;
  try {
    const key = conceptOutputObjectKey(input);
    const display = displaySchema.parse(input);
    input.signal?.throwIfAborted();
    const remote = await fetchRemoteImage(input.temporaryImageUrl, { ...dependencies.remote, signal: input.signal }, limits);
    const expected = input.outputKind === "flat" ? { width: 2048, height: 1536 } : { width: 1536, height: 2048 };
    if (remote.contentType !== "image/png" || remote.width !== expected.width || remote.height !== expected.height) throw new Error();
    // Decode compressed data, then re-encode a metadata-free, single-frame PNG.
    const decoded = await sharp(remote.bytes, { animated: false, limitInputPixels: limits.maxPixels, failOn: "warning" }).png().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== expected.width || decoded.info.height !== expected.height) throw new Error();
    sniffImage(decoded.data, "image/png", limits);
    input.signal?.throwIfAborted();
    const asset: ImportedConceptAsset = { id: input.outputId.toLowerCase(), ...display, objectKey: key, contentType: "image/png", ...expected };
    // A storage error may happen after persistence, so compensate even an ambiguous put.
    writtenKey = key;
    await dependencies.store.put({ key, bytes: decoded.data, contentType: "image/png" });
    input.signal?.throwIfAborted();
    return { asset, writtenKey };
  } catch {
    if (writtenKey) {
      try { await dependencies.store.delete([writtenKey]); } catch { /* Prefix cleanup can recover orphaned writes. Never expose storage errors. */ }
    }
    throw new AppError("INSPIRATION_CONCEPT_IMPORT_FAILED", 502, "INSPIRATION_CONCEPT_IMPORT_FAILED");
  }
}
