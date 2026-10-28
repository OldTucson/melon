import { requireApiUser } from "@/features/auth/api-session";
import { retryInspirationAnalysis } from "@/features/inspiration/analysis-service";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

import { inspirationParamsSchema, parseInspirationRequest, type InspirationRouteContext } from "../../input";

export const POST = withRoute(async (request: Request, context: InspirationRouteContext) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context.params);
  return Response.json(await retryInspirationAnalysis({ ownerId: user.id, analysisId }));
});
