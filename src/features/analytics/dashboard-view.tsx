"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { readApiResponse } from "@/lib/query/client";
import { useQueryOwnerId } from "@/lib/query/provider";

import {
  serializeDashboardQuery,
  type DashboardDto,
  type DashboardQuery,
} from "./contracts";
import { CurrentStateChart } from "./current-state-chart";
import { DashboardFilters } from "./dashboard-filters";
import { KpiStrip } from "./kpi-strip";
import { dashboardKeys } from "./query-keys";
import { FieldRanking, PatternRanking } from "./ranking-table";
import { RevenueTrend } from "./revenue-trend";

async function fetchDashboard(query: DashboardQuery) {
  const search = serializeDashboardQuery(query);
  return readApiResponse<DashboardDto>(
    await fetch(`/api/dashboard/authorizations?${search.toString()}`),
  );
}

function rangeLabel(query: DashboardQuery, data: DashboardDto) {
  if (query.range === "all_time") return `截至 ${data.range.end}`;
  if (query.range === "custom") {
    return `${data.range.start} 至 ${data.range.end}（含首尾）`;
  }
  return `${data.range.start} 至 ${data.range.end}`;
}

export function DashboardView({
  initialQuery,
  today,
}: {
  initialQuery: DashboardQuery;
  today: string;
}) {
  const ownerId = useQueryOwnerId();
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);

  const dashboardQuery = useQuery({
    queryKey: dashboardKeys.data(ownerId, query),
    queryFn: () => fetchDashboard(query),
    placeholderData: keepPreviousData,
  });
  const data = dashboardQuery.data;

  const updateQuery = (next: DashboardQuery) => {
    setQuery(next);
    router.replace(`/dashboard?${serializeDashboardQuery(next).toString()}`, {
      scroll: false,
    });
  };

  if (!data && dashboardQuery.isPending) {
    return (
      <main className="dashboard-page dashboard-message" aria-busy="true">
        正在载入数据看板...
      </main>
    );
  }
  if (!data || dashboardQuery.isError) {
    return (
      <main className="dashboard-page dashboard-message" role="alert">
        数据看板暂时无法载入
      </main>
    );
  }

  return (
    <main
      className="dashboard-page"
      aria-busy={dashboardQuery.isFetching ? "true" : undefined}
    >
      <header className="dashboard-header">
        <div className="dashboard-title">
          <h1>数据看板</h1>
          <p>{rangeLabel(query, data)}</p>
        </div>
        <DashboardFilters
          key={serializeDashboardQuery(query).toString()}
          onChange={updateQuery}
          query={query}
          resolvedRange={data.range}
          today={today}
        />
      </header>
      <KpiStrip metrics={data.metrics} />
      <div className="dashboard-overview-grid">
        <RevenueTrend rows={data.trend} />
        <CurrentStateChart rows={data.currentStates} />
      </div>
      <div className="dashboard-ranking-grid">
        <FieldRanking rows={data.fields} />
        <PatternRanking rows={data.topPatterns} />
      </div>
    </main>
  );
}
