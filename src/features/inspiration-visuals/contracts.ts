import { z } from "zod";

import { paletteHexSchema } from "@/features/palette-search/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";
import { hasNoNullByte } from "@/lib/validation/text";

const displayText = (max: number) =>
  z.string().trim().min(1).max(max).refine(hasNoNullByte);

const localPathSchema = z
  .string()
  .min(2)
  .max(2048)
  .regex(/^\/(?!\/)[^\u0000-\u001f\u007f]+$/)
  .refine((value) => !value.includes("\\"));

const httpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  });

const ordinalSchema = z.number().int().min(0).max(100);
const directionIndexSchema = z.number().int().min(0).max(4);
const imageDimensionSchema = z.number().int().min(1).max(32_768);

const imageDimensions = {
  width: imageDimensionSchema,
  height: imageDimensionSchema,
};

function validatePixelBudget(
  value: { width: number; height: number },
  context: z.RefinementCtx,
) {
  if (value.width * value.height > 40_000_000) {
    context.addIssue({ code: "custom", message: "image pixel budget exceeded" });
  }
}

export const researchVisualMutationSchema = z
  .object({ operationId: publicOperationIdSchema })
  .strict();

export const visualWarningSchema = z.enum([
  "INSPIRATION_WEB_VISUALS_DISABLED",
  "INSPIRATION_WEB_VISUALS_UNAVAILABLE",
  "INSPIRATION_LIBRARY_MATCH_DISABLED",
  "INSPIRATION_LIBRARY_MATCH_EMPTY",
  "INSPIRATION_LIBRARY_MATCH_UNAVAILABLE",
]);

export const visualJobErrorCodeSchema = z.enum([
  "INSPIRATION_VISUALS_BUSY",
  "INSPIRATION_VISUALS_UNAVAILABLE",
  "INSPIRATION_VISUALS_EMPTY",
  "INSPIRATION_VISUALS_INTERRUPTED",
  "INSPIRATION_CONCEPT_DISABLED",
  "INSPIRATION_CONCEPT_LIMIT_REACHED",
  "INSPIRATION_CONCEPT_BUSY",
  "INSPIRATION_CONCEPT_REJECTED",
  "INSPIRATION_CONCEPT_TIMEOUT",
  "INSPIRATION_CONCEPT_UNAVAILABLE",
]);

