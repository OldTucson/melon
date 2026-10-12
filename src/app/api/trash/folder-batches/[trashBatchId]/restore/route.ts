import { requireUser } from "@/features/auth/session";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { parseFolderBatchRestoreMutation } from "@/features/trash/contracts";
import { restoreFolderBatch } from "@/features/trash/trash-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type TrashBatchContext = { params: Promise<{ trashBatchId: string }> };

export const POST = withRoute<TrashBatchContext>(async (request, context) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const { trashBatchId: rawTrashBatchId } = await context!.params;
  const trashBatchId = normalizedUuidSchema.parse(rawTrashBatchId);
  const mutation = parseFolderBatchRestoreMutation(await readJson(request));
  return Response.json(
    await restoreFolderBatch({
      ownerId: user.id,
      operationId: mutation.operationId,
      trashBatchId,
    }),
  );
});
