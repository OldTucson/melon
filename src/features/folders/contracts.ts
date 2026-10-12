import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";
import { hasNoNullByte } from "@/lib/validation/text";

export const folderNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(hasNoNullByte);

export function parseFolderName(input: string) {
  const name = folderNameInputSchema.parse(input).normalize("NFC");
  return { name, normalizedName: name.toLowerCase() };
}

export const folderCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  input: z.object({
    name: folderNameInputSchema,
    parentId: normalizedUuidSchema.nullable(),
  }),
});

export const folderRenameMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  patch: z.object({
    name: folderNameInputSchema,
    version: z.number().int().nonnegative(),
  }),
});

export const folderTrashMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  version: z.number().int().nonnegative(),
});

export type FolderCreateMutationInput = z.input<
  typeof folderCreateMutationSchema
>;
export type FolderCreateMutation = z.output<typeof folderCreateMutationSchema>;
export type FolderRenameMutationInput = z.input<
  typeof folderRenameMutationSchema
>;
export type FolderRenameMutation = z.output<typeof folderRenameMutationSchema>;
export type FolderTrashMutationInput = z.input<
  typeof folderTrashMutationSchema
>;
export type FolderTrashMutation = z.output<typeof folderTrashMutationSchema>;
