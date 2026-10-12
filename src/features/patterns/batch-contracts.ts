import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { AppError, validationError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

export const patternRefSchema = z
  .object({
    id: normalizedUuidSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

const uniquePatternRefsSchema = z
  .array(patternRefSchema)
  .min(1)
  .max(100)
  .superRefine((patterns, context) => {
    if (new Set(patterns.map((pattern) => pattern.id)).size !== patterns.length) {
      context.addIssue({
        code: "custom",
        message: "Pattern IDs must be unique",
      });
    }
  });

export const patternBatchMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      operationId: publicOperationIdSchema,
      action: z.literal("move"),
      patterns: uniquePatternRefsSchema,
      folderId: normalizedUuidSchema.nullable(),
    })
    .strict(),
  z
    .object({
      operationId: publicOperationIdSchema,
      action: z.literal("trash"),
      patterns: uniquePatternRefsSchema,
    })
    .strict(),
  z
    .object({
      operationId: publicOperationIdSchema,
      action: z.literal("favorite"),
      patterns: uniquePatternRefsSchema,
      isFavorite: z.boolean(),
    })
    .strict(),
]);

export type PatternRefInput = z.input<typeof patternRefSchema>;
export type PatternRef = z.output<typeof patternRefSchema>;
export type PatternBatchMutationInput = z.input<
  typeof patternBatchMutationSchema
>;
export type PatternBatchMutation = z.output<typeof patternBatchMutationSchema>;

export function parsePatternBatchMutation(
  input: unknown,
): PatternBatchMutation {
  const parsed = patternBatchMutationSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  if (
    parsed.error.issues.some(
      (issue) => issue.code === "too_big" && issue.path[0] === "patterns",
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
