import { z } from "zod";

import { AppError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

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

