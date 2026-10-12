import { requireUser } from "@/features/auth/session";
import { getFolderDeleteImpact } from "@/features/folders/folder-service";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { withRoute } from "@/lib/http/route";

type FolderContext = { params: Promise<{ folderId: string }> };

export const GET = withRoute<FolderContext>(async (_request, context) => {
  const user = await requireUser();
  const { folderId: rawFolderId } = await context!.params;
  const folderId = normalizedUuidSchema.parse(rawFolderId);
  return Response.json(
    await getFolderDeleteImpact({ ownerId: user.id, folderId }),
  );
});
