import { requireApiUser } from "@/features/auth/api-session";
import { editAuthorization } from "@/features/authorizations/authorization-service";
import {
  authorizationEditRequestSchema,
  authorizationParamsSchema,
} from "@/features/authorizations/contracts";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type RouteContext = { params: Promise<{ authorizationId: string }> };

export const PATCH = withRoute(
  async (request: Request, context: RouteContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const { authorizationId } = authorizationParamsSchema.parse(
      await context.params,
    );
    const input = authorizationEditRequestSchema.parse(await readJson(request));
    return Response.json(
      await editAuthorization({
        ownerId: user.id,
        authorizationId,
        ...input,
      }),
    );
  },
);
