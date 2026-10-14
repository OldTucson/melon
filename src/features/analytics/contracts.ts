import { z } from "zod";

import { authorizationKindSchema } from "@/features/authorizations/contracts";
import { commercialStates } from "@/features/patterns/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";

export const dashboardPresets = [
  "current_year",
  "last_12_months",
  "all_time",
  "custom",
] as const;

export const dashboardQuerySchema = z
  .object({
    range: z.enum(dashboardPresets).default("current_year"),
    start: z.iso.date().optional(),
    end: z.iso.date().optional(),
    fieldId: normalizedUuidSchema.optional(),
    kind: authorizationKindSchema.optional(),
  })
  .superRefine((query, context) => {
    if (query.range === "custom" && (!query.start || !query.end)) {
      context.addIssue({
        code: "custom",
        path: query.start ? ["end"] : ["start"],
        message: "Custom dashboard ranges require start and end dates",
      });
    }
    if (query.start && query.end && query.start > query.end) {
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "Dashboard range end must not precede start",
      });
    }
  });

export type DashboardPreset = (typeof dashboardPresets)[number];
export type DashboardQuery = z.output<typeof dashboardQuerySchema>;
export type CommercialState = (typeof commercialStates)[number];

export type DashboardDto = {
  range: {
    start: string | null;
    end: string;
    comparison: { start: string; end: string } | null;
  };
  metrics: {
    revenueFen: string;
    count: number;
    patternCount: number;
    averageFen: string;
    comparisonPercent: string | null;
  };
  trend: Array<{ bucket: string; revenueFen: string; count: number }>;
  currentStates: Array<{
    state: CommercialState;
    patternCount: number;
  }>;
  fields: Array<{
    fieldId: string;
    fieldName: string;
    count: number;
    revenueFen: string;
  }>;
  topPatterns: Array<{
    patternId: string;
    patternName: string;
    lifecycle: "library" | "trash";
    count: number;
    revenueFen: string;
  }>;
};

export function parseDashboardSearchParams(searchParams: URLSearchParams) {
  const scalar = (name: string) => searchParams.get(name) ?? undefined;
  return dashboardQuerySchema.parse({
    range: scalar("range"),
    start: scalar("start"),
    end: scalar("end"),
    fieldId: scalar("fieldId") ?? scalar("field"),
    kind: scalar("kind"),
  });
}

export function serializeDashboardQuery(query: DashboardQuery) {
  const search = new URLSearchParams({ range: query.range });
  if (query.range === "custom") {
    if (query.start) search.set("start", query.start);
    if (query.end) search.set("end", query.end);
  }
  if (query.fieldId) search.set("field", query.fieldId);
  if (query.kind) search.set("kind", query.kind);
  return search;
}
