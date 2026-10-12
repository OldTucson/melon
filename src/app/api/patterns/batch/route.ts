import { requireUser } from "@/features/auth/session";
import { parsePatternBatchMutation } from "@/features/patterns/batch-contracts";
import { batchPatterns } from "@/features/patterns/pattern-batch-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

export const POST = withRoute(async (request: Request) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const mutation = parsePatternBatchMutation(await readJson(request));
  return Response.json(await batchPatterns({ ownerId: user.id, mutation }));
});
