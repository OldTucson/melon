import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

import {
  parseDashboardSearchParams,
  serializeDashboardQuery,
} from "@/features/analytics/contracts";
import { getAuthorizationDashboard } from "@/features/analytics/dashboard-service";
import { DashboardView } from "@/features/analytics/dashboard-view";
import { dashboardKeys } from "@/features/analytics/query-keys";
import { currentDateInTimeZone } from "@/features/authorizations/dates";
import { requireUser } from "@/features/auth/session";
import { searchParamsRecordToURLSearchParams } from "@/features/library/query-state";
import { createQueryClient } from "@/lib/query/client";
import { AppError } from "@/lib/http/app-error";

async function loadDashboard(
  ownerId: string,
  rawSearchParams: URLSearchParams,
  today: string,
) {
  try {
    const query = parseDashboardSearchParams(rawSearchParams);
    const data = await getAuthorizationDashboard({ ownerId, query, today });
    return { data, query };
  } catch (error) {
    if (
      error instanceof ZodError ||
      (error instanceof AppError && error.status === 400)
    ) {
      redirect("/dashboard");
    }
    throw error;
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const rawSearchParams = searchParamsRecordToURLSearchParams(
    await searchParams,
  );
  const today = currentDateInTimeZone();

  const { data, query } = await loadDashboard(user.id, rawSearchParams, today);
  const queryClient = createQueryClient();
  queryClient.setQueryData(dashboardKeys.data(user.id, query), data);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DashboardView
        initialQuery={query}
        key={serializeDashboardQuery(query).toString()}
        today={today}
      />
    </HydrationBoundary>
  );
}
