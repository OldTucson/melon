import { z } from "zod";

import { requireUser } from "@/features/auth/session";
import {
  tagDeleteMutationSchema,
  tagPatchMutationSchema,
} from "@/features/tags/contracts";
import { deleteTag, updateTag } from "@/features/tags/tag-service";
import { readJson, withRoute } from "@/lib/http/route";

type TagContext = { params: Promise<{ tagId: string }> };

const tagIdSchema = z.string().uuid();

export const PATCH = withRoute<TagContext>(async (request, context) => {
  const user = await requireUser();
  const { tagId: rawTagId } = await context!.params;
  const tagId = tagIdSchema.parse(rawTagId);
  const mutation = tagPatchMutationSchema.parse(await readJson(request));
  return Response.json(
    await updateTag({
      ownerId: user.id,
      tagId,
      operationId: mutation.operationId,
      patch: mutation.patch,
    }),
  );
});

export const DELETE = withRoute<TagContext>(async (request, context) => {
  const user = await requireUser();
  const { tagId: rawTagId } = await context!.params;
  const tagId = tagIdSchema.parse(rawTagId);
  const mutation = tagDeleteMutationSchema.parse(await readJson(request));
  return Response.json(
    await deleteTag({
      ownerId: user.id,
      tagId,
      operationId: mutation.operationId,
    }),
  );
});
