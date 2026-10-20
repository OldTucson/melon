import { z, ZodError } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { AppError, validationError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

export const MAX_UPLOAD_SIZE_BYTES = 209_715_200;

export const uploadSourceExtensions = [
  "psd",
  "ai",
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "procreate",
] as const;
export const uploadDerivedExtensions = ["jpg", "jpeg", "png", "webp"] as const;
export const uploadAssetRoles = ["source", "preview", "thumbnail"] as const;

export type UploadSourceExtension = (typeof uploadSourceExtensions)[number];
export type UploadDerivedExtension = (typeof uploadDerivedExtensions)[number];
export type UploadAssetRole = (typeof uploadAssetRoles)[number];

const safeOriginalFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f/\\]/.test(value));

export const uploadInitSchema = z
  .object({
    patternId: normalizedUuidSchema,
    sourceAssetId: normalizedUuidSchema,
    operationId: publicOperationIdSchema,
    originalFilename: safeOriginalFilenameSchema,
    extension: z.enum(uploadSourceExtensions),
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
    lastModified: z.number().int().nonnegative(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();

const sourceCompletionAssetSchema = z
  .object({
    assetId: normalizedUuidSchema,
    role: z.literal("source"),
    objectKey: z.string().min(1),
    extension: z.enum(uploadSourceExtensions),
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
  })
  .strict();

const derivedCompletionAssetBase = {
  assetId: normalizedUuidSchema,
  objectKey: z.string().min(1),
  extension: z.enum(uploadDerivedExtensions),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
};

const previewCompletionAssetSchema = z
  .object({
    ...derivedCompletionAssetBase,
    role: z.literal("preview"),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
  })
  .strict();

const thumbnailCompletionAssetSchema = z
  .object({
    ...derivedCompletionAssetBase,
    role: z.literal("thumbnail"),
    width: z.number().int().positive().max(512),
    height: z.number().int().positive().max(512),
  })
  .strict();

export const uploadCompletionAssetSchema = z.discriminatedUnion("role", [
  sourceCompletionAssetSchema,
  previewCompletionAssetSchema,
  thumbnailCompletionAssetSchema,
]);

export const uploadCompleteSchema = z
  .object({
    operationId: publicOperationIdSchema,
    assets: z.array(uploadCompletionAssetSchema).min(1).max(3),
  })
  .strict();

export const uploadCredentialsSchema = z
  .object({ operationId: publicOperationIdSchema })
  .strict();

export const uploadCancelSchema = z
  .object({
    operationId: publicOperationIdSchema,
    multipartAbort: z
      .object({
        attempted: z.boolean(),
        succeeded: z.boolean(),
      })
      .strict()
      .refine((value) => value.attempted || !value.succeeded)
      .optional(),
  })
  .strict();

export type UploadInitInput = z.output<typeof uploadInitSchema>;
export type UploadCompleteInput = z.output<typeof uploadCompleteSchema>;
export type UploadCompletionAsset = z.output<
  typeof uploadCompletionAssetSchema
>;
export type UploadCredentialsInput = z.output<typeof uploadCredentialsSchema>;
export type UploadCancelInput = z.output<typeof uploadCancelSchema>;

function parseOrValidationError<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ZodError) throw validationError();
    throw error;
  }
}

function rawField(input: unknown, key: string) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return (input as Record<string, unknown>)[key];
}

function filenameMatchesExtension(filename: string, extension: UploadSourceExtension) {
  const suffix = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "jpg" || extension === "jpeg") {
    return suffix === "jpg" || suffix === "jpeg";
  }
  return suffix === extension;
}

function invalidUploadObject(): never {
  throw new AppError(
    "UPLOAD_OBJECT_INVALID",
    422,
    "Upload object declaration is invalid",
  );
}

export function parseUploadInit(input: unknown): UploadInitInput {
  const sizeBytes = rawField(input, "sizeBytes");
  if (
    typeof sizeBytes === "number" &&
    Number.isFinite(sizeBytes) &&
    sizeBytes > MAX_UPLOAD_SIZE_BYTES
  ) {
    throw new AppError(
      "UPLOAD_FILE_TOO_LARGE",
      413,
      "Upload file is too large",
    );
  }

  const extension = rawField(input, "extension");
  if (
    typeof extension === "string" &&
    !(uploadSourceExtensions as readonly string[]).includes(extension)
  ) {
    throw new AppError(
      "UPLOAD_EXTENSION_UNSUPPORTED",
      415,
      "Upload extension is unsupported",
    );
  }

  const parsed = parseOrValidationError(() => uploadInitSchema.parse(input));
  if (!filenameMatchesExtension(parsed.originalFilename, parsed.extension)) {
    invalidUploadObject();
  }
  return parsed;
}

export function parseUploadComplete(input: unknown): UploadCompleteInput {
  const assets = rawField(input, "assets");
  if (Array.isArray(assets)) {
    const hasOversizedAsset = assets.some((asset) => {
      const sizeBytes = rawField(asset, "sizeBytes");
      return (
        typeof sizeBytes === "number" &&
        Number.isFinite(sizeBytes) &&
        sizeBytes > MAX_UPLOAD_SIZE_BYTES
      );
    });
    if (hasOversizedAsset) {
      throw new AppError(
        "UPLOAD_FILE_TOO_LARGE",
        413,
        "Upload file is too large",
      );
    }
    const roles = assets.map((asset) => rawField(asset, "role"));
    const assetIds = assets.map((asset) => rawField(asset, "assetId"));
    const hasUnsupportedDerivedExtension = assets.some((asset) => {
      const role = rawField(asset, "role");
      const extension = rawField(asset, "extension");
      return (
        (role === "preview" || role === "thumbnail") &&
        typeof extension === "string" &&
        !(uploadDerivedExtensions as readonly string[]).includes(extension)
      );
    });
    const hasUnsupportedSourceExtension = assets.some((asset) => {
      const role = rawField(asset, "role");
      const extension = rawField(asset, "extension");
      return (
        role === "source" &&
        typeof extension === "string" &&
        !(uploadSourceExtensions as readonly string[]).includes(extension)
      );
    });
    const hasInvalidDimensions = assets.some((asset) => {
      const role = rawField(asset, "role");
      const width = rawField(asset, "width");
      const height = rawField(asset, "height");
      if (role !== "preview" && role !== "thumbnail") return false;
      const limit = role === "preview" ? 2048 : 512;
      return (
        (typeof width === "number" && width > limit) ||
        (typeof height === "number" && height > limit)
      );
    });
    if (
      roles.filter((role) => role === "source").length !== 1 ||
      new Set(roles).size !== roles.length ||
      new Set(assetIds).size !== assetIds.length
    ) {
      invalidUploadObject();
    }
    if (hasUnsupportedDerivedExtension || hasUnsupportedSourceExtension) {
      throw new AppError(
        "UPLOAD_EXTENSION_UNSUPPORTED",
        415,
        "Upload extension is unsupported",
      );
    }
    if (hasInvalidDimensions) invalidUploadObject();
  }

  const parsed = parseOrValidationError(() => uploadCompleteSchema.parse(input));
  const normalizedIds = parsed.assets.map((asset) => asset.assetId);
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    invalidUploadObject();
  }
  return parsed;
}

export const parseUploadCredentials = (input: unknown) =>
  parseOrValidationError(() => uploadCredentialsSchema.parse(input));

export const parseUploadCancel = (input: unknown) =>
  parseOrValidationError(() => uploadCancelSchema.parse(input));
