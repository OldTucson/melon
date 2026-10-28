import { requireApiUser } from "@/features/auth/api-session";
import { createInspirationAnalysis, listInspirationAnalyses } from "@/features/inspiration/analysis-service";
import { inspirationCreateMutationSchema } from "@/features/inspiration/contracts";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

import { parseInspirationListQuery, readInspirationMutation } from "./input";

export const GET = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  const query = parseInspirationListQuery(new URL(request.url).searchParams);
  return Response.json(await listInspirationAnalyses({ ownerId: user.id, ...query }));
});

export const POST = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const mutation = await readInspirationMutation(inspirationCreateMutationSchema, request);
  return Response.json(
    await createInspirationAnalysis({ ownerId: user.id, ...mutation }),
    { status: 201 },
  );
});
