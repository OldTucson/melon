import { requireApiUser } from "@/features/auth/api-session";
import {
  createAuthorization,
  listAuthorizations,
} from "@/features/authorizations/authorization-service";
import {
  authorizationCreateRequestSchema,
  authorizationHistoryQuerySchema,
  patternAuthorizationParamsSchema,
} from "@/features/authorizations/contracts";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type RouteContext = { params: Promise<{ patternId: string }> };

export const GET = withRoute(
  async (request: Request, context: RouteContext) => {
    const user = await requireApiUser();
    const { patternId } = patternAuthorizationParamsSchema.parse(
      await context.params,
    );
    const search = new URL(request.url).searchParams;
    const query = authorizationHistoryQuerySchema.parse({
      includeVoid: search.get("includeVoid") ?? undefined,
      limit: search.get("limit") ?? undefined,
      cursor: search.get("cursor") ?? undefined,
    });
    return Response.json(
      await listAuthorizations({ ownerId: user.id, patternId, ...query }),
    );
  },
);
export const POST = withRoute(
  async (request: Request, context: RouteContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const { patternId } = patternAuthorizationParamsSchema.parse(
      await context.params,
    );
    const input = authorizationCreateRequestSchema.parse(
      await readJson(request),
    );
    return Response.json(
      await createAuthorization({
        ownerId: user.id,
        patternId,
        ...input,
      }),
      { status: 201 },
    );
  },
);
