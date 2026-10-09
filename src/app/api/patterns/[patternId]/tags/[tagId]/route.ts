import { z } from "zod";

import { requireUser } from "@/features/auth/session";
import { patternTagMutationSchema } from "@/features/tags/contracts";
import {
  addTagToPattern,
  removeTagFromPattern,
} from "@/features/tags/tag-service";
import { readJson, withRoute } from "@/lib/http/route";

type PatternTagContext = {
  params: Promise<{ patternId: string; tagId: string }>;
};

const relationParamsSchema = z.object({
  patternId: z.string().uuid(),
  tagId: z.string().uuid(),
});

export const PUT = withRoute<PatternTagContext>(async (request, context) => {
  const user = await requireUser();
  const { patternId, tagId } = relationParamsSchema.parse(
    await context!.params,
  );
  const { operationId } = patternTagMutationSchema.parse(
    await readJson(request),
  );
  return Response.json(
    await addTagToPattern({ ownerId: user.id, patternId, tagId, operationId }),
  );
});

export const DELETE = withRoute<PatternTagContext>(
  async (request, context) => {
    const user = await requireUser();
    const { patternId, tagId } = relationParamsSchema.parse(
      await context!.params,
    );
    const { operationId } = patternTagMutationSchema.parse(
      await readJson(request),
    );
    return Response.json(
      await removeTagFromPattern({
        ownerId: user.id,
        patternId,
        tagId,
        operationId,
      }),
    );
  },
);
