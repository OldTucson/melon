import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { requireUser } from "@/features/auth/session";
import { LibraryView } from "@/features/library/library-view";
import type { PatternPage } from "@/features/library/library-types";
import {
  parseLibrarySearchParams,
  searchParamsRecordToURLSearchParams,
  toPatternQuery,
} from "@/features/library/query-state";
import { listPatterns } from "@/features/patterns/pattern-service";
import { createQueryClient } from "@/lib/query/client";
import { queryKeys } from "@/lib/query/keys";

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
    query = toPatternQuery(parseLibrarySearchParams(rawSearchParams));
  } catch (error) {
    if (error instanceof ZodError) redirect("/library");
    throw error;
  }

  const queryClient = createQueryClient();
  await queryClient.prefetchInfiniteQuery({
    queryKey: queryKeys.patterns(query),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listPatterns({
        ownerId: user.id,
        input: { ...query, cursor: pageParam ?? undefined },
      }),
    initialPageParam: query.cursor ?? null,
    getNextPageParam: (lastPage: PatternPage) => lastPage.nextCursor,
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <LibraryView initialQuery={query} />
    </HydrationBoundary>
  );
}
