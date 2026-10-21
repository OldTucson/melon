import { requireApiUser } from "@/features/auth/api-session";
import { imageSearchRebuildResultSchema } from "@/features/image-search/contracts";
import { rebuildImageSearchIndex } from "@/features/image-search/index-admin-service";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

export const runtime = "nodejs";

export const POST = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const result = imageSearchRebuildResultSchema.parse(
    await rebuildImageSearchIndex(user.id),
  );
  return Response.json(result, {
    headers: { "cache-control": "private, no-store" },
  });
});
