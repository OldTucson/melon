import { requireApiUser } from "@/features/auth/api-session";
import {
  assertEmptyConceptBody,
  conceptSetParamsSchema,
  parseInspirationRequest,
  withConceptRoute,
  type ConceptSetContext,
} from "@/features/inspiration-concepts/http";
import { deleteConceptSet } from "@/features/inspiration-concepts/service";
import { assertSameOrigin } from "@/lib/http/route";

export const DELETE = withConceptRoute(
  async (request: Request, context: ConceptSetContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const params = parseInspirationRequest(
      conceptSetParamsSchema,
      await context.params,
    );
    await assertEmptyConceptBody(request);
    await deleteConceptSet({ ownerId: user.id, ...params });
    return new Response(null, { status: 204 });
  },
);
