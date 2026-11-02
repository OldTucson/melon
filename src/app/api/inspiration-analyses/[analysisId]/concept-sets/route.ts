import { requireApiUser } from "@/features/auth/api-session";
import {
  conceptSetCreateMutationSchema,
  conceptSetDtoSchema,
} from "@/features/inspiration-concepts/contracts";
import {
  conceptJson,
  conceptSetListSchema,
  readConceptMutation,
  withConceptRoute,
} from "@/features/inspiration-concepts/http";
import {
  createConceptSetWithOutcome,
  listConceptSets,
} from "@/features/inspiration-concepts/service";
import { assertSameOrigin } from "@/lib/http/route";
import {
  inspirationParamsSchema,
  parseInspirationRequest,
  type InspirationRouteContext,
} from "../../input";

export const dynamic = "force-dynamic";
export const GET = withConceptRoute(
  async (_request: Request, context: InspirationRouteContext) => {
    const user = await requireApiUser();
    const { analysisId } = parseInspirationRequest(
      inspirationParamsSchema,
      await context.params,
    );
    return conceptJson(
      conceptSetListSchema,
      await listConceptSets({ ownerId: user.id, analysisId }),
    );
  },
);
export const POST = withConceptRoute(
  async (request: Request, context: InspirationRouteContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const { analysisId } = parseInspirationRequest(
      inspirationParamsSchema,
      await context.params,
    );
    const mutation = await readConceptMutation(
      conceptSetCreateMutationSchema,
      request,
    );
    const result = await createConceptSetWithOutcome({
      ownerId: user.id,
      analysisId,
      ...mutation,
    });
    return conceptJson(
      conceptSetDtoSchema,
      result.set,
      result.created ? 201 : 200,
    );
  },
);
