import { requireUser } from "@/features/auth/session";
import { signAssetDownload } from "@/features/uploads/upload-service";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { withRoute } from "@/lib/http/route";

type AssetContext = { params: Promise<{ assetId: string }> };

export const GET = withRoute<AssetContext>(async (_request, context) => {
  const user = await requireUser();
  const { assetId: rawAssetId } = await context!.params;
  const assetId = normalizedUuidSchema.parse(rawAssetId);
  const { location } = await signAssetDownload({ ownerId: user.id, assetId });
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "private, no-store",
    },
  });
});
