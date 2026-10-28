import { z } from "zod";

import { inspirationListQuerySchema } from "@/features/inspiration/contracts";
import { decodeInspirationCursor } from "@/features/inspiration/inspiration-cursor";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { AppError } from "@/lib/http/app-error";
import { readJson } from "@/lib/http/route";

export type InspirationRouteContext = {
  params: Promise<{ analysisId: string }>;
};

export const inspirationParamsSchema = z.object({
  analysisId: normalizedUuidSchema,
}).strict();

const listQuerySchema = inspirationListQuerySchema.refine(({ cursor }) => {
  if (cursor === undefined) return true;
  try {
    decodeInspirationCursor(cursor);
    return true;
  } catch {
    return false;
  }
});

const invalidRequest = () => new AppError(
  "INSPIRATION_INVALID_INPUT",
  400,
  "Invalid inspiration request",
);

export function parseInspirationRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

export async function readInspirationMutation<T>(schema: z.ZodType<T>, request: Request): Promise<T> {
  let input: unknown;
  try {
    input = await readJson(request);
  } catch {
    throw invalidRequest();
  }
  return parseInspirationRequest(schema, input);
}

export function parseInspirationListQuery(searchParams: URLSearchParams) {
  const query = Object.fromEntries([...new Set(searchParams.keys())].map((key) => {
    const values = searchParams.getAll(key);
    return [key, values.length === 1 ? values[0] : values];
  }));
  return parseInspirationRequest(listQuerySchema, query);
}
