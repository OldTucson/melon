import {
  canonicalizePatternFormats,
  canonicalizePatternQuery,
  canonicalizePatternTagIds,
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
  commercialState?: string;
  authorizationField?: string;
  folderId?: string;
  unfiled?: string | boolean;
  includeDescendants: string | boolean;
  scope: string;
  sort: string;
  cursor?: string;
  limit: string | number;
};

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
  const unfiled = scalar("unfiled");

  return {
    q: scalar("q"),
    formats: canonicalizePatternFormats(formats),
    tagIds: canonicalizePatternTagIds(tagIds),
    tagMode: scalar("tagMode") ?? "all",
    untagged: scalar("untagged"),
    favorite: scalar("favorite"),
    previewStatus: scalar("previewStatus"),
    commercialState: scalar("commercialState"),
    authorizationField: scalar("authorizationField"),
    ...(unfiled === "true" ? {} : { folderId: scalar("folderId") }),
    unfiled,
    includeDescendants: scalar("includeDescendants") ?? true,
    scope: scalar("scope") ?? "library",
    sort: scalar("sort") ?? "updated_desc",
    cursor: scalar("cursor"),
    limit: scalar("limit") ?? 50,
  };
}

export function toPatternQuery(state: LibrarySearchState): PatternQuery {
  return canonicalizePatternQuery(patternQuerySchema.parse(state));
}

export function serializeLibrarySearchParams(
  state: LibrarySearchState | PatternQuery,
) {
  const result = new URLSearchParams();
  if (state.q) result.set("q", state.q);
  for (const format of canonicalizePatternFormats(state.formats)) {
    result.append("format", format);
  }
  for (const tagId of canonicalizePatternTagIds(state.tagIds)) {
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
  if (state.commercialState) {
    result.set("commercialState", state.commercialState);
  }
  if (state.authorizationField) {
    result.set("authorizationField", state.authorizationField);
  }
  if (state.unfiled !== true && state.unfiled !== "true" && state.folderId) {
    result.set("folderId", state.folderId);
  }
  if (state.unfiled !== undefined) {
    result.set("unfiled", String(state.unfiled));
  }
  if (state.includeDescendants === false || state.includeDescendants === "false") {
    result.set("includeDescendants", "false");
  }
  if (state.scope !== "library") result.set("scope", state.scope);
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
