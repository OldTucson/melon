import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getSharedInspirationAnalysis } from "@/features/inspiration/share-service";
import { SharedInspirationPage } from "@/features/inspiration/shared-inspiration-page";
import { AppError } from "@/lib/http/app-error";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "女装灵感研究 | melon",
  robots: { index: false, follow: false },
};

export default async function SharedInspirationRoute({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  if (!z.string().uuid().safeParse(shareId).success) notFound();

  const analysis = await getSharedInspirationAnalysis(shareId).catch(
    (error: unknown) => {
      if (error instanceof AppError && error.status === 404) notFound();
      throw error;
    },
  );

  return <SharedInspirationPage analysis={analysis} />;
}
