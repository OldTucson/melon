import { z } from "zod";

import { AppError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";
import { normalizedUuidSchema } from "@/features/storage/identifiers";

import { parseRmbToFen } from "./money";

export const authorizationKindSchema = z.enum([
  "standard",
  "field_exclusive",
  "global_buyout",
]);

const priceYuanSchema = z
  .string()
  .trim()
  .transform((value) => {
    parseRmbToFen(value);
    return value;
  });

const authorizationDetailsShape = {
  kind: authorizationKindSchema,
  fieldId: normalizedUuidSchema.nullable(),
  licenseeName: z
    .string()
    .trim()
    .transform((value) => value.normalize("NFKC"))
    .pipe(z.string().min(1).max(100)),
  priceYuan: priceYuanSchema,
  authorizedOn: z.iso.date(),
  note: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .transform((value) => (value === "" ? null : value)),
  historyConfirmed: z.boolean().default(false),
};

function validateKindField(
  value: { kind: z.output<typeof authorizationKindSchema>; fieldId: string | null },
  context: z.RefinementCtx,
) {
  if (value.kind === "global_buyout" && value.fieldId !== null) {
    context.addIssue({
      code: "custom",
      path: ["fieldId"],
      message: "Global buyout cannot select a field",
    });
  }
  if (value.kind !== "global_buyout" && value.fieldId === null) {
    context.addIssue({
      code: "custom",
      path: ["fieldId"],
      message: "Authorization field is required",
    });
  }
}

export const authorizationDetailsSchema = z
  .object(authorizationDetailsShape)
  .superRefine(validateKindField);

export const authorizationCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  commercialVersion: z.number().int().nonnegative(),
  details: authorizationDetailsSchema,
});

export const authorizationEditMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  version: z.number().int().nonnegative(),
  commercialVersion: z.number().int().nonnegative(),
  details: authorizationDetailsSchema,
});

export const authorizationStatusMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  version: z.number().int().nonnegative(),
  commercialVersion: z.number().int().nonnegative(),
});

export const authorizationCreateRequestSchema = z
  .object({
    operationId: publicOperationIdSchema,
    commercialVersion: z.number().int().nonnegative(),
    ...authorizationDetailsShape,
  })
  .superRefine(validateKindField);

export const authorizationEditRequestSchema = z
  .object({
    operationId: publicOperationIdSchema,
    version: z.number().int().nonnegative(),
    commercialVersion: z.number().int().nonnegative(),
    ...authorizationDetailsShape,
  })
  .superRefine(validateKindField);

const queryBoolean = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);

export const authorizationHistoryQuerySchema = z.object({
  includeVoid: queryBoolean.default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});

export const authorizationFieldListQuerySchema = z.object({
  includeArchived: queryBoolean.default(false),
});

export const patternAuthorizationParamsSchema = z.object({
  patternId: normalizedUuidSchema,
});

export const authorizationParamsSchema = z.object({
  authorizationId: normalizedUuidSchema,
});

export const authorizationFieldParamsSchema = z.object({
  fieldId: normalizedUuidSchema,
});

export type AuthorizationDetails = z.output<typeof authorizationDetailsSchema>;

export const authorizationFieldCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  name: z.string(),
});

export const authorizationFieldArchiveMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  fieldId: z.string().uuid(),
});

export const authorizationFieldArchiveRequestSchema = z.object({
  operationId: publicOperationIdSchema,
});

export function normalizeAuthorizationFieldName(input: string) {
  const name = input.trim().normalize("NFKC");
  const characterCount = [...name].length;

  if (characterCount < 1 || characterCount > 32 || name.includes("\0")) {
    throw new AppError(
      "AUTHORIZATION_FIELD_NAME_INVALID",
      400,
      "Authorization field name is invalid",
    );
  }

  return {
    name,
    normalizedName: name.toLocaleLowerCase("und"),
  };
}
