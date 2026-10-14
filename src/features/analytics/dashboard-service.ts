import "server-only";

import { z } from "zod";

import { currentDateInTimeZone } from "@/features/authorizations/dates";
import { commercialStates } from "@/features/patterns/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";

import {
  dashboardQuerySchema,
  type CommercialState,
  type DashboardDto,
} from "./contracts";
import { resolveRange } from "./date-ranges";
import { readAuthorizationDashboardRows } from "./dashboard-repository";

const dashboardServiceInputSchema = z.object({
  ownerId: normalizedUuidSchema,
  query: dashboardQuerySchema,
  today: z.iso.date().optional(),
});

function roundHalfUp(value: bigint, divisor: bigint) {
  return (value + divisor / 2n) / divisor;
}

function averageFen(revenueFen: string, count: number) {
  if (count === 0) return "0";
  return roundHalfUp(BigInt(revenueFen), BigInt(count)).toString();
}

function comparisonPercent(current: string, previous: string) {
  const base = BigInt(previous);
  if (base === 0n) return null;

  const scaled = (BigInt(current) - base) * 10_000n;
  const rounded =
    scaled >= 0n
      ? roundHalfUp(scaled, base)
      : -roundHalfUp(-scaled, base);
  const sign = rounded < 0n ? "-" : "";
  const absolute = rounded < 0n ? -rounded : rounded;
  return `${sign}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`;
}

export async function getAuthorizationDashboard(
  rawInput: z.input<typeof dashboardServiceInputSchema>,
): Promise<DashboardDto> {
  const input = dashboardServiceInputSchema.parse(rawInput);
  const today = input.today ?? currentDateInTimeZone();
  const range = resolveRange(input.query, today);
  const rows = await readAuthorizationDashboardRows({
    ownerId: input.ownerId,
    query: input.query,
    range,
    today,
  });
  const stateCounts = new Map<CommercialState, number>(
    rows.currentStates.map((row) => [row.state, row.patternCount]),
  );

  return {
    range,
    metrics: {
      revenueFen: rows.current.revenueFen,
      count: rows.current.count,
      patternCount: rows.current.patternCount,
      averageFen: averageFen(rows.current.revenueFen, rows.current.count),
      comparisonPercent:
        rows.comparison === null
          ? null
          : comparisonPercent(
              rows.current.revenueFen,
              rows.comparison.revenueFen,
            ),
    },
    trend: rows.trend.map(({ bucket, revenueFen, count }) => ({
      bucket,
      revenueFen,
      count,
    })),
    currentStates: commercialStates.map((state) => ({
      state,
      patternCount: stateCounts.get(state) ?? 0,
    })),
    fields: rows.fields.map(({ fieldId, fieldName, count, revenueFen }) => ({
      fieldId,
      fieldName,
      count,
      revenueFen,
    })),
    topPatterns: rows.topPatterns.map(
      ({ patternId, patternName, lifecycle, count, revenueFen }) => ({
        patternId,
        patternName,
        lifecycle,
        count,
        revenueFen,
      }),
    ),
  };
}
