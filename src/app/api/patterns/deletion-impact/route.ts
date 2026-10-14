import { requireUser } from "@/features/auth/session";
import { getPatternDeletionImpact } from "@/features/trash/commercial-impact";
import { patternDeletionImpactRequestSchema } from "@/features/trash/deletion-impact-contracts";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

export const POST = withRoute(async (request: Request) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const body = patternDeletionImpactRequestSchema.parse(await readJson(request));
  return Response.json(
    await getPatternDeletionImpact({
      ownerId: user.id,
      patternIds: body.patternIds,
    }),
  );
});
