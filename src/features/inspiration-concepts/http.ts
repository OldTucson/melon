import "server-only";

import { z } from "zod";
import {
  parseInspirationRequest,
  readInspirationMutation,
} from "@/app/api/inspiration-analyses/input";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { AppError } from "@/lib/http/app-error";
import { withRoute } from "@/lib/http/route";
import { conceptSetDtoSchema } from "./contracts";

export const conceptSetParamsSchema = z
  .object({ analysisId: normalizedUuidSchema, setId: normalizedUuidSchema })
  .strict();
export const conceptRetryParamsSchema = conceptSetParamsSchema
  .extend({ outputKind: z.enum(["effect", "flat"]) })
  .strict();
export type ConceptSetContext = {
  params: Promise<{ analysisId: string; setId: string }>;
};
export type ConceptRetryContext = {
  params: Promise<{ analysisId: string; setId: string; outputKind: string }>;
};
export const conceptSetListSchema = z.array(conceptSetDtoSchema).max(15);
const invalid = () =>
  new AppError("INSPIRATION_INVALID_INPUT", 400, "Invalid inspiration request");

/** Count actual streamed bytes; Content-Length alone is not a trusted limit. */
async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const limit = 16_384;
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  )
    throw invalid();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw invalid();
      }
      chunks.push(value);
    }
  } catch {
    throw invalid();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function readConceptMutation<T>(
  schema: z.ZodType<T>,
  request: Request,
): Promise<T> {
  const bytes = await boundedBody(request);
  return readInspirationMutation(
    schema,
    new Request(request.url, { method: "POST", body: bytes }),
  );
}
export async function assertEmptyConceptBody(request: Request) {
  if ((await boundedBody(request)).byteLength) throw invalid();
}
export function conceptJson<T>(
  schema: z.ZodType<T>,
  input: unknown,
  status = 200,
) {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AppError("INTERNAL_ERROR", 500, "Internal server error");
  return Response.json(parsed.data, { status });
}

/** Include denials in the same private caching policy as successful owner data. */
export function withConceptRoute<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
) {
  const wrapped = withRoute(handler);
  return async (request: Request, context: Context) => {
    const response = await wrapped(request, context);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
}
export { parseInspirationRequest };
