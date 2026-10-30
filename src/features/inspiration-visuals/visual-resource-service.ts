import "server-only";

import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";

import { createVisualObjectStore, type VisualObjectStore } from "./visual-object-store";
import { findCompletedVisualResource, type VisualResourceIdentity } from "./visual-repository";

type VisualResource = { objectKey: string; contentType: string };

const resourceSchema = z.object({
  objectKey: z.string().min(1),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});

const notFound = () => new AppError("NOT_FOUND", 404, "Not found");

function parseUuid(value: string) {
  const parsed = normalizedUuidSchema.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

async function authorize(input: VisualResourceIdentity): Promise<VisualResource> {
  try {
    return resourceSchema.parse(await findCompletedVisualResource(input));
  } catch {
    // Do not distinguish ownership, share state, job state, or lookup failures.
    throw notFound();
  }
}

export async function authorizeOwnedVisualResource(input: { ownerId: string; assetId: string }): Promise<VisualResource> {
  return authorize({ ownerId: parseUuid(input.ownerId), assetId: parseUuid(input.assetId) });
}

export async function authorizeSharedVisualResource(input: { shareId: string; assetId: string }): Promise<VisualResource> {
  return authorize({ shareId: parseUuid(input.shareId), assetId: parseUuid(input.assetId) });
}

export async function visualResourceResponse(
  resource: VisualResource,
  dependencies: { store?: Pick<VisualObjectStore, "get"> } = {},
): Promise<Response> {
  try {
    const { objectKey, contentType } = resourceSchema.parse(resource);
    let store = dependencies.store;
    if (!store) {
      const env = getServerEnv();
      store = createVisualObjectStore({
        region: env.ALIYUN_OSS_REGION,
        bucket: env.ALIYUN_OSS_BUCKET,
        endpoint: env.ALIYUN_OSS_ENDPOINT,
        cname: env.ALIYUN_OSS_CNAME,
      });
    }
    const object = await store.get(objectKey);
    if (object.contentType !== contentType) throw notFound();
    // Copy only this view's bytes; never expose an underlying Buffer allocation.
    const bytes = Uint8Array.from(object.bytes);
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    // Missing objects and storage errors have the same public denial as authorization.
    throw notFound();
  }
}
