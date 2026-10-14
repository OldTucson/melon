import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db, type DbTransaction } from "@/lib/db/client";

import type { DashboardPreset, DashboardQuery } from "./contracts";
import {
  resolveTrendGranularity,
  type ResolvedDashboardRange,
} from "./date-ranges";

type PeriodInput = {
  ownerId: string;
  start: string | null;
  end: string;
  fieldId?: string;
  kind?: DashboardQuery["kind"];
};

export type PeriodMetricsRow = {
  revenueFen: string;
  count: number;
  patternCount: number;
  earliestAuthorizedOn: string | null;
};

export type TrendRow = {
  bucket: string;
  revenueFen: string;
  count: number;
};

export type CurrentStateRow = {
  state: "unlicensed" | "standard" | "field_exclusive" | "global_buyout";
  patternCount: number;
};

export type FieldRankingRow = {
  fieldId: string;
  fieldName: string;
  count: number;
  revenueFen: string;
};

export type PatternRankingRow = {
  patternId: string;
  patternName: string;
  lifecycle: "library" | "trash";
  count: number;
  revenueFen: string;
};

export type DashboardAggregateRows = {
  current: PeriodMetricsRow;
  comparison: PeriodMetricsRow | null;
  trend: TrendRow[];
  currentStates: CurrentStateRow[];
  fields: FieldRankingRow[];
  topPatterns: PatternRankingRow[];
};

function periodPredicate(input: PeriodInput) {
  const predicates: SQL[] = [
    sql`a.owner_id = ${input.ownerId}`,
    sql`a.status = 'active'::authorization_status`,
    sql`p.status <> 'deleted'::pattern_status`,
    sql`a.authorized_on <= ${input.end}::date`,
  ];
  if (input.start) {
    predicates.push(sql`a.authorized_on >= ${input.start}::date`);
  }
  if (input.kind) {
    predicates.push(sql`a.kind = ${input.kind}::authorization_kind`);
  }
  if (input.fieldId) {
    predicates.push(sql`a.field_id = ${input.fieldId}::uuid`);
  }
  return sql.join(predicates, sql` and `);
}

async function queryPeriodMetrics(
  tx: DbTransaction,
  input: PeriodInput,
): Promise<PeriodMetricsRow> {
  const [row] = await tx.execute<PeriodMetricsRow>(sql`
    select
      coalesce(sum(a.price_fen), 0)::text as "revenueFen",
      count(*)::int as "count",
      count(distinct a.pattern_id)::int as "patternCount",
      min(a.authorized_on)::text as "earliestAuthorizedOn"
    from authorizations a
    inner join patterns p
      on p.owner_id = a.owner_id
     and p.id = a.pattern_id
    where ${periodPredicate(input)}
  `);
  return row!;
}

function bucketExpression(granularity: "day" | "month" | "year") {
  if (granularity === "day") return sql`a.authorized_on`;
  if (granularity === "year") {
    return sql`date_trunc('year', a.authorized_on::timestamp)::date`;
  }
  return sql`date_trunc('month', a.authorized_on::timestamp)::date`;
}

async function queryTrend(
  tx: DbTransaction,
  input: PeriodInput,
  granularity: "day" | "month" | "year",
): Promise<TrendRow[]> {
  const bucket = bucketExpression(granularity);
  return tx.execute<TrendRow>(sql`
    select
      ${bucket}::text as "bucket",
      coalesce(sum(a.price_fen), 0)::text as "revenueFen",
      count(*)::int as "count"
    from authorizations a
    inner join patterns p
      on p.owner_id = a.owner_id
     and p.id = a.pattern_id
    where ${periodPredicate(input)}
    group by ${bucket}
    order by ${bucket} asc
  `);
}

