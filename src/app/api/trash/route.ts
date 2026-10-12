import { requireUser } from "@/features/auth/session";
import { listTrash } from "@/features/trash/trash-service";
import { withRoute } from "@/lib/http/route";

export const GET = withRoute(async () => {
  const user = await requireUser();
  return Response.json(await listTrash({ ownerId: user.id }));
});
