export const inspirationConceptKeys = {
  all: (ownerId: string) => ["inspiration-concepts", ownerId] as const,
  analysis: (ownerId: string, analysisId: string) =>
    ["inspiration-concepts", ownerId, analysisId] as const,
};
