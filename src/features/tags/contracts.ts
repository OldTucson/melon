import { z } from "zod";

import { hasNoNullByte } from "@/lib/validation/text";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

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
  operationId: publicOperationIdSchema,
  input: tagCreateSchema,
});

export const tagPatchMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  patch: tagPatchSchema,
});

export const tagDeleteMutationSchema = z.object({
  operationId: publicOperationIdSchema,
});

export const patternTagMutationSchema = z.object({
  operationId: publicOperationIdSchema,
});

export type TagColorToken = z.output<typeof tagColorTokenSchema>;
export type TagPatch = z.output<typeof tagPatchSchema>;
