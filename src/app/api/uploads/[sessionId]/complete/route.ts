import { requireUser } from "@/features/auth/session";
import { parseUploadComplete } from "@/features/uploads/contracts";
import { completeUpload } from "@/features/uploads/upload-service";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type UploadSessionContext = { params: Promise<{ sessionId: string }> };

export const POST = withRoute<UploadSessionContext>(
  async (request, context) => {
    const user = await requireUser();
    assertSameOrigin(request);
    const { sessionId: rawSessionId } = await context!.params;
    const sessionId = normalizedUuidSchema.parse(rawSessionId);
    const input = parseUploadComplete(await readJson(request));
    return Response.json(
      await completeUpload({ ownerId: user.id, sessionId, input }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  },
);
