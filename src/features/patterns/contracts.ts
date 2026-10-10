import { z } from "zod";

import { hasNoNullByte } from "@/lib/validation/text";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

export const patternFormats = [
  "psd",
  "ai",
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

const queryBoolean = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);

export const patternQuerySchema = z.object({
  q: z.string().trim().max(100).refine(hasNoNullByte).optional(),
  formats: z.array(z.enum(patternFormats)).max(6).default([]),
  tagIds: z.array(z.string().uuid()).max(20).default([]),
  tagMode: z.enum(["all", "any"]).default("all"),
  untagged: queryBoolean.optional(),
  favorite: queryBoolean.optional(),
  previewStatus: z
    .enum(["pending", "ready", "unsupported", "failed", "manual"])
    .optional(),
  sort: z.enum(patternSorts).default("updated_desc"),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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

  return patternQuerySchema.parse({
    q: scalar("q"),
    formats: formats.length > 0 ? formats : undefined,
    tagIds: tagIds.length > 0 ? tagIds : undefined,
    tagMode: scalar("tagMode"),
    untagged: scalar("untagged"),
    favorite: scalar("favorite"),
    previewStatus: scalar("previewStatus"),
    sort: scalar("sort"),
    cursor: scalar("cursor"),
    limit: scalar("limit"),
  });
}
