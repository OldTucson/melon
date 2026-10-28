import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { readApiResponse } from "@/lib/query/client";

import {
  inspirationVisualBoardDtoSchema,
  researchVisualMutationSchema,
  type ResearchVisualMutation,
} from "./contracts";

const path = (analysisId: string) =>
  `/api/inspiration-analyses/${encodeURIComponent(
    normalizedUuidSchema.parse(analysisId),
  )}/visuals`;

const readBoard = async (response: Response | Promise<Response>) =>
  inspirationVisualBoardDtoSchema.parse(
    await readApiResponse(await response),
  );

export const inspirationVisualApi = {
  get: (analysisId: string, signal?: AbortSignal) =>
    readBoard(fetch(path(analysisId), { signal })),

  create: (analysisId: string, input: ResearchVisualMutation) =>
    readBoard(
      fetch(path(analysisId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(researchVisualMutationSchema.parse(input)),
      }),
    ),
};
