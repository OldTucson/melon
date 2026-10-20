import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { hasNoNullByte } from "@/lib/validation/text";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

export const patternFormats = [
  "psd",
  "ai",
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "procreate",
] as const;

export const patternSorts = [
  "updated_desc",
  "created_desc",
  "name_asc",
  "size_desc",
] as const;

export const commercialStates = [
  "unlicensed",
  "standard",
  "field_exclusive",
  "global_buyout",
] as const;

const patternFormatOrder = new Map<string, number>(
  patternFormats.map((format, index) => [format, index]),
);

export const canonicalizePatternFormats = (formats: readonly string[]) =>
  [...formats].sort((left, right) => {
    const leftOrder = patternFormatOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = patternFormatOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.localeCompare(right);
  });

export const canonicalizePatternTagIds = (tagIds: readonly string[]) =>
  [...tagIds].sort((left, right) => left.localeCompare(right));

const queryBoolean = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);

export const patternQuerySchema = z
  .object({
    q: z.string().trim().max(100).refine(hasNoNullByte).optional(),
    formats: z.array(z.enum(patternFormats)).max(patternFormats.length).default([]),
    tagIds: z.array(z.string().uuid()).max(20).default([]),
    tagMode: z.enum(["all", "any"]).default("all"),
    untagged: queryBoolean.optional(),
    favorite: queryBoolean.optional(),
    previewStatus: z
      .enum(["pending", "ready", "unsupported", "failed", "manual"])
      .optional(),
    commercialState: z.enum(commercialStates).optional(),
    authorizationField: normalizedUuidSchema.optional(),
    folderId: normalizedUuidSchema.optional(),
    unfiled: queryBoolean.optional(),
    includeDescendants: queryBoolean.default(true),
    scope: z.enum(["library", "trash"]).default("library"),
    sort: z.enum(patternSorts).default("updated_desc"),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((query) => query.folderId === undefined || query.unfiled !== true, {
    message: "folderId and unfiled=true are mutually exclusive",
  });

export const patternPatchSchema = z
  .object({
    version: z.number().int().nonnegative(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine(hasNoNullByte)
      .optional(),
    isFavorite: z.boolean().optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.isFavorite !== undefined,
  );

export const patternMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  patch: patternPatchSchema,
});

export type PatternQuery = z.output<typeof patternQuerySchema>;
export type PatternQueryInput = z.input<typeof patternQuerySchema>;
export type PatternPatch = z.output<typeof patternPatchSchema>;

export function canonicalizePatternQuery(query: PatternQuery): PatternQuery {
  return {
    ...query,
    formats: canonicalizePatternFormats(query.formats) as PatternQuery["formats"],
    tagIds: canonicalizePatternTagIds(query.tagIds),
  };
}

export function parsePatternSearchParams(searchParams: URLSearchParams) {
  const formats = [
    ...searchParams.getAll("formats"),
    ...searchParams.getAll("format"),
  ];
  const tagIds = [
    ...searchParams.getAll("tagIds"),
    ...searchParams.getAll("tag"),
  ];
  const scalar = (name: string) => searchParams.get(name) ?? undefined;

  return canonicalizePatternQuery(patternQuerySchema.parse({
    q: scalar("q"),
    formats: formats.length > 0 ? formats : undefined,
    tagIds: tagIds.length > 0 ? tagIds : undefined,
    tagMode: scalar("tagMode"),
    untagged: scalar("untagged"),
    favorite: scalar("favorite"),
    previewStatus: scalar("previewStatus"),
    commercialState: scalar("commercialState"),
    authorizationField: scalar("authorizationField"),
    folderId: scalar("folderId"),
    unfiled: scalar("unfiled"),
    includeDescendants: scalar("includeDescendants"),
    scope: scalar("scope"),
    sort: scalar("sort"),
    cursor: scalar("cursor"),
    limit: scalar("limit"),
  }));
}
