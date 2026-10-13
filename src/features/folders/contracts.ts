import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";
import { hasNoNullByte } from "@/lib/validation/text";

export const folderNameInputSchema = z
  .string()
  .trim()
  .transform((name) => name.normalize("NFC"))
  .pipe(z.string().min(1).max(80).refine(hasNoNullByte));

export function parseFolderName(input: string) {
  const name = folderNameInputSchema.parse(input);
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

export const folderDeleteImpactSchema = z
  .object({
    folderCount: z.number().int().positive(),
    patternCount: z.number().int().nonnegative(),
    alreadyTrashedFolderCount: z.number().int().nonnegative(),
    alreadyTrashedPatternCount: z.number().int().nonnegative(),
    hasDeletingEntities: z.boolean(),
    scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((impact, context) => {
    if (impact.alreadyTrashedFolderCount > impact.folderCount) {
      context.addIssue({
        code: "custom",
        path: ["alreadyTrashedFolderCount"],
        message: "Trashed folder count exceeds folder count",
      });
    }
    if (impact.alreadyTrashedPatternCount > impact.patternCount) {
      context.addIssue({
        code: "custom",
        path: ["alreadyTrashedPatternCount"],
        message: "Trashed pattern count exceeds pattern count",
      });
    }
  });

export const folderTrashMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  version: z.number().int().nonnegative(),
  expectedImpact: folderDeleteImpactSchema,
});

export type FolderCreateMutationInput = z.input<
  typeof folderCreateMutationSchema
>;
export type FolderCreateMutation = z.output<typeof folderCreateMutationSchema>;
export type FolderRenameMutationInput = z.input<
  typeof folderRenameMutationSchema
>;
export type FolderRenameMutation = z.output<typeof folderRenameMutationSchema>;
export type FolderDeleteImpact = z.output<typeof folderDeleteImpactSchema>;
export type FolderTrashMutationInput = z.input<
  typeof folderTrashMutationSchema
>;
export type FolderTrashMutation = z.output<typeof folderTrashMutationSchema>;
