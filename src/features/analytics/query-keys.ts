import { serializeDashboardQuery, type DashboardQuery } from "./contracts";

export const dashboardKeys = {
  all: (ownerId: string) => ["owner", ownerId, "authorization-dashboard"] as const,
  data: (ownerId: string, query: DashboardQuery) =>
    [
      "owner",
      ownerId,
      "authorization-dashboard",
      serializeDashboardQuery(query).toString(),
    ] as const,
};
