import { requireApiUser } from "@/features/auth/api-session";
import { voidAuthorization } from "@/features/authorizations/authorization-service";
import {
  authorizationParamsSchema,
  authorizationStatusMutationSchema,
} from "@/features/authorizations/contracts";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type RouteContext = { params: Promise<{ authorizationId: string }> };

export const POST = withRoute(
  async (request: Request, context: RouteContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const { authorizationId } = authorizationParamsSchema.parse(
      await context.params,
    );
    const input = authorizationStatusMutationSchema.parse(
      await readJson(request),
    );
    return Response.json(
      await voidAuthorization({
        ownerId: user.id,
        authorizationId,
        ...input,
      }),
    );
  },
);
