import type { PatternQuery } from "@/features/patterns/contracts";

export const queryKeys = {
  patterns: (ownerId: string, query: PatternQuery) =>
    ["owner", ownerId, "patterns", query] as const,
  pattern: (ownerId: string, id: string) =>
    ["owner", ownerId, "pattern", id] as const,
  patternTags: (ownerId: string, id: string) =>
    ["owner", ownerId, "pattern", id, "tags"] as const,
  tags: (ownerId: string) => ["owner", ownerId, "tags"] as const,
};
