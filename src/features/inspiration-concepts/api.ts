import { z } from "zod";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { readApiResponse } from "@/lib/query/client";
import {
  conceptRetryMutationSchema,
  conceptSetCreateMutationSchema,
  conceptSetDtoSchema,
  type ConceptSetCreateMutation,
  type ConceptRetryMutation,
  type ConceptSetDto,
} from "./contracts";

const path = (analysisId: string) =>
  `/api/inspiration-analyses/${encodeURIComponent(normalizedUuidSchema.parse(analysisId))}/concept-sets`;
const setPath = (analysisId: string, setId: string) =>
  `${path(analysisId)}/${encodeURIComponent(normalizedUuidSchema.parse(setId))}`;
const listSchema = z.array(conceptSetDtoSchema).max(15);
const readSet = async (response: Response) =>
  conceptSetDtoSchema.parse(await readApiResponse(response));
const post = (url: string, input: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export async function fetchConceptSets(
  analysisId: string,
  signal?: AbortSignal,
): Promise<ConceptSetDto[]> {
  return listSchema.parse(
    await readApiResponse(
      await fetch(path(analysisId), { signal, cache: "no-store" }),
    ),
  );
}
export async function createConceptSetRequest(
  analysisId: string,
  input: ConceptSetCreateMutation,
): Promise<ConceptSetDto> {
  return readSet(
    await post(path(analysisId), conceptSetCreateMutationSchema.parse(input)),
  );
}
export async function retryConceptOutputRequest(
  analysisId: string,
  setId: string,
  kind: "effect" | "flat",
  input: ConceptRetryMutation,
): Promise<ConceptSetDto> {
  const outputKind = z.enum(["effect", "flat"]).parse(kind);
  return readSet(
    await post(
      `${setPath(analysisId, setId)}/outputs/${outputKind}/retry`,
      conceptRetryMutationSchema.parse(input),
    ),
  );
}
export async function regenerateConceptSetRequest(
  analysisId: string,
  setId: string,
  input: ConceptRetryMutation,
): Promise<ConceptSetDto> {
  return readSet(
    await post(
      `${setPath(analysisId, setId)}/regenerate`,
      conceptRetryMutationSchema.parse(input),
    ),
  );
}
export async function deleteConceptSetRequest(
  analysisId: string,
  setId: string,
): Promise<void> {
  const response = await fetch(setPath(analysisId, setId), {
    method: "DELETE",
  });
  if (!response.ok) await readApiResponse(response);
}
