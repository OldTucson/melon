import { parseDashboardSearchParams } from "@/features/analytics/contracts";
import { getAuthorizationDashboard } from "@/features/analytics/dashboard-service";
import { requireApiUser } from "@/features/auth/api-session";
import { withRoute } from "@/lib/http/route";

export const GET = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  const query = parseDashboardSearchParams(new URL(request.url).searchParams);
  return Response.json(
    await getAuthorizationDashboard({ ownerId: user.id, query }),
  );
});
