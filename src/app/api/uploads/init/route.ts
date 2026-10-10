import { requireUser } from "@/features/auth/session";
import { parseUploadInit } from "@/features/uploads/contracts";
import { initializeUpload } from "@/features/uploads/upload-service";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

export const POST = withRoute(async (request: Request) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const input = parseUploadInit(await readJson(request));
  return Response.json(await initializeUpload({ ownerId: user.id, input }), {
    headers: { "Cache-Control": "private, no-store" },
  });
});
