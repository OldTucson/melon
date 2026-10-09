import {
  patternFormats,
  patternQuerySchema,
  type PatternQuery,
} from "@/features/patterns/contracts";

export type LibrarySearchState = {
  q?: string;
  formats: string[];
  tagIds: string[];
  tagMode: string;
  untagged?: string | boolean;
  favorite?: string | boolean;
  previewStatus?: string;
  sort: string;
  cursor?: string;
  limit: string | number;
};

const formatOrder = new Map<string, number>(
  patternFormats.map((format, index) => [format, index]),
);

const canonicalFormats = (formats: readonly string[]) =>
  [...formats].sort((left, right) => {
    const leftOrder = formatOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = formatOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.localeCompare(right);
  });

const canonicalTags = (tagIds: readonly string[]) =>
  [...tagIds].sort((left, right) => left.localeCompare(right));

export function parseLibrarySearchParams(
  searchParams: URLSearchParams,
): LibrarySearchState {
  const scalar = (key: string) => searchParams.get(key) ?? undefined;
  const formats = [
    ...searchParams.getAll("formats"),
    ...searchParams.getAll("format"),
  ];
  const tagIds = [
    ...searchParams.getAll("tagIds"),
    ...searchParams.getAll("tag"),
  ];

  return {
    q: scalar("q"),
    formats: canonicalFormats(formats),
    tagIds: canonicalTags(tagIds),
    tagMode: scalar("tagMode") ?? "all",
    untagged: scalar("untagged"),
    favorite: scalar("favorite"),
    previewStatus: scalar("previewStatus"),
    sort: scalar("sort") ?? "updated_desc",
    cursor: scalar("cursor"),
    limit: scalar("limit") ?? 50,
  };
}

export function toPatternQuery(state: LibrarySearchState): PatternQuery {
  const parsed = patternQuerySchema.parse(state);
  return {
    ...parsed,
    formats: canonicalFormats(parsed.formats) as PatternQuery["formats"],
    tagIds: canonicalTags(parsed.tagIds),
  };
}

export function serializeLibrarySearchParams(
  state: LibrarySearchState | PatternQuery,
) {
  const result = new URLSearchParams();
  if (state.q) result.set("q", state.q);
  for (const format of canonicalFormats(state.formats)) {
    result.append("format", format);
  }
  for (const tagId of canonicalTags(state.tagIds)) {
    result.append("tag", tagId);
  }
  if (state.tagIds.length > 0) result.set("tagMode", state.tagMode);
  if (state.untagged !== undefined) {
    result.set("untagged", String(state.untagged));
  }
  if (state.favorite !== undefined) {
    result.set("favorite", String(state.favorite));
  }
  if (state.previewStatus) result.set("previewStatus", state.previewStatus);
  if (state.sort !== "updated_desc") result.set("sort", state.sort);
  if (state.cursor) result.set("cursor", state.cursor);
  if (Number(state.limit) !== 50) result.set("limit", String(state.limit));
  return result;
}

export function searchParamsRecordToURLSearchParams(
  record: Record<string, string | string[] | undefined>,
) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}
