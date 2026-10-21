import { requireApiUser } from "@/features/auth/api-session";
import { imageSearchIndexStatusSchema } from "@/features/image-search/contracts";
import { getImageSearchIndexStatus } from "@/features/image-search/index-admin-service";
import { withRoute } from "@/lib/http/route";

export const runtime = "nodejs";

export const GET = withRoute(async () => {
  const user = await requireApiUser();
  const status = imageSearchIndexStatusSchema.parse(
    await getImageSearchIndexStatus(user.id),
  );
  return Response.json(status, {
    headers: { "cache-control": "private, no-store" },
  });
});
