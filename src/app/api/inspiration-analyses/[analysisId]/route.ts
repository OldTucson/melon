import { requireApiUser } from "@/features/auth/api-session";
import { deleteInspirationAnalysis, getInspirationAnalysis, renameInspirationAnalysis } from "@/features/inspiration/analysis-service";
import { inspirationPatchMutationSchema } from "@/features/inspiration/contracts";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

import { inspirationParamsSchema, parseInspirationRequest, readInspirationMutation, type InspirationRouteContext } from "../input";

export const GET = withRoute(async (_request: Request, context: InspirationRouteContext) => {
  const user = await requireApiUser();
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context.params);
  return Response.json(await getInspirationAnalysis({ ownerId: user.id, analysisId }));
});

export const PATCH = withRoute(async (request: Request, context: InspirationRouteContext) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context.params);
  const mutation = await readInspirationMutation(inspirationPatchMutationSchema, request);
  return Response.json(await renameInspirationAnalysis({ ownerId: user.id, analysisId, ...mutation }));
});

export const DELETE = withRoute(async (request: Request, context: InspirationRouteContext) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context.params);
  return Response.json(await deleteInspirationAnalysis({ ownerId: user.id, analysisId }));
});