export const inspirationVisualJobDtoSchema = z
  .object({
    id: normalizedUuidSchema,
    kind: z.enum(["research_visuals", "concept_image"]),
    directionIndex: directionIndexSchema.nullable(),
    status: z.enum(["pending", "completed", "failed"]),
    errorCode: visualJobErrorCodeSchema.nullable(),
    warnings: z.array(visualWarningSchema).max(5),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((job, context) => {
    if (
      (job.kind === "research_visuals" && job.directionIndex !== null) ||
      (job.kind === "concept_image" && job.directionIndex === null)
    ) {
      context.addIssue({ code: "custom", message: "invalid visual job target" });
    }

    const stateIsValid =
      job.status === "pending"
        ? job.completedAt === null && job.errorCode === null
        : job.status === "completed"
          ? job.completedAt !== null && job.errorCode === null
          : job.completedAt !== null && job.errorCode !== null;
    if (!stateIsValid) {
      context.addIssue({ code: "custom", message: "invalid visual job state" });
    }

    if (new Set(job.warnings).size !== job.warnings.length) {
      context.addIssue({ code: "custom", message: "duplicate visual warnings" });
    }
  });

const assetBaseShape = {
  id: normalizedUuidSchema,
  ordinal: ordinalSchema,
  title: displayText(300),
  altText: displayText(500),
  imageUrl: localPathSchema,
};

export const webEvidenceAssetDtoSchema = z
  .object({
    ...assetBaseShape,
    kind: z.literal("web_evidence"),
    sourcePageUrl: httpsUrlSchema,
    sourceSiteName: displayText(120),
    sourceQuery: displayText(300),
    ...imageDimensions,
  })
  .strict()
  .superRefine(validatePixelBudget);

const paletteSchema = z
  .array(paletteHexSchema)
  .max(5)
  .superRefine((colors, context) => {
    if (new Set(colors).size !== colors.length) {
      context.addIssue({ code: "custom", message: "duplicate palette colors" });
    }
  });

export const libraryMatchAssetDtoSchema = z
  .object({
    ...assetBaseShape,
    kind: z.literal("library_match"),
    directionIndex: directionIndexSchema.nullable(),
    libraryHref: localPathSchema,
    patternId: normalizedUuidSchema,
    palette: paletteSchema,
  })
  .strict();

export const generatedConceptAssetDtoSchema = z
  .object({
    ...assetBaseShape,
    kind: z.literal("generated_concept"),
    directionIndex: directionIndexSchema,
    ...imageDimensions,
    savedPatternId: normalizedUuidSchema.nullable(),
    libraryHref: localPathSchema.nullable(),
  })
  .strict()
  .superRefine((asset, context) => {
    validatePixelBudget(asset, context);
    if ((asset.savedPatternId === null) !== (asset.libraryHref === null)) {
      context.addIssue({
        code: "custom",
        message: "saved pattern ID and library link must be present together",
      });
    }
  });

export const publicGeneratedConceptAssetDtoSchema = z
  .object({
    id: normalizedUuidSchema,
    kind: z.literal("generated_concept"),
    ordinal: ordinalSchema,
    directionIndex: directionIndexSchema,
    title: displayText(300),
    altText: displayText(500),
    imageUrl: localPathSchema,
    ...imageDimensions,
  })
  .strict()
  .superRefine(validatePixelBudget);

const activeResearchJobSchema = inspirationVisualJobDtoSchema.refine(
  (job) => job.kind === "research_visuals" && job.status === "completed",
  { message: "active job must be completed research visuals" },
);

const refreshResearchJobSchema = inspirationVisualJobDtoSchema.refine(
  (job) => job.kind === "research_visuals" && job.status !== "completed",
  { message: "refresh job must be pending or failed research visuals" },
);

const conceptJobSchema = inspirationVisualJobDtoSchema.refine(
  (job) => job.kind === "concept_image" && job.status !== "completed",
  { message: "concept job must be pending or failed" },
);

export const inspirationVisualBoardDtoSchema = z
  .object({
    refreshAvailable: z.boolean(),
    activeJob: activeResearchJobSchema.nullable(),
    refreshJob: refreshResearchJobSchema.nullable(),
    webEvidence: z.array(webEvidenceAssetDtoSchema).max(8),
    libraryMatches: z.array(libraryMatchAssetDtoSchema).max(20),
    conceptJobs: z.array(conceptJobSchema).max(5),
    concepts: z.array(generatedConceptAssetDtoSchema).max(15),
  })
  .strict()
  .superRefine((board, context) => {
    const directionIndexes = board.conceptJobs.map(
      (job) => job.directionIndex,
    );
    if (new Set(directionIndexes).size !== directionIndexes.length) {
      context.addIssue({
        code: "custom",
        message: "only one concept job may be shown per direction",
      });
    }
  });

export const publicInspirationVisualBoardDtoSchema = z
  .object({
    webEvidence: z.array(webEvidenceAssetDtoSchema).max(8),
    concepts: z.array(publicGeneratedConceptAssetDtoSchema).max(15),
  })
  .strict();

export type ResearchVisualMutation = z.output<
  typeof researchVisualMutationSchema
>;
export type VisualWarning = z.output<typeof visualWarningSchema>;
export type VisualJobErrorCode = z.output<typeof visualJobErrorCodeSchema>;
export type InspirationVisualJobDto = z.output<
  typeof inspirationVisualJobDtoSchema
>;
export type WebEvidenceAssetDto = z.output<
  typeof webEvidenceAssetDtoSchema
>;
export type LibraryMatchAssetDto = z.output<
  typeof libraryMatchAssetDtoSchema
>;
export type GeneratedConceptAssetDto = z.output<
  typeof generatedConceptAssetDtoSchema
>;
export type InspirationVisualBoardDto = z.output<
  typeof inspirationVisualBoardDtoSchema
>;
export type PublicInspirationVisualBoardDto = z.output<
  typeof publicInspirationVisualBoardDtoSchema
>;
