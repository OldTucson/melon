import { z } from "zod";

import type { InspirationAnalysisResult, InspirationSource } from "@/features/inspiration/contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import {
  generatedConceptAssetDtoSchema, webEvidenceAssetDtoSchema,
  type GeneratedConceptAssetDto, type LibraryMatchAssetDto, type WebEvidenceAssetDto,
} from "./contracts";
import {
  inspirationDimensionKeys, inspirationDocumentDtoSchema, publicInspirationDocumentDtoSchema,
  type InspirationDocumentDto, type PublicInspirationDocumentDto,
} from "./document-contracts";

type CompositionInput = {
  result: InspirationAnalysisResult;
  sources: InspirationSource[];
  webEvidence?: WebEvidenceAssetDto[];
  libraryMatches?: LibraryMatchAssetDto[];
  concepts?: GeneratedConceptAssetDto[];
};

type PublicConcept = PublicInspirationDocumentDto["directions"][number]["concepts"][number];
type PublicCompositionInput = Omit<CompositionInput, "concepts"> & {
  shareId: string;
  concepts?: (GeneratedConceptAssetDto | PublicConcept)[];
};

const dimensionLabels = { silhouettes: "款式", productTypes: "类型", styles: "风格", categories: "品类", colors: "色款", materials: "材质" };

function ordered<T extends { ordinal: number; id: string }>(assets: T[]): T[] {
  return [...assets].sort((left, right) => left.ordinal - right.ordinal || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Pure content composition. Job/refresh state belongs to the caller's envelope. */
export function composeInspirationDocument(input: CompositionInput): InspirationDocumentDto {
  const { result, sources } = input;
  // Unknown references are removed, never remapped; report order is canonical.
  const withSources = <T extends { sourceIndexes: number[] }>(value: T): T => {
    const requested = new Set(value.sourceIndexes);
    return { ...value, sourceIndexes: sources.filter(({ index }) => requested.has(index)).map(({ index }) => index).slice(0, 20) };
  };
  const web = z.array(webEvidenceAssetDtoSchema).max(8).parse((input.webEvidence ?? []).map(withSources));
  // Keep accepting legacy DTOs, but research documents no longer include private library matches.
  const matches: LibraryMatchAssetDto[] = [];
  const concepts = z.array(generatedConceptAssetDtoSchema).max(15).parse(input.concepts ?? []);
  const assets = [...web, ...concepts];
  if (new Set(assets.map(({ id }) => id)).size !== assets.length) throw new Error("Duplicate document asset");
  if (web.filter(({ role }) => role === "hero").length > 1) throw new Error("Multiple document heroes");
  if (concepts.some(({ directionIndex }) => directionIndex !== null && directionIndex >= result.inspirationPrompts.length)) {
    throw new Error("Document asset has no matching direction");
  }

  const marketSignals = result.marketSignals.map((signal) => ({ signal: withSources(signal), evidence: [] as WebEvidenceAssetDto[] }));
  const remaining: WebEvidenceAssetDto[] = [];
  // Reserve every source-overlap match before ordinal fallback can occupy a slot.
  for (const asset of ordered(web).filter(({ role }) => role === "evidence")) {
    const match = marketSignals.find(({ signal }) => signal.sourceIndexes.some((index) => asset.sourceIndexes.includes(index)));
    if (match) match.evidence.push(asset);
    else remaining.push(asset);
  }
  for (const asset of remaining) {
    const empty = marketSignals.find(({ evidence }) => evidence.length === 0);
    if (empty) empty.evidence.push(asset);
  }

  return inspirationDocumentDtoSchema.parse({
    hero: web.find(({ role }) => role === "hero") ?? null,
    intro: { headline: result.headline, summary: result.summary, confidenceNote: result.confidenceNote },
    marketSignals,
    dimensions: inspirationDimensionKeys.map((key) => ({ key, label: dimensionLabels[key], items: result.dimensions[key].map(withSources) })),
    products: ordered(web).filter(({ role }) => role === "product"),
    directions: result.inspirationPrompts.map((direction, index) => ({
      direction: withSources(direction),
      libraryMatches: ordered(matches).filter(({ directionIndex }) => directionIndex === index),
      concepts: ordered(concepts).filter(({ directionIndex }) => directionIndex === index),
    })),
    unassignedLibraryMatches: ordered(matches).filter(({ directionIndex }) => directionIndex === null),
    sources,
  });
}

/** Rewrite resource paths and explicitly project public concept fields before composition. */
export function composePublicInspirationDocument(input: PublicCompositionInput): PublicInspirationDocumentDto {
  const shareId = normalizedUuidSchema.parse(input.shareId);
  const imageUrl = (assetId: string) => `/share/inspiration/${shareId}/assets/${normalizedUuidSchema.parse(assetId)}`;
  const document = composeInspirationDocument({
    result: input.result,
    sources: input.sources,
    webEvidence: (input.webEvidence ?? []).map((asset) => ({ ...asset, imageUrl: imageUrl(asset.id) })),
    libraryMatches: [],
    concepts: (input.concepts ?? []).map((asset) => ({
      id: asset.id, kind: asset.kind, ordinal: asset.ordinal, directionIndex: asset.directionIndex,
      title: asset.title, altText: asset.altText, imageUrl: imageUrl(asset.id), width: asset.width, height: asset.height,
      savedPatternId: null, libraryHref: null,
    })),
  });
  return publicInspirationDocumentDtoSchema.parse({
    ...document,
    directions: document.directions.map(({ direction, concepts }) => ({
      direction, libraryMatches: [],
      concepts: concepts.map(({ id, kind, ordinal, directionIndex, title, altText, imageUrl, width, height }) => ({
        id, kind, ordinal, directionIndex, title, altText, imageUrl, width, height,
      })),
    })),
  });
}
