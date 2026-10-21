import "server-only";

import { AppError } from "@/lib/http/app-error";

import {
  imageSearchMatchKinds,
  internalImageSearchResponseSchema,
  type ImageSearchFiltersInput,
} from "./contracts";
import {
  getInternalImageSearchClient,
  type InternalImageSearchClient,
} from "./internal-client";
import {
  hydrateRankedPatterns,
  resolveImageSearchPatternIds,
} from "./pattern-scope";

type SearchInput = {
  ownerId: string;
  image: File;
  filters: ImageSearchFiltersInput;
  requestId: string;
  signal: AbortSignal;
};

type SearchDependencies = {
  client?: InternalImageSearchClient;
  now?: () => number;
};

const unavailable = () =>
  new AppError(
    "IMAGE_SEARCH_UNAVAILABLE",
    503,
    "Image search is unavailable",
  );

export async function searchPatternsByImage(
  input: SearchInput,
  dependencies: SearchDependencies = {},
) {
  const now = dependencies.now ?? performance.now.bind(performance);
  const startedAt = now();
  const allowedPatternIds = await resolveImageSearchPatternIds({
    ownerId: input.ownerId,
    filters: input.filters,
  });
  const allowed = new Set(allowedPatternIds);
  const client = dependencies.client ?? getInternalImageSearchClient();
  const rawResponse = await client.search({
    ownerId: input.ownerId,
    image: input.image,
    allowedPatternIds,
    requestId: input.requestId,
    signal: input.signal,
  });
  const parsed = internalImageSearchResponseSchema.safeParse(rawResponse);
  if (!parsed.success || parsed.data.requestId !== input.requestId) {
    throw unavailable();
  }
  if (parsed.data.items.some((item) => !allowed.has(item.patternId))) {
    throw unavailable();
  }

  const hydrated = await hydrateRankedPatterns({
    ownerId: input.ownerId,
    items: parsed.data.items,
  });
  if (
    hydrated.length !== parsed.data.items.length ||
    hydrated.some((item, index) => item.id !== parsed.data.items[index]?.patternId)
  ) {
    throw unavailable();
  }

  const groups = imageSearchMatchKinds.flatMap((kind) => {
    const items = hydrated.filter((item) => item.matchKind === kind);
    return items.length > 0 ? [{ kind, items }] : [];
  });
  return {
    query: parsed.data.query,
    groups,
    timing: { totalMs: Math.max(0, Math.round(now() - startedAt)) },
  };
}
