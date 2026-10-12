import { requireUser } from "@/features/auth/session";
import { parsePatternRestoreMutation } from "@/features/trash/contracts";
import { restorePatterns } from "@/features/trash/trash-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

export const POST = withRoute(async (request: Request) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const mutation = parsePatternRestoreMutation(await readJson(request));
  return Response.json(
    await restorePatterns({
      ownerId: user.id,
      operationId: mutation.operationId,
      patternIds: mutation.patternIds,
    }),
  );
});
