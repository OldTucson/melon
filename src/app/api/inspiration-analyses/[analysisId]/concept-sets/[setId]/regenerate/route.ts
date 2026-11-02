import { requireApiUser } from "@/features/auth/api-session";
import {
  conceptRetryMutationSchema,
  conceptSetDtoSchema,
} from "@/features/inspiration-concepts/contracts";
import {
  conceptJson,
  conceptSetParamsSchema,
  parseInspirationRequest,
  readConceptMutation,
  withConceptRoute,
  type ConceptSetContext,
} from "@/features/inspiration-concepts/http";
import { regenerateConceptSet } from "@/features/inspiration-concepts/service";
import { assertSameOrigin } from "@/lib/http/route";

export const POST = withConceptRoute(
  async (request: Request, context: ConceptSetContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const params = parseInspirationRequest(
      conceptSetParamsSchema,
      await context.params,
    );
    const mutation = await readConceptMutation(
      conceptRetryMutationSchema,
      request,
    );
    return conceptJson(
      conceptSetDtoSchema,
      await regenerateConceptSet({ ownerId: user.id, ...params, ...mutation }),
    );
  },
);
