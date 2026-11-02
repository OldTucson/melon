import { authorizeSharedInspirationResource, conceptResourceResponse } from "@/features/inspiration-concepts/resource-service";
import { visualResourceResponse } from "@/features/inspiration-visuals/visual-resource-service";
import { withRoute } from "@/lib/http/route";

export const dynamic = "force-dynamic";

type ShareAssetContext = { params: Promise<{ shareId: string; assetId: string }> };

const getResource = withRoute(async (_request: Request, context: ShareAssetContext) => {
  const { shareId, assetId } = await context.params;
  const resource = await authorizeSharedInspirationResource({ shareId, assetId });
  return "bytes" in resource ? conceptResourceResponse(resource) : visualResourceResponse(resource);
});

export async function GET(request: Request, context: ShareAssetContext) {
  const response = await getResource(request, context);
  // In particular, never cache a revoked or invalid share response.
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Content-Security-Policy", "sandbox");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
