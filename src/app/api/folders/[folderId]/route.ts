import { requireUser } from "@/features/auth/session";
import { folderRenameMutationSchema } from "@/features/folders/contracts";
import { renameFolder } from "@/features/folders/folder-service";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type FolderContext = { params: Promise<{ folderId: string }> };

export const PATCH = withRoute<FolderContext>(async (request, context) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const { folderId: rawFolderId } = await context!.params;
  const folderId = normalizedUuidSchema.parse(rawFolderId);
  const mutation = folderRenameMutationSchema.parse(await readJson(request));
  return Response.json(
    await renameFolder({
      ownerId: user.id,
      folderId,
      operationId: mutation.operationId,
      name: mutation.patch.name,
      version: mutation.patch.version,
    }),
  );
});
