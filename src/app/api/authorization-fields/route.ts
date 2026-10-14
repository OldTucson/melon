import { requireApiUser } from "@/features/auth/api-session";
import {
  authorizationFieldCreateMutationSchema,
  authorizationFieldListQuerySchema,
} from "@/features/authorizations/contracts";
import {
  createAuthorizationField,
  listAuthorizationFields,
} from "@/features/authorizations/field-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

export const GET = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  const search = new URL(request.url).searchParams;
  const query = authorizationFieldListQuerySchema.parse({
    includeArchived: search.get("includeArchived") ?? undefined,
  });
  return Response.json(
    await listAuthorizationFields({
      ownerId: user.id,
      includeArchived: query.includeArchived,
    }),
  );
});
export const POST = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const input = authorizationFieldCreateMutationSchema.parse(
    await readJson(request),
  );
  return Response.json(
    await createAuthorizationField({
      ownerId: user.id,
      operationId: input.operationId,
      name: input.name,
    }),
    { status: 201 },
  );
});
