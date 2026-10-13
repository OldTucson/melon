import { requireUser } from "@/features/auth/session";
import { parsePatternPurgeMutation } from "@/features/trash/contracts";
import { purgePatterns } from "@/features/trash/trash-purge-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

export const POST = withRoute(async (request: Request) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const mutation = parsePatternPurgeMutation(await readJson(request));
  return Response.json(
    await purgePatterns({
      ownerId: user.id,
      operationId: mutation.operationId,
      patternIds: mutation.patternIds,
    }),
  );
});
