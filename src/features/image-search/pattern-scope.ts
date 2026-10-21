import "server-only";

import { z } from "zod";

import {
  canonicalizePatternFormats,
  canonicalizePatternTagIds,
  type PatternQuery,
} from "@/features/patterns/contracts";
import {
  listImageSearchPatternIds,
  listPatternRowsByIds,
} from "@/features/patterns/pattern-repository";
import { toPatternListItemDto } from "@/features/patterns/pattern-service";
import { AppError } from "@/lib/http/app-error";

import {
  imageSearchFiltersSchema,
  imageSearchMatchKindSchema,
  type ImageSearchFilters,
  type ImageSearchMatchKind,
} from "./contracts";

const rankedItemSchema = z.object({
  patternId: z.string().uuid(),
  kind: imageSearchMatchKindSchema,
});

const validationError = () =>
  new AppError("VALIDATION_ERROR", 400, "Invalid request");

export async function resolveImageSearchPatternIds(input: {
  ownerId: string;
  filters: ImageSearchFilters | z.input<typeof imageSearchFiltersSchema>;
}) {
  const parsed = imageSearchFiltersSchema.safeParse(input.filters);
  if (!parsed.success) throw validationError();
  const query: PatternQuery = {
    ...parsed.data,
    formats: canonicalizePatternFormats(parsed.data.formats) as PatternQuery["formats"],
    tagIds: [...new Set(canonicalizePatternTagIds(parsed.data.tagIds))],
    scope: "library",
    sort: "updated_desc",
    cursor: undefined,
    limit: 100,
  };
  return listImageSearchPatternIds(input.ownerId, query);
}

export async function hydrateRankedPatterns(input: {
  ownerId: string;
  items: readonly { patternId: string; kind: ImageSearchMatchKind }[];
}) {
  const parsed = z.array(rankedItemSchema).max(30).safeParse(input.items);
  if (!parsed.success) throw validationError();
  if (new Set(parsed.data.map((item) => item.patternId)).size !== parsed.data.length) {
    throw validationError();
  }
  const rows = await listPatternRowsByIds(
    input.ownerId,
    parsed.data.map((item) => item.patternId),
  );
  const kindById = new Map(
    parsed.data.map((item) => [item.patternId, item.kind]),
  );
  return rows.map((row) => ({
    ...toPatternListItemDto(row),
    matchKind: kindById.get(row.id)!,
  }));
}
