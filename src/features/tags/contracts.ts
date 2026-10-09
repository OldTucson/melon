import { z } from "zod";

export const tagColorTokens = [
  "gray",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
] as const;

export const tagColorTokenSchema = z.enum(tagColorTokens);

export const tagCreateSchema = z.object({
  name: z.string().trim().min(1).max(32),
  colorToken: tagColorTokenSchema,
});

export const tagPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(32).optional(),
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

export type TagColorToken = z.output<typeof tagColorTokenSchema>;
export type TagPatch = z.output<typeof tagPatchSchema>;
