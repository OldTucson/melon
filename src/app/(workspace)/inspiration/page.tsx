import { dehydrate, HydrationBoundary } from "@tanstack/react-query";

import { requireUser } from "@/features/auth/session";
import { listInspirationAnalyses } from "@/features/inspiration/analysis-service";
import { InspirationView } from "@/features/inspiration/inspiration-view";
import { inspirationKeys } from "@/features/inspiration/query-keys";
import { createQueryClient } from "@/lib/query/client";

export default async function InspirationPage() {
  const user = await requireUser();
  const firstPage = await listInspirationAnalyses({
    ownerId: user.id,
    limit: 20,
  });
  const queryClient = createQueryClient();
  queryClient.setQueryData(inspirationKeys.list(user.id), {
    pages: [firstPage],
    pageParams: [undefined],
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <InspirationView />
    </HydrationBoundary>
  );
}
