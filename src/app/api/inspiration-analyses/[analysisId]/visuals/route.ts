import { requireApiUser } from "@/features/auth/api-session";
import { researchVisualMutationSchema } from "@/features/inspiration-visuals/contracts";
import {
  createResearchVisuals,
  getInspirationVisualBoard,
} from "@/features/inspiration-visuals/visual-service";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

import {
  inspirationParamsSchema,
  parseInspirationRequest,
  readInspirationMutation,
  type InspirationRouteContext,
} from "../../input";

export const GET = withRoute(
  async (_request: Request, context: InspirationRouteContext) => {
    const user = await requireApiUser();
    const { analysisId } = parseInspirationRequest(
      inspirationParamsSchema,
      await context.params,
    );
    return Response.json(
      await getInspirationVisualBoard({ ownerId: user.id, analysisId }),
    );
  },
);

export const POST = withRoute(
  async (request: Request, context: InspirationRouteContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const { analysisId } = parseInspirationRequest(
      inspirationParamsSchema,
      await context.params,
    );
    const mutation = await readInspirationMutation(
      researchVisualMutationSchema,
      request,
    );
    return Response.json(
      await createResearchVisuals({
        ownerId: user.id,
        analysisId,
        ...mutation,
      }),
      { status: 201 },
    );
  },
);
