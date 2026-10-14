import { redirect } from "next/navigation";

import { requireUser } from "@/features/auth/session";
import { getPattern } from "@/features/patterns/pattern-service";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import {
  TrashView,
  type TrashDeepLinkTarget,
} from "@/features/trash/trash-view";
import { searchParamsRecordToURLSearchParams } from "@/features/library/query-state";
import { AppError } from "@/lib/http/app-error";

async function loadTarget(
  ownerId: string,
  rawId: string | null,
): Promise<TrashDeepLinkTarget | null> {
  if (rawId === null) return null;
  const parsed = normalizedUuidSchema.safeParse(rawId);
  if (!parsed.success) redirect("/trash");

  try {
    const pattern = await getPattern({ ownerId, patternId: parsed.data });
    if (pattern.status !== "trashed" && pattern.status !== "deleting") {
      if (pattern.status !== "deleted") {
        redirect(`/library?selected=${pattern.id}`);
      }
      redirect("/trash");
    }
    if (!pattern.trashBatchId) redirect("/trash");
    return {
      id: pattern.id,
      name: pattern.name,
      trashBatchId: pattern.trashBatchId,
    };
  } catch (error) {
    if (error instanceof AppError && error.status === 404) redirect("/trash");
    throw error;
  }
}

export default async function TrashPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const rawSearchParams = searchParamsRecordToURLSearchParams(
    await searchParams,
  );
  const initialTarget = await loadTarget(
    user.id,
    rawSearchParams.get("selected"),
  );
  return <TrashView initialTarget={initialTarget ?? undefined} />;
}
