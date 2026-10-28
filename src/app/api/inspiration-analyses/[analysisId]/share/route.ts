import { requireApiUser } from "@/features/auth/api-session";
import { disableInspirationShare, enableInspirationShare } from "@/features/inspiration/share-service";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

import { inspirationParamsSchema, parseInspirationRequest, type InspirationRouteContext } from "../../input";

export const POST = withRoute(async (request: Request, context: InspirationRouteContext) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context.params);
  return Response.json(await enableInspirationShare({ ownerId: user.id, analysisId }));
});

export const DELETE = withRoute(async (request: Request, context: InspirationRouteContext) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context.params);
  return Response.json(await disableInspirationShare({ ownerId: user.id, analysisId }));
});
