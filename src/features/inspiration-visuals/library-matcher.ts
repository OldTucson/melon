import "server-only";

import { randomUUID } from "node:crypto";

import { imageSearchFiltersSchema } from "@/features/image-search/contracts";
import type { InspirationAnalysisResult } from "@/features/inspiration/contracts";
import type { PatternItem } from "@/features/library/library-types";
import { paletteHexSchema } from "@/features/palette-search/contracts";
import { searchPatternsByPalette } from "@/features/palette-search/palette-search-service";
import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";

import type { VisualWarning } from "./contracts";

const MAX_OVERVIEW_MATCHES = 8;
const MAX_DIRECTION_MATCHES = 3;
const MAX_TOTAL_MATCHES = 20;

export type LibraryMatchCandidate = {
  kind: "library_match";
  ordinal: number;
  directionIndex: number | null;
  title: string;
  altText: string;
  patternId: string;
};

export type LibraryMatchResult = {
  assets: LibraryMatchCandidate[];
  warnings: VisualWarning[];
};

type MatchLibraryInput = {
  ownerId: string;
  result: InspirationAnalysisResult;
  signal: AbortSignal;
};

type MatchLibraryDependencies = {
  search?: (
    input: Parameters<typeof searchPatternsByPalette>[0],
  ) => Promise<{ items: PatternItem[] }>;
  createRequestId?: () => string;
  isEnabled?: () => boolean;
};

const exactColors = (values: readonly (string | null)[]) => {
  const colors: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (value === null || !paletteHexSchema.safeParse(value).success) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    colors.push(value);
    if (colors.length === 5) break;
  }

  return colors;
};

export function extractResearchPalettes(result: InspirationAnalysisResult) {
  return {
    overview: exactColors(
      result.dimensions.colors.map(({ colorHint }) => colorHint),
    ),
    directions: result.inspirationPrompts.map(({ palette }) =>
      exactColors(palette),
    ),
  };
}

const isUsablePattern = (item: PatternItem, ownerId: string) =>
  item.ownerId === ownerId &&
  item.status === "ready" &&
  item.trashedAt === null &&
  item.deletedAt === null &&
  Boolean(item.thumbnailAssetId ?? item.previewAssetId);

const paletteWarning = (error: unknown): VisualWarning | undefined => {
  if (!(error instanceof AppError)) return undefined;
  if (error.code === "PALETTE_SEARCH_NO_INDEX") {
    return "INSPIRATION_LIBRARY_MATCH_EMPTY";
  }
  if (
    error.code === "PALETTE_SEARCH_TIMEOUT" ||
    error.code === "PALETTE_SEARCH_UNAVAILABLE"
  ) {
    return "INSPIRATION_LIBRARY_MATCH_UNAVAILABLE";
  }
  return undefined;
};

export async function matchLibraryPatterns(
  input: MatchLibraryInput,
  dependencies: MatchLibraryDependencies = {},
): Promise<LibraryMatchResult> {
  const isEnabled =
    dependencies.isEnabled ?? (() => getServerEnv().IMAGE_SEARCH_ENABLED);
  if (!isEnabled()) {
    return {
      assets: [],
      warnings: ["INSPIRATION_LIBRARY_MATCH_DISABLED"],
    };
  }

  const palettes = extractResearchPalettes(input.result);
  const groups = [
    ...(palettes.overview.length > 0
      ? [
          {
            colors: palettes.overview,
            directionIndex: null,
            limit: MAX_OVERVIEW_MATCHES,
          },
        ]
      : []),
    ...palettes.directions.flatMap((colors, directionIndex) =>
      colors.length > 0
        ? [{ colors, directionIndex, limit: MAX_DIRECTION_MATCHES }]
        : [],
    ),
  ];
  if (groups.length === 0) {
    return {
      assets: [],
      warnings: ["INSPIRATION_LIBRARY_MATCH_EMPTY"],
    };
  }

  const search = dependencies.search ?? searchPatternsByPalette;
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  const filters = imageSearchFiltersSchema.parse({});
  const assets: LibraryMatchCandidate[] = [];
  const warnings = new Set<VisualWarning>();

  for (const group of groups) {
    if (assets.length === MAX_TOTAL_MATCHES) break;

    let items: PatternItem[];
    try {
      const response = await search({
        ownerId: input.ownerId,
        colors: group.colors,
        filters,
        requestId: createRequestId(),
        signal: input.signal,
      });
      items = response.items;
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      const warning = paletteWarning(error);
      if (warning === undefined) throw error;
      warnings.add(warning);
      break;
    }

    const seen = new Set<string>();
    let accepted = 0;
    for (const item of items) {
      if (accepted === group.limit || assets.length === MAX_TOTAL_MATCHES) break;
      if (seen.has(item.id) || !isUsablePattern(item, input.ownerId)) continue;
      seen.add(item.id);

      const title = item.name.trim();
      if (title.length === 0) continue;
      assets.push({
        kind: "library_match",
        ordinal: assets.length,
        directionIndex: group.directionIndex,
        title,
        altText: `${title} 的图库图案预览`,
        patternId: item.id,
      });
      accepted += 1;
    }
  }

  if (assets.length === 0 && warnings.size === 0) {
    warnings.add("INSPIRATION_LIBRARY_MATCH_EMPTY");
  }

  return { assets, warnings: [...warnings] };
}
