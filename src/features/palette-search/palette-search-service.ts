import "server-only";

import {
  hydratePatternIdsInOrder,
  resolveImageSearchPatternIds,
} from "@/features/image-search/pattern-scope";
import { AppError } from "@/lib/http/app-error";

import {
  internalPaletteSearchResponseSchema,
  paletteSearchRequestSchema,
  type PaletteSearchRequest,
} from "./contracts";
import {
  getInternalPaletteSearchClient,
  type InternalPaletteSearchClient,
} from "./internal-client";

type SearchInput = Omit<PaletteSearchRequest, "colors"> & {
  ownerId: string;
  colors: readonly string[];
  signal: AbortSignal;
};

type SearchDependencies = {
  client?: InternalPaletteSearchClient;
  now?: () => number;
};

const invalidColors = () =>
  new AppError(
    "PALETTE_SEARCH_INVALID_COLORS",
    400,
    "Invalid palette colors",
  );

const noIndex = () =>
  new AppError(
    "PALETTE_SEARCH_NO_INDEX",
    409,
    "No searchable palette index",
  );

const unavailable = () =>
  new AppError(
    "PALETTE_SEARCH_UNAVAILABLE",
    503,
    "Palette search is unavailable",
  );

function equalColors(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((color, index) => color === right[index])
  );
}

export async function searchPatternsByPalette(
  input: SearchInput,
  dependencies: SearchDependencies = {},
) {
  const request = paletteSearchRequestSchema.safeParse({
    requestId: input.requestId,
    colors: input.colors,
    filters: input.filters,
  });
  if (!request.success) throw invalidColors();

  const now = dependencies.now ?? performance.now.bind(performance);
  const startedAt = now();
  const allowedPatternIds = await resolveImageSearchPatternIds({
    ownerId: input.ownerId,
    filters: request.data.filters,
  });
  if (allowedPatternIds.length === 0) throw noIndex();

  const allowed = new Set(allowedPatternIds);
  const client = dependencies.client ?? getInternalPaletteSearchClient();
  const rawResponse = await client.search({
    ownerId: input.ownerId,
    allowedPatternIds,
    requestId: request.data.requestId,
    colors: request.data.colors,
    signal: input.signal,
  });
  const parsed = internalPaletteSearchResponseSchema.safeParse(rawResponse);
  if (
    !parsed.success ||
    parsed.data.requestId !== request.data.requestId ||
    !equalColors(parsed.data.query.colors, request.data.colors) ||
    parsed.data.items.some((item) => !allowed.has(item.patternId))
  ) {
    throw unavailable();
  }

  const patternIds = parsed.data.items.map((item) => item.patternId);
  const items = await hydratePatternIdsInOrder({
    ownerId: input.ownerId,
    patternIds,
  });
  if (
    items.length !== patternIds.length ||
    items.some((item, index) => item.id !== patternIds[index])
  ) {
    throw unavailable();
  }

  return {
    query: { colors: [...request.data.colors] },
    items,
    timing: { totalMs: Math.max(0, Math.round(now() - startedAt)) },
  };
}
