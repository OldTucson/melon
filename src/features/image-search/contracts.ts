import { z } from "zod";

import { patternQuerySchema } from "@/features/patterns/contracts";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

export const imageSearchMatchKinds = [
  "probable_source",
  "possible_source",
  "visually_similar",
] as const;

export const imageSearchMatchKindSchema = z.enum(imageSearchMatchKinds);

export const imageSearchFiltersSchema = z
  .object({
    q: patternQuerySchema.shape.q,
    formats: patternQuerySchema.shape.formats,
    tagIds: patternQuerySchema.shape.tagIds,
    tagMode: patternQuerySchema.shape.tagMode,
    untagged: patternQuerySchema.shape.untagged,
    favorite: patternQuerySchema.shape.favorite,
    previewStatus: patternQuerySchema.shape.previewStatus,
    commercialState: patternQuerySchema.shape.commercialState,
    authorizationField: patternQuerySchema.shape.authorizationField,
    folderId: patternQuerySchema.shape.folderId,
    unfiled: patternQuerySchema.shape.unfiled,
    includeDescendants: patternQuerySchema.shape.includeDescendants,
  })
  .strict()
  .refine((query) => query.folderId === undefined || query.unfiled !== true, {
    message: "folderId and unfiled=true are mutually exclusive",
  });

export const imageSearchRequestFieldsSchema = z
  .object({
    filters: imageSearchFiltersSchema,
    requestId: publicOperationIdSchema,
  })
  .strict();

const canonicalUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());

const internalImageSearchItemSchema = z
  .object({
    patternId: canonicalUuidSchema,
    kind: imageSearchMatchKindSchema,
    score: z.number().finite(),
  })
  .strict();

export const internalImageSearchResponseSchema = z
  .object({
    requestId: canonicalUuidSchema,
    query: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    items: z.array(internalImageSearchItemSchema).max(30),
  })
  .strict()
  .superRefine((response, context) => {
    const ids = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (ids.has(item.patternId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "patternId"],
          message: "Pattern IDs must be unique",
        });
      }
      ids.add(item.patternId);
    }
  });

export const imageSearchIndexStatusSchema = z.object({
  indexVersion: z.string().regex(/^[a-z0-9-]{1,64}$/),
  eligible: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  indexing: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  worker: z.enum(["online", "stale", "offline"]),
});

export const imageSearchRetryResultSchema = z.object({
  enqueued: z.number().int().nonnegative(),
});

export const imageSearchRebuildResultSchema = imageSearchRetryResultSchema
  .extend({
    alreadyExisting: z.number().int().nonnegative(),
  });

export type ImageSearchFilters = z.output<typeof imageSearchFiltersSchema>;
export type ImageSearchFiltersInput = z.input<typeof imageSearchFiltersSchema>;
export type ImageSearchMatchKind = z.output<typeof imageSearchMatchKindSchema>;
export type InternalImageSearchResponse = z.output<
  typeof internalImageSearchResponseSchema
>;
export type ImageSearchIndexStatus = z.output<
  typeof imageSearchIndexStatusSchema
>;
