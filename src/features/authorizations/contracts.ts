import { z } from "zod";

import { AppError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";
import { normalizedUuidSchema } from "@/features/storage/identifiers";

export const authorizationKindSchema = z.enum([
  "standard",
  "field_exclusive",
  "global_buyout",
]);

const authorizationDetailsSchema = z
  .object({
    kind: authorizationKindSchema,
    fieldId: normalizedUuidSchema.nullable(),
    licenseeName: z
      .string()
      .trim()
      .transform((value) => value.normalize("NFKC"))
      .pipe(z.string().min(1).max(100)),
    priceYuan: z.string().trim(),
    authorizedOn: z.string(),
    note: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .transform((value) => (value === "" ? null : value)),
    historyConfirmed: z.boolean().default(false),
  })
  .superRefine((value, context) => {
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
  });

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

export type AuthorizationDetails = z.output<typeof authorizationDetailsSchema>;

export const authorizationFieldCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  name: z.string(),
});

export const authorizationFieldArchiveMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  fieldId: z.string().uuid(),
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
