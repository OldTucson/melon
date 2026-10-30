import { requireApiUser } from "@/features/auth/api-session";
import { authorizeOwnedVisualResource, visualResourceResponse } from "@/features/inspiration-visuals/visual-resource-service";
import { withRoute } from "@/lib/http/route";

export const dynamic = "force-dynamic";

type AssetContext = { params: Promise<{ assetId: string }> };

const getResource = withRoute(async (_request: Request, context: AssetContext) => {
  const user = await requireApiUser();
  const { assetId } = await context.params;
  return visualResourceResponse(await authorizeOwnedVisualResource({ ownerId: user.id, assetId }));
});

export async function GET(request: Request, context: AssetContext) {
  const response = await getResource(request, context);
  // Error responses must be private too, including authentication failures.
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Content-Security-Policy", "sandbox");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
