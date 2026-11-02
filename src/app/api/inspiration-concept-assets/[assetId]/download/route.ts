import { requireApiUser } from "@/features/auth/api-session";
import {
  authorizeOwnedConceptResource,
  conceptResourceResponse,
  parseConceptAssetParams,
  privateConceptResourceResponse,
  type ConceptAssetContext,
} from "@/features/inspiration-concepts/resource-service";
import { withRoute } from "@/lib/http/route";

export const dynamic = "force-dynamic";
const getResource = withRoute(
  async (_request: Request, context: ConceptAssetContext) => {
    const user = await requireApiUser();
    const { assetId } = parseConceptAssetParams(await context.params);
    return conceptResourceResponse(
      await authorizeOwnedConceptResource({ ownerId: user.id, assetId }),
      { download: true },
    );
  },
);
export async function GET(request: Request, context: ConceptAssetContext) {
  return privateConceptResourceResponse(await getResource(request, context));
}
