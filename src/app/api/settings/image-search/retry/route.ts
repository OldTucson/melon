import { requireApiUser } from "@/features/auth/api-session";
import { imageSearchRetryResultSchema } from "@/features/image-search/contracts";
import { retryFailedImageSearchJobs } from "@/features/image-search/index-admin-service";
import { assertSameOrigin, withRoute } from "@/lib/http/route";

export const runtime = "nodejs";

export const POST = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const result = imageSearchRetryResultSchema.parse(
    await retryFailedImageSearchJobs(user.id),
  );
  return Response.json(result, {
    headers: { "cache-control": "private, no-store" },
  });
});
