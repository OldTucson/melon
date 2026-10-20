import { requireUser } from "@/features/auth/session";
import { parseManualPreviewComplete } from "@/features/preview/manual-preview-contracts";
import { completeManualPreview } from "@/features/preview/manual-preview-service";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { assertSameOrigin, readJson, withRoute } from "@/lib/http/route";

type PatternContext = { params: Promise<{ patternId: string }> };

export const POST = withRoute<PatternContext>(async (request, context) => {
  const user = await requireUser();
  assertSameOrigin(request);
  const { patternId: rawPatternId } = await context!.params;
  const patternId = normalizedUuidSchema.parse(rawPatternId);
  const input = parseManualPreviewComplete(await readJson(request));
  return Response.json(
    await completeManualPreview({ ownerId: user.id, patternId, input }),
    { headers: { "Cache-Control": "private, no-store" } },
  );
});
