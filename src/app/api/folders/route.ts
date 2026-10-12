import { requireUser } from "@/features/auth/session";
import { folderCreateMutationSchema } from "@/features/folders/contracts";
import {
  createFolder,
  listFolders,
} from "@/features/folders/folder-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

export const GET = withRoute(async () => {
  const user = await requireUser();
  return Response.json(await listFolders({ ownerId: user.id }));
});

export const POST = withRoute(async (request: Request) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const mutation = folderCreateMutationSchema.parse(await readJson(request));
  return Response.json(
    await createFolder({
      ownerId: user.id,
      operationId: mutation.operationId,
      name: mutation.input.name,
      parentId: mutation.input.parentId,
    }),
    { status: 201 },
  );
});
