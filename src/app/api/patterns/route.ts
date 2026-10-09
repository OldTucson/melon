import { requireUser } from "@/features/auth/session";
import { parsePatternSearchParams } from "@/features/patterns/contracts";
import { listPatterns } from "@/features/patterns/pattern-service";
import { withRoute } from "@/lib/http/route";

export const GET = withRoute(async (request: Request) => {
  const user = await requireUser();
  const input = parsePatternSearchParams(new URL(request.url).searchParams);
  return Response.json(await listPatterns({ ownerId: user.id, input }));
});
