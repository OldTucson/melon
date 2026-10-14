import { z } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";

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

export const patternDeletionImpactRequestSchema = z
  .object({ patternIds: uniquePatternIdsSchema })
  .strict();

export const patternDeletionImpactSchema = z
  .object({
    activeAuthorizationCount: z.number().int().nonnegative(),
    activeRevenueFen: z.string().regex(/^(0|[1-9]\d*)$/),
    totalAuthorizationCount: z.number().int().nonnegative(),
    assetCount: z.number().int().nonnegative(),
    purgeOn: z.string().datetime(),
  })
  .strict()
  .superRefine((impact, context) => {
    if (
      impact.activeAuthorizationCount > impact.totalAuthorizationCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeAuthorizationCount"],
        message: "Active authorization count exceeds total count",
      });
    }
  });

export type PatternDeletionImpactRequest = z.output<
  typeof patternDeletionImpactRequestSchema
>;
export type PatternDeletionImpact = z.output<
  typeof patternDeletionImpactSchema
>;
