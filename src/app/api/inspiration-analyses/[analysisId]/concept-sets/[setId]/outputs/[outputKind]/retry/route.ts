import { requireApiUser } from "@/features/auth/api-session";
import {
  conceptRetryMutationSchema,
  conceptSetDtoSchema,
} from "@/features/inspiration-concepts/contracts";
import {
  conceptJson,
  conceptRetryParamsSchema,
  parseInspirationRequest,
  readConceptMutation,
  withConceptRoute,
  type ConceptRetryContext,
} from "@/features/inspiration-concepts/http";
import { retryConceptDerivative } from "@/features/inspiration-concepts/service";
import { assertSameOrigin } from "@/lib/http/route";

export const POST = withConceptRoute(
  async (request: Request, context: ConceptRetryContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const params = parseInspirationRequest(
      conceptRetryParamsSchema,
      await context.params,
    );
    const mutation = await readConceptMutation(
      conceptRetryMutationSchema,
      request,
    );
    return conceptJson(
      conceptSetDtoSchema,
      await retryConceptDerivative({
        ownerId: user.id,
        ...params,
        ...mutation,
      }),
    );
  },
);
