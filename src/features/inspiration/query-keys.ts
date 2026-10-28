export const inspirationKeys = {
  all: (ownerId: string) => ["owner", ownerId, "inspiration"] as const,
  list: (ownerId: string) => [...inspirationKeys.all(ownerId), "list"] as const,
  detail: (ownerId: string, analysisId: string) =>
    [...inspirationKeys.all(ownerId), "detail", analysisId] as const,
};
