import { z, ZodError } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { AppError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

export const MAX_MANUAL_PREVIEW_SIZE_BYTES = 20 * 1024 * 1024;
export const manualPreviewExtensions = ["png", "webp"] as const;

export const manualPreviewInitSchema = z
  .object({
    operationId: publicOperationIdSchema,
    version: z.number().int().nonnegative(),
    extension: z.enum(manualPreviewExtensions),
  })
  .strict();

const manualAssetBase = {
  assetId: normalizedUuidSchema,
  objectKey: z.string().min(1),
  extension: z.enum(manualPreviewExtensions),
  sizeBytes: z.number().int().positive().max(MAX_MANUAL_PREVIEW_SIZE_BYTES),
};

const manualPreviewRoleSchema = z
  .object({
    ...manualAssetBase,
    role: z.literal("preview"),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
  })
  .strict();

const manualThumbnailAssetSchema = z
  .object({
    ...manualAssetBase,
    role: z.literal("thumbnail"),
    width: z.number().int().positive().max(512),
    height: z.number().int().positive().max(512),
  })
  .strict();

export const manualPreviewAssetSchema = z.discriminatedUnion("role", [
  manualPreviewRoleSchema,
  manualThumbnailAssetSchema,
]);

export const manualPreviewCompleteSchema = z
  .object({
    operationId: publicOperationIdSchema,
    version: z.number().int().nonnegative(),
    assets: z.array(manualPreviewAssetSchema).length(2),
  })
  .strict();

export const manualPreviewCancelSchema = z
  .object({ operationId: publicOperationIdSchema })
  .strict();

function invalidManualPreview(): never {
  throw new AppError(
    "MANUAL_PREVIEW_INVALID",
    422,
    "Manual preview declaration is invalid",
  );
}

export function parseManualPreviewInit(input: unknown) {
  try {
    return manualPreviewInitSchema.parse(input);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ZodError) invalidManualPreview();
    throw error;
  }
}

export function parseManualPreviewComplete(input: unknown) {
  let parsed: z.output<typeof manualPreviewCompleteSchema>;
  try {
    parsed = manualPreviewCompleteSchema.parse(input);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ZodError) invalidManualPreview();
    throw error;
  }
  const roles = parsed.assets.map((asset) => asset.role);
  const ids = parsed.assets.map((asset) => asset.assetId);
  const extensions = parsed.assets.map((asset) => asset.extension);
  if (
    new Set(roles).size !== 2 ||
    !roles.includes("preview") ||
    !roles.includes("thumbnail") ||
    new Set(ids).size !== 2 ||
    new Set(extensions).size !== 1
  ) {
    invalidManualPreview();
  }
  return parsed;
}

export function parseManualPreviewCancel(input: unknown) {
  try {
    return manualPreviewCancelSchema.parse(input);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ZodError) invalidManualPreview();
    throw error;
  }
}

export type ManualPreviewInitInput = z.output<typeof manualPreviewInitSchema>;
export type ManualPreviewCompleteInput = z.output<
  typeof manualPreviewCompleteSchema
>;
export type ManualPreviewCancelInput = z.output<
  typeof manualPreviewCancelSchema
>;
export type ManualPreviewAsset = z.output<typeof manualPreviewAssetSchema>;
