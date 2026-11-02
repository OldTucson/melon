import type { ConceptOutputAssetDto, ConceptSetDto, InspirationConceptBrief } from "./contracts";
import { inspirationResultFixture } from "@/features/inspiration/test-fixtures";

export const conceptAssetFixture: ConceptOutputAssetDto = {
  id: "00000000-0000-4000-8000-000000000011",
  kind: "sketch" as const,
  title: "通勤草图",
  altText: "柔和通勤设计草图",
  imageUrl: "/api/inspiration/concept-assets/00000000-0000-4000-8000-000000000011/image",
  width: 1536,
  height: 2048,
  createdAt: "2026-11-02T01:00:00.000Z",
};

export const conceptSetFixture: ConceptSetDto = {
  id: "00000000-0000-4000-8000-000000000012",
  directionIndex: 0,
  version: 1,
  status: "partial" as const,
  slots: [
    { kind: "sketch", asset: conceptAssetFixture, task: null },
    { kind: "effect", asset: null, task: { status: "failed", errorCode: "INSPIRATION_CONCEPT_TIMEOUT" } },
    { kind: "flat", asset: null, task: null },
  ],
  createdAt: "2026-11-02T01:00:00.000Z",
  completedAt: null,
};

export const conceptBriefFixture: InspirationConceptBrief = {
  schemaVersion: "inspiration-concept-brief-v1" as const,
  report: {
    headline: inspirationResultFixture.headline,
    summary: inspirationResultFixture.summary,
    marketSignals: [{ name: "通勤", rationale: "通勤设计需求", strength: "high" as const }],
  },
  directionIndex: 0,
  direction: inspirationResultFixture.inspirationPrompts[0]!,
  referenceAssetIds: [],
  promptTemplateVersion: "inspiration-concept-prompts-v1" as const,
  model: "qwen-image-3.0-pro" as const,
  sizes: { sketch: "1536*2048", effect: "1536*2048", flat: "2048*1536" },
};