async function queryCurrentStates(
  tx: DbTransaction,
  ownerId: string,
  today: string,
): Promise<CurrentStateRow[]> {
  return tx.execute<CurrentStateRow>(sql`
    with authorization_summary as (
      select
        a.pattern_id,
        bool_or(a.kind = 'field_exclusive'::authorization_kind) as has_exclusive,
        bool_or(a.kind = 'global_buyout'::authorization_kind) as has_buyout,
        count(*)::int as active_count
      from authorizations a
      where a.owner_id = ${ownerId}
        and a.status = 'active'::authorization_status
        and a.authorized_on <= ${today}::date
      group by a.pattern_id
    ), current_patterns as (
      select case
        when coalesce(summary.has_buyout, false) then 'global_buyout'
        when coalesce(summary.has_exclusive, false) then 'field_exclusive'
        when coalesce(summary.active_count, 0) > 0 then 'standard'
        else 'unlicensed'
      end as state
      from patterns p
      left join authorization_summary summary on summary.pattern_id = p.id
      where p.owner_id = ${ownerId}
        and p.status in (
          'draft'::pattern_status,
          'hashing'::pattern_status,
          'uploading'::pattern_status,
          'processing'::pattern_status,
          'ready'::pattern_status,
          'failed'::pattern_status
        )
    )
    select state, count(*)::int as "patternCount"
    from current_patterns
    group by state
  `);
}

async function queryFieldRanking(
  tx: DbTransaction,
  input: PeriodInput,
): Promise<FieldRankingRow[]> {
  return tx.execute<FieldRankingRow>(sql`
    select
      a.field_id::text as "fieldId",
      a.field_name_snapshot as "fieldName",
      count(*)::int as "count",
      coalesce(sum(a.price_fen), 0)::text as "revenueFen"
    from authorizations a
    inner join patterns p
      on p.owner_id = a.owner_id
     and p.id = a.pattern_id
    where ${periodPredicate(input)}
      and a.field_id is not null
    group by a.field_id, a.field_name_snapshot
    order by
      sum(a.price_fen) desc,
      max(a.authorized_on) desc,
      a.field_name_snapshot asc,
      a.field_id asc
    limit 10
  `);
}

async function queryTopPatterns(
  tx: DbTransaction,
  input: PeriodInput,
): Promise<PatternRankingRow[]> {
  return tx.execute<PatternRankingRow>(sql`
    select
      p.id::text as "patternId",
      p.name as "patternName",
      case
        when p.status in ('trashed'::pattern_status, 'deleting'::pattern_status)
          then 'trash'
        else 'library'
      end as "lifecycle",
      count(*)::int as "count",
      coalesce(sum(a.price_fen), 0)::text as "revenueFen"
    from authorizations a
    inner join patterns p
      on p.owner_id = a.owner_id
     and p.id = a.pattern_id
    where ${periodPredicate(input)}
    group by p.id, p.name, p.status
    order by
      sum(a.price_fen) desc,
      max(a.authorized_on) desc,
      p.name asc,
      p.id asc
    limit 10
  `);
}

export function readAuthorizationDashboardRows(input: {
  ownerId: string;
  query: DashboardQuery;
  range: ResolvedDashboardRange;
  today: string;
}): Promise<DashboardAggregateRows> {
  const period = {
    ownerId: input.ownerId,
    start: input.range.start,
    end: input.range.end,
    fieldId: input.query.fieldId,
    kind: input.query.kind,
  } satisfies PeriodInput;

  return db.transaction(
    async (tx) => {
      const current = await queryPeriodMetrics(tx, period);
      const comparison = input.range.comparison
        ? await queryPeriodMetrics(tx, {
            ...period,
            start: input.range.comparison.start,
            end: input.range.comparison.end,
          })
        : null;
      const trendStart =
        input.range.start ?? current.earliestAuthorizedOn ?? input.range.end;
      const granularity = resolveTrendGranularity(
        { start: trendStart, end: input.range.end },
        input.query.range as DashboardPreset,
      );
      const trend = await queryTrend(tx, period, granularity);
      const currentStates = await queryCurrentStates(
        tx,
        input.ownerId,
        input.today,
      );
      const fields = await queryFieldRanking(tx, period);
      const topPatterns = await queryTopPatterns(tx, period);
      return {
        current,
        comparison,
        trend,
        currentStates,
        fields,
        topPatterns,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
