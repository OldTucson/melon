import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { requireUser } from "@/features/auth/session";
import { LibraryView } from "@/features/library/library-view";
import type { PatternPage } from "@/features/library/library-types";
import { searchParamsRecordToURLSearchParams } from "@/features/library/query-state";
import { parsePatternSearchParams } from "@/features/patterns/contracts";
import {
  getPattern,
  listPatterns,
} from "@/features/patterns/pattern-service";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { AppError } from "@/lib/http/app-error";
import { createQueryClient } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";
import { getServerEnv } from "@/lib/env/server";

const libraryStatuses = new Set([
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
]);

async function loadSelectedPattern(ownerId: string, rawId: string | null) {
  if (rawId === null) return null;
  const parsed = normalizedUuidSchema.safeParse(rawId);
  if (!parsed.success) redirect("/library");

  try {
    const pattern = await getPattern({ ownerId, patternId: parsed.data });
    if (pattern.status === "trashed" || pattern.status === "deleting") {
      redirect(`/trash?selected=${pattern.id}`);
    }
    if (!libraryStatuses.has(pattern.status)) redirect("/library");
    return pattern;
  } catch (error) {
    if (error instanceof AppError && error.status === 404) redirect("/library");
    throw error;
  }
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const rawSearchParams = searchParamsRecordToURLSearchParams(
    await searchParams,
  );
  let query;
  try {
    query = parsePatternSearchParams(rawSearchParams);
    if (query.scope === "trash") redirect("/library");
  } catch (error) {
    if (error instanceof ZodError) redirect("/library");
    throw error;
  }

  const queryClient = createQueryClient();
  const [selectedPattern] = await Promise.all([
    loadSelectedPattern(user.id, rawSearchParams.get("selected")),
    queryClient.prefetchInfiniteQuery({
      queryKey: queryKeys.patterns(user.id, query),
      queryFn: ({ pageParam }: { pageParam: string | null }) =>
        listPatterns({
          ownerId: user.id,
          input: { ...query, cursor: pageParam ?? undefined },
        }),
      initialPageParam: query.cursor ?? null,
      getNextPageParam: (lastPage: PatternPage) => lastPage.nextCursor,
    }),
  ]);
  if (selectedPattern) {
    queryClient.setQueryData(
      queryKeys.pattern(user.id, selectedPattern.id),
      selectedPattern,
    );
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LibraryView
        initialQuery={query}
        initialSelectedId={selectedPattern?.id}
        paletteEnabled={getServerEnv().IMAGE_SEARCH_ENABLED}
      />
    </HydrationBoundary>
  );
}
