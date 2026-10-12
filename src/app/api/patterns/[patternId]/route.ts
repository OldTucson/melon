import { requireUser } from "@/features/auth/session";
import { patternMutationSchema } from "@/features/patterns/contracts";
import {
  getPattern,
  updatePattern,
} from "@/features/patterns/pattern-service";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { readJson, withRoute } from "@/lib/http/route";

type PatternContext = { params: Promise<{ patternId: string }> };

export const GET = withRoute<PatternContext>(async (_request, context) => {
  const user = await requireUser();
  const { patternId: rawPatternId } = await context!.params;
  const patternId = normalizedUuidSchema.parse(rawPatternId);
  return Response.json(await getPattern({ ownerId: user.id, patternId }));
});

export const PATCH = withRoute<PatternContext>(async (request, context) => {
  const user = await requireUser();
  const { patternId: rawPatternId } = await context!.params;
  const patternId = normalizedUuidSchema.parse(rawPatternId);
  const mutation = patternMutationSchema.parse(await readJson(request));
  return Response.json(
    await updatePattern({
      ownerId: user.id,
      patternId,
      operationId: mutation.operationId,
      patch: mutation.patch,
    }),
  );
});
