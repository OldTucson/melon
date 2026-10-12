import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { AppError, validationError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

const uniquePatternIdsSchema = z
  .array(normalizedUuidSchema)
  .min(1)
  .max(100)
  .superRefine((patternIds, context) => {
    if (new Set(patternIds).size !== patternIds.length) {
      context.addIssue({
        code: "custom",
        message: "Pattern IDs must be unique",
      });
    }
  });

const patternTrashMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  patternIds: uniquePatternIdsSchema,
});

export const patternRestoreMutationSchema = patternTrashMutationSchema;
export const patternPurgeMutationSchema = patternTrashMutationSchema;

const folderBatchMutationSchema = z.object({
  operationId: publicOperationIdSchema,
});

export const folderBatchRestoreMutationSchema = folderBatchMutationSchema;
export const folderBatchPurgeMutationSchema = folderBatchMutationSchema;

export type PatternRestoreMutationInput = z.input<
  typeof patternRestoreMutationSchema
>;
export type PatternRestoreMutation = z.output<
  typeof patternRestoreMutationSchema
>;
export type PatternPurgeMutationInput = z.input<
  typeof patternPurgeMutationSchema
>;
export type PatternPurgeMutation = z.output<typeof patternPurgeMutationSchema>;
export type FolderBatchRestoreMutationInput = z.input<
  typeof folderBatchRestoreMutationSchema
>;
export type FolderBatchRestoreMutation = z.output<
  typeof folderBatchRestoreMutationSchema
>;
export type FolderBatchPurgeMutationInput = z.input<
  typeof folderBatchPurgeMutationSchema
>;
export type FolderBatchPurgeMutation = z.output<
  typeof folderBatchPurgeMutationSchema
>;

function parsePatternTrashMutation(
  input: unknown,
): PatternRestoreMutation | PatternPurgeMutation {
  const parsed = patternTrashMutationSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  if (
    parsed.error.issues.some(
      (issue) =>
        issue.code === "too_big" &&
        issue.path.length === 1 &&
        issue.path[0] === "patternIds",
    )
  ) {
    throw new AppError(
      "BATCH_LIMIT_EXCEEDED",
      400,
      "A batch can contain at most 100 patterns",
    );
  }

  throw validationError();
}

export function parsePatternRestoreMutation(
  input: unknown,
): PatternRestoreMutation {
  return parsePatternTrashMutation(input);
}

export function parsePatternPurgeMutation(
  input: unknown,
): PatternPurgeMutation {
  return parsePatternTrashMutation(input);
}

export function parseFolderBatchRestoreMutation(
  input: unknown,
): FolderBatchRestoreMutation {
  const parsed = folderBatchRestoreMutationSchema.safeParse(input);
  if (!parsed.success) throw validationError();
  return parsed.data;
}

export function parseFolderBatchPurgeMutation(
  input: unknown,
): FolderBatchPurgeMutation {
  const parsed = folderBatchPurgeMutationSchema.safeParse(input);
  if (!parsed.success) throw validationError();
  return parsed.data;
}
