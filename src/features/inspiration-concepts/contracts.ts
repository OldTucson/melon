import { z } from "zod";

import { inspirationPromptSchema } from "@/features/inspiration/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

const localPathSchema = z.string().min(2).max(2048)
  .regex(/^\/(?!\/)[^\u0000-\u001f\u007f]+$/)
  .refine((value) => !value.includes("\\"));

export const conceptOutputKindSchema = z.enum(["sketch", "effect", "flat"]);
export const conceptSetStatusSchema = z.enum(["queued", "generating", "partial", "completed", "failed"]);
export const conceptTaskPublicStatusSchema = z.enum(["queued", "generating", "failed"]);

export const conceptSetCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  directionIndex: z.number().int().min(0).max(4),
  visualJobId: normalizedUuidSchema.nullable(),
  referenceAssetIds: z.array(normalizedUuidSchema).max(3),
}).strict().superRefine((value, context) => {
  if (new Set(value.referenceAssetIds).size !== value.referenceAssetIds.length) {
    context.addIssue({ code: "custom", path: ["referenceAssetIds"], message: "duplicate reference" });
  }
  if (value.referenceAssetIds.length > 0 && value.visualJobId === null) {
    context.addIssue({ code: "custom", path: ["visualJobId"], message: "visual job is required" });
  }
});

export const conceptRetryMutationSchema = z.object({
  operationId: publicOperationIdSchema,
}).strict();

export const conceptErrorCodeSchema = z.enum([
  "INSPIRATION_CONCEPT_DISABLED",
  "INSPIRATION_CONCEPT_BUSY",
  "INSPIRATION_CONCEPT_LIMIT_REACHED",
  "INSPIRATION_CONCEPT_REFERENCES_STALE",
  "INSPIRATION_CONCEPT_REFERENCE_INVALID",
  "INSPIRATION_CONCEPT_REJECTED",
  "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
  "INSPIRATION_CONCEPT_TIMEOUT",
  "INSPIRATION_CONCEPT_IMPORT_FAILED",
  "INSPIRATION_CONCEPT_UNAVAILABLE",
]);

export const inspirationConceptBriefSchema = z.object({
  schemaVersion: z.literal("inspiration-concept-brief-v1"),
  report: z.object({
    headline: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(2_000),
    marketSignals: z.array(z.object({
      name: z.string().trim().min(1).max(80),
      rationale: z.string().trim().min(1).max(500),
      strength: z.enum(["high", "medium", "emerging"]),
    }).strict()).max(5),
  }).strict(),
  directionIndex: z.number().int().min(0).max(4),
  direction: inspirationPromptSchema,
  referenceAssetIds: z.array(normalizedUuidSchema).max(3),
  promptTemplateVersion: z.literal("inspiration-concept-prompts-v1"),
  model: z.literal("qwen-image-3.0-pro"),
  sizes: z.object({
    sketch: z.literal("1536*2048"),
    effect: z.literal("1536*2048"),
    flat: z.literal("2048*1536"),
  }).strict(),
}).strict();

export const conceptOutputAssetDtoSchema = z.object({
  id: normalizedUuidSchema,
  kind: conceptOutputKindSchema,
  title: z.string().trim().min(1).max(300),
  altText: z.string().trim().min(1).max(500),
  imageUrl: localPathSchema,
  width: z.number().int().min(1).max(2_048),
  height: z.number().int().min(1).max(2_048),
  createdAt: z.string().datetime(),
}).strict().superRefine((asset, context) => {
  const expected = asset.kind === "flat"
    ? { width: 2_048, height: 1_536 }
    : { width: 1_536, height: 2_048 };
  if (asset.width !== expected.width || asset.height !== expected.height) {
    context.addIssue({ code: "custom", message: "invalid concept output dimensions" });
  }
});

const slotSchema = z.object({
  kind: conceptOutputKindSchema,
  asset: conceptOutputAssetDtoSchema.nullable(),
  task: z.object({
    status: conceptTaskPublicStatusSchema,
    errorCode: conceptErrorCodeSchema.nullable(),
  }).strict().nullable(),
}).strict();

const conceptSetDtoBase = z.object({
  id: normalizedUuidSchema,
  directionIndex: z.number().int().min(0).max(4),
  version: z.number().int().min(1).max(2_147_483_647),
  status: conceptSetStatusSchema,
  slots: z.tuple([slotSchema, slotSchema, slotSchema]),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export const conceptSetDtoSchema = conceptSetDtoBase.superRefine(assertSlotOrderAndState);

function assertSlotOrderAndState(value: z.infer<typeof conceptSetDtoBase>, context: z.RefinementCtx) {
  const expected = ["sketch", "effect", "flat"] as const;
  value.slots.forEach((slot, index) => {
    if (slot.kind !== expected[index] || (slot.asset && slot.asset.kind !== slot.kind)) {
      context.addIssue({ code: "custom", path: ["slots", index], message: "invalid slot order" });
    }
  });
  const active = value.slots.some(({ task }) => task?.status === "queued" || task?.status === "generating");
  if ((value.status === "queued" || value.status === "generating") !== active) {
    context.addIssue({ code: "custom", path: ["status"], message: "invalid active set status" });
  }
}

export const publicConceptSetDtoSchema = z.object({
  id: normalizedUuidSchema,
  directionIndex: z.number().int().min(0).max(4),
  version: z.number().int().min(1).max(2_147_483_647),
  outputs: z.array(conceptOutputAssetDtoSchema).min(1).max(3),
  createdAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (new Set(value.outputs.map(({ kind }) => kind)).size !== value.outputs.length) {
    context.addIssue({ code: "custom", path: ["outputs"], message: "duplicate output kind" });
  }
});

export type ConceptSetCreateMutation = z.infer<typeof conceptSetCreateMutationSchema>;

export type ConceptRetryMutation = z.infer<typeof conceptRetryMutationSchema>;

export type ConceptOutputKind = z.infer<typeof conceptOutputKindSchema>;

export type ConceptOutputAssetDto = z.infer<typeof conceptOutputAssetDtoSchema>;

export type ConceptSetDto = z.infer<typeof conceptSetDtoSchema>;

export type PublicConceptSetDto = z.infer<typeof publicConceptSetDtoSchema>;

export type InspirationConceptBrief = z.infer<typeof inspirationConceptBriefSchema>;

export type ConceptErrorCode = z.infer<typeof conceptErrorCodeSchema>;
