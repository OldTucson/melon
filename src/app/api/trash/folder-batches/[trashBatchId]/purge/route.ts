import { requireUser } from "@/features/auth/session";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { parseFolderBatchPurgeMutation } from "@/features/trash/contracts";
import { purgeFolderBatch } from "@/features/trash/trash-purge-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type TrashBatchContext = { params: Promise<{ trashBatchId: string }> };

export const POST = withRoute<TrashBatchContext>(async (request, context) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const { trashBatchId: rawTrashBatchId } = await context!.params;
  const trashBatchId = normalizedUuidSchema.parse(rawTrashBatchId);
  const mutation = parseFolderBatchPurgeMutation(await readJson(request));
  return Response.json(
    await purgeFolderBatch({
      ownerId: user.id,
      operationId: mutation.operationId,
      trashBatchId,
    }),
  );
});
