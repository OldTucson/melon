import { requireUser } from "@/features/auth/session";
import { tagCreateMutationSchema } from "@/features/tags/contracts";
import { createTag, listTags } from "@/features/tags/tag-service";
import { readJson, withRoute } from "@/lib/http/route";

export const GET = withRoute(async () => {
  const user = await requireUser();
  return Response.json(await listTags({ ownerId: user.id }));
});

export const POST = withRoute(async (request: Request) => {
  const user = await requireUser();
  const mutation = tagCreateMutationSchema.parse(await readJson(request));
  const tag = await createTag({
    ownerId: user.id,
    operationId: mutation.operationId,
    name: mutation.input.name,
    colorToken: mutation.input.colorToken,
  });
  return Response.json(tag, { status: 201 });
});
