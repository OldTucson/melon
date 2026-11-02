import "server-only";

import { z } from "zod";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import { authorizeSharedVisualResource } from "@/features/inspiration-visuals/visual-resource-service";
import { conceptOutputKindSchema } from "./contracts";
import { parseConceptObjectKey } from "./object-keys";
import {
  createConceptObjectStore,
  type ConceptObjectStore,
} from "./object-store";
import { findOwnedConceptResource, findSharedConceptOutput } from "./repository";

const identitySchema = z
  .object({ ownerId: normalizedUuidSchema, assetId: normalizedUuidSchema })
  .strict();
export const conceptAssetParamsSchema = z
  .object({ assetId: normalizedUuidSchema })
  .strict();
export type ConceptAssetContext = { params: Promise<{ assetId: string }> };
type ConceptResource = {
  bytes: Uint8Array;
  contentType: "image/png";
  filename: string;
};
const metadataSchema = z.object({
  directionTitle: z.string().min(1).max(120),
  version: z.number().int().positive(),
  asset: z.object({
    id: normalizedUuidSchema,
    ownerId: normalizedUuidSchema,
    analysisId: normalizedUuidSchema,
    setId: normalizedUuidSchema,
    objectKey: z.string().min(1).max(1024),
    outputKind: conceptOutputKindSchema,
    contentType: z.literal("image/png"),
  }),
});
const notFound = () => new AppError("NOT_FOUND", 404, "Not found");
export function parseConceptAssetParams(input: unknown) {
  const parsed = conceptAssetParamsSchema.safeParse(input);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

export async function authorizeOwnedConceptResource(
  input: { ownerId: string; assetId: string },
  dependencies: { store?: Pick<ConceptObjectStore, "get"> } = {},
): Promise<ConceptResource> {
  try {
    const identity = identitySchema.parse(input);
    const resource = metadataSchema.parse(
      await findOwnedConceptResource(identity),
    );
    const { asset } = resource;
    if (asset.ownerId !== identity.ownerId || asset.id !== identity.assetId) throw notFound();
    const object = await readConceptObject(asset, dependencies);
    const label = {
      sketch: "设计草图",
      effect: "服装效果图",
      flat: "服装款式图",
    }[asset.outputKind];
    // Keep the bounded filename well formed for RFC 5987 percent encoding.
    const title =
      Array.from(
        resource.directionTitle
          .toWellFormed()
          .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
          .trim(),
      )
        .slice(0, 80)
        .join("") || "设计方向";
    return {
      bytes: Uint8Array.from(object.bytes),
      contentType: asset.contentType,
      filename: `${title}-方案${String(resource.version).padStart(2, "0")}-${label}.png`,
    };
  } catch {
    // Ownership, missing objects, corrupt metadata and storage failures share one denial.
    throw notFound();
  }
}
async function readConceptObject(
  input: z.input<typeof metadataSchema.shape.asset>,
  dependencies: { store?: Pick<ConceptObjectStore, "get"> },
) {
  const asset = metadataSchema.shape.asset.parse(input);
  const key = parseConceptObjectKey(asset.objectKey);
  if (key.ownerId !== asset.ownerId || key.analysisId !== asset.analysisId || key.setId !== asset.setId || key.outputId !== asset.id || key.outputKind !== asset.outputKind) throw notFound();
  let store = dependencies.store;
  if (!store) {
    const env = getServerEnv();
    store = createConceptObjectStore({ region: env.ALIYUN_OSS_REGION, bucket: env.ALIYUN_OSS_BUCKET, endpoint: env.ALIYUN_OSS_ENDPOINT, cname: env.ALIYUN_OSS_CNAME });
  }
  const object = await store.get(asset.objectKey);
  if (object.contentType !== asset.contentType || !object.bytes.byteLength || object.bytes.byteLength > 16 * 1024 * 1024) throw notFound();
  return { bytes: Uint8Array.from(object.bytes), contentType: asset.contentType };
}

/** One live capability gate for both concept output and research image routes. */
export async function authorizeSharedInspirationResource(
  input: { shareId: string; assetId: string },
  dependencies: { store?: Pick<ConceptObjectStore, "get"> } = {},
) {
  try {
    const identity = z.object({ shareId: normalizedUuidSchema, assetId: normalizedUuidSchema }).strict().parse(input);
    const concept = await findSharedConceptOutput(identity);
    if (concept) {
      if (concept.id !== identity.assetId) throw notFound();
      return { ...await readConceptObject(metadataSchema.shape.asset.parse(concept), dependencies), filename: "concept.png" };
    }
    return await authorizeSharedVisualResource(identity);
  } catch { throw notFound(); }
}

export function privateConceptResourceResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Content-Security-Policy", "sandbox");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
export function conceptResourceResponse(
  resource: ConceptResource,
  options: { download?: boolean } = {},
) {
  const headers = new Headers({
    "Content-Type": resource.contentType,
    "Content-Length": String(resource.bytes.byteLength),
  });
  if (options.download) {
    // RFC 5987 attr-char excludes the punctuation left unescaped by encodeURIComponent.
    const encoded = encodeURIComponent(resource.filename).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    headers.set(
      "Content-Disposition",
      `attachment; filename="concept.png"; filename*=UTF-8''${encoded}`,
    );
  }
  return privateConceptResourceResponse(
    new Response(Uint8Array.from(resource.bytes), { headers }),
  );
}
