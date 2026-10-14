import { requireApiUser } from "@/features/auth/api-session";
import {
  authorizationFieldArchiveRequestSchema,
  authorizationFieldParamsSchema,
} from "@/features/authorizations/contracts";
import { archiveAuthorizationField } from "@/features/authorizations/field-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type RouteContext = { params: Promise<{ fieldId: string }> };

export const DELETE = withRoute(
  async (request: Request, context: RouteContext) => {
    const user = await requireApiUser();
    assertSameOrigin(request);
    const { fieldId } = authorizationFieldParamsSchema.parse(
      await context.params,
    );
    const input = authorizationFieldArchiveRequestSchema.parse(
      await readJson(request),
    );
    return Response.json(
      await archiveAuthorizationField({
        ownerId: user.id,
        fieldId,
        operationId: input.operationId,
      }),
    );
  },
);
