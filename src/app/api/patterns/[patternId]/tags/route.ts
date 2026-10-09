import { z } from "zod";

import { requireUser } from "@/features/auth/session";
import { listPatternTags } from "@/features/tags/tag-service";
import { withRoute } from "@/lib/http/route";

type PatternTagsContext = { params: Promise<{ patternId: string }> };

const patternIdSchema = z.string().uuid();

export const GET = withRoute<PatternTagsContext>(async (_request, context) => {
  const user = await requireUser();
  const { patternId: rawPatternId } = await context!.params;
  const patternId = patternIdSchema.parse(rawPatternId);
  return Response.json(await listPatternTags({ ownerId: user.id, patternId }));
});
