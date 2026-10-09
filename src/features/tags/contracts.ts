import { z } from "zod";

import { hasNoNullByte } from "@/lib/validation/text";

export const tagColorTokens = [
  "gray",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
] as const;

export const tagColorTokenSchema = z.enum(tagColorTokens);

const tagNameSchema = z
  .string()
  .trim()
  .transform((name) => name.normalize("NFC"))
  .pipe(z.string().min(1).max(32).refine(hasNoNullByte));

export const tagCreateSchema = z.object({
  name: tagNameSchema,
  colorToken: tagColorTokenSchema,
});

export const tagPatchSchema = z
  .object({
    name: tagNameSchema.optional(),
    colorToken: tagColorTokenSchema.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.colorToken !== undefined,
  );

export const tagCreateMutationSchema = z.object({
  operationId: z.string().uuid(),
  input: tagCreateSchema,
});

export const tagPatchMutationSchema = z.object({
  operationId: z.string().uuid(),
  patch: tagPatchSchema,
});

export const tagDeleteMutationSchema = z.object({
  operationId: z.string().uuid(),
});

export const patternTagMutationSchema = z.object({
  operationId: z.string().uuid(),
});

export type TagColorToken = z.output<typeof tagColorTokenSchema>;
export type TagPatch = z.output<typeof tagPatchSchema>;
