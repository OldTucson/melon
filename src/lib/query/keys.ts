import type { PatternQuery } from "@/features/patterns/contracts";

export const queryKeys = {
  patterns: (query: PatternQuery) => ["patterns", query] as const,
  pattern: (id: string) => ["pattern", id] as const,
  patternTags: (id: string) => ["pattern", id, "tags"] as const,
  tags: ["tags"] as const,
};
