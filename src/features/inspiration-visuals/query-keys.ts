import { inspirationKeys } from "@/features/inspiration/query-keys";

export const inspirationVisualKeys = {
  detail: (ownerId: string, analysisId: string) =>
    [...inspirationKeys.detail(ownerId, analysisId), "visuals"] as const,
};
