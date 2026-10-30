import { describe, expect, it } from "vitest";

import { inspirationResultFixture, inspirationSourceFixture } from "@/features/inspiration/test-fixtures";
import type { WebEvidenceAssetDto } from "./contracts";
import { composeInspirationDocument, composePublicInspirationDocument } from "./document-composer";
import { inspirationDocumentDtoSchema, publicInspirationDocumentDtoSchema } from "./document-contracts";
import { generatedConceptAssetFixture, libraryMatchAssetFixture, webEvidenceAssetFixture, webHeroAssetFixture, webProductAssetFixture } from "./test-fixtures";

const sources = [inspirationSourceFixture, { ...inspirationSourceFixture, index: 7 }, { ...inspirationSourceFixture, index: 3 }];
const result = {
  ...inspirationResultFixture,
  marketSignals: [1, 7, 3, 1].map((index, ordinal) => ({ ...inspirationResultFixture.marketSignals[0]!, name: `Signal ${ordinal}`, sourceIndexes: [index] })),
};
const input = { result, sources };
const evidence = (ordinal: number, sourceIndexes: number[] = []): WebEvidenceAssetDto => ({
  ...webEvidenceAssetFixture, id: `00000000-0000-4000-8000-${String(ordinal + 200).padStart(12, "0")}`, ordinal, sourceIndexes,
});
const assetIds = (document: ReturnType<typeof composeInspirationDocument>) => [
  ...(document.hero ? [document.hero.id] : []),
  ...document.marketSignals.flatMap(({ evidence }) => evidence.map(({ id }) => id)),
  ...document.products.map(({ id }) => id),
];

describe("editorial document composition", () => {
  it("places the explicit hero and product roles without title inference and preserves product metadata", () => {
    const document = composeInspirationDocument({ ...input, webEvidence: [webProductAssetFixture, webHeroAssetFixture] });
    expect(Object.keys(document)).toEqual(["hero", "intro", "marketSignals", "dimensions", "products", "directions", "unassignedLibraryMatches", "sources"]);
    expect(document.hero?.id).toBe(webHeroAssetFixture.id);
    expect(document.intro).toEqual({ headline: result.headline, summary: result.summary, confidenceNote: result.confidenceNote });
    expect(document.products).toEqual([webProductAssetFixture]);
    const withoutHero = composeInspirationDocument({ ...input, webEvidence: [{ ...webProductAssetFixture, title: "hero 主视觉" }] });
    expect(withoutHero.hero).toBeNull();
    expect(withoutHero.marketSignals.every(({ evidence }) => evidence.length === 0)).toBe(true);
    expect(withoutHero.products[0]!).toMatchObject({ brand: "Melon", productName: "棉麻通勤衬衫", priceText: "¥299", sourceSiteName: "示例时尚站", sourcePageUrl: webProductAssetFixture.sourcePageUrl });
    expect(composeInspirationDocument({ ...input, webEvidence: [{ ...webProductAssetFixture, brand: null, priceText: null }] }).products[0]!).toMatchObject({ brand: null, priceText: null });
  });

  it("reserves source overlaps before filling only unillustrated signals by ordinal", () => {
    const assets = [evidence(5), evidence(4, [1, 7]), evidence(3), evidence(2, [1]), evidence(1, [7])];
    const document = composeInspirationDocument({ ...input, webEvidence: assets });
    expect(document.marketSignals.map(({ evidence }) => evidence.map(({ ordinal }) => ordinal))).toEqual([[2, 4], [1], [3], [5]]);
    expect(new Set(assetIds(document)).size).toBe(5);
    expect(composeInspirationDocument({ ...input, webEvidence: [...assets].reverse() })).toEqual(document);
    expect(assets.map(({ ordinal }) => ordinal)).toEqual([5, 4, 3, 2, 1]);
  });

  it("uses asset ID to break ordinal ties and drops evidence when there is no unillustrated signal", () => {
    const document = composeInspirationDocument({ ...input, result: { ...result, marketSignals: [result.marketSignals[0]!] }, webEvidence: [{ ...evidence(2), ordinal: 0 }, { ...evidence(1), ordinal: 0 }] });
    expect(document.marketSignals[0]!.evidence.map(({ id }) => id)).toEqual([evidence(1).id]);
    expect(composeInspirationDocument({ ...input, result: { ...result, marketSignals: [] }, webEvidence: [evidence(0)] }).marketSignals).toEqual([]);
  });

  it("keeps all six dimensions in report order including color hints and empty sections", () => {
    const document = composeInspirationDocument({ ...input, result: { ...result, dimensions: { ...result.dimensions, materials: [] } } });
    expect(document.dimensions.map(({ key, label }) => [key, label])).toEqual([
      ["silhouettes", "款式"], ["productTypes", "类型"], ["styles", "风格"], ["categories", "品类"], ["colors", "色款"], ["materials", "材质"],
    ]);
    expect(document.dimensions[4]!.items[0]!).toMatchObject({ colorHint: "#EEE8DA" });
    expect(document.dimensions[5]!.items).toEqual([]);
  });

  it("attaches private library matches and concepts only to their declared directions", () => {
    const document = composeInspirationDocument({ ...input, libraryMatches: [libraryMatchAssetFixture, { ...libraryMatchAssetFixture, id: evidence(1).id, directionIndex: 1 }], concepts: [generatedConceptAssetFixture] });
    expect(document.directions.map(({ libraryMatches }) => libraryMatches.map(({ id }) => id))).toEqual([[], [evidence(1).id], []]);
    expect(document.unassignedLibraryMatches).toEqual([libraryMatchAssetFixture]);
    expect(document.directions.map(({ concepts }) => concepts.map(({ id }) => id))).toEqual([[generatedConceptAssetFixture.id], [], []]);
    expect(composeInspirationDocument(input).directions.map(({ concepts }) => concepts)).toEqual([[], [], []]);
    expect(() => composeInspirationDocument({ ...input, concepts: [{ ...generatedConceptAssetFixture, directionIndex: 4 }] })).toThrow();
  });

  it("normalizes cross-report and out-of-range references everywhere to unique current-report order", () => {
    const dirty = [3, 100, 1, 7, 1];
    const document = composeInspirationDocument({
      ...input,
      result: { ...result, marketSignals: [{ ...result.marketSignals[0]!, sourceIndexes: dirty }], dimensions: { ...result.dimensions, colors: [{ ...result.dimensions.colors[0]!, sourceIndexes: dirty }] }, inspirationPrompts: result.inspirationPrompts.map((prompt) => ({ ...prompt, sourceIndexes: dirty })) },
      webEvidence: [{ ...webHeroAssetFixture, sourceIndexes: [100, 3, 1] }, { ...webProductAssetFixture, sourceIndexes: [100] }, evidence(1, [100])],
    });
    expect(document.marketSignals[0]!.signal.sourceIndexes).toEqual([1, 7, 3]);
    expect(document.marketSignals[0]!.evidence[0]!.sourceIndexes).toEqual([]);
    expect(document.dimensions[4]!.items[0]!.sourceIndexes).toEqual([1, 7, 3]);
    expect(document.directions.map(({ direction }) => direction.sourceIndexes)).toEqual([[1, 7, 3], [1, 7, 3], [1, 7, 3]]);
    expect(document.hero?.sourceIndexes).toEqual([1, 3]);
    expect(document.products[0]!.sourceIndexes).toEqual([]);
    expect(inspirationDocumentDtoSchema.parse(document)).toEqual(document);
    expect(inspirationDocumentDtoSchema.safeParse({ ...document, hero: { ...document.hero, sourceIndexes: [100] } }).success).toBe(false);
    expect(inspirationDocumentDtoSchema.safeParse({ ...document, hero: { ...document.hero, sourceIndexes: [3, 1] } }).success).toBe(false);
  });

  it.each([0, 1, 4, 8])("composes %i web assets into a strict DTO without duplicate placement", (count) => {
    const webEvidence = Array.from({ length: count }, (_, ordinal) => ordinal === 0 ? webHeroAssetFixture : ordinal < 4 ? evidence(ordinal, [1]) : { ...webProductAssetFixture, id: evidence(ordinal).id, ordinal });
    const document = composeInspirationDocument({ ...input, webEvidence });
    expect(inspirationDocumentDtoSchema.parse(document)).toEqual(document);
    expect(assetIds(document)).toHaveLength(count);
    expect(new Set(assetIds(document)).size).toBe(count);
    expect(document.directions.every(({ concepts }) => concepts.length === 0)).toBe(true);
  });

  it("fails closed on duplicate assets, multiple heroes and extra content fields", () => {
    expect(() => composeInspirationDocument({ ...input, webEvidence: [evidence(1, [1]), evidence(1, [1])] })).toThrow();
    expect(() => composeInspirationDocument({ ...input, webEvidence: [webHeroAssetFixture, { ...webHeroAssetFixture, id: evidence(1).id }] })).toThrow();
    expect(inspirationDocumentDtoSchema.safeParse({ ...composeInspirationDocument(input), visualState: "pending" }).success).toBe(false);
  });

  it("composes public assets with share paths and removes private library and saved-concept metadata", () => {
    const shareId = "00000000-0000-4000-8000-000000000900";
    const document = composePublicInspirationDocument({ ...input, shareId, webEvidence: [webHeroAssetFixture, webProductAssetFixture], libraryMatches: [libraryMatchAssetFixture], concepts: [{ ...generatedConceptAssetFixture, savedPatternId: libraryMatchAssetFixture.patternId, libraryHref: libraryMatchAssetFixture.libraryHref }] });
    expect(document.hero?.imageUrl).toBe(`/share/inspiration/${shareId}/assets/${webHeroAssetFixture.id}`);
    expect(document.products[0]!).toMatchObject({ imageUrl: `/share/inspiration/${shareId}/assets/${webProductAssetFixture.id}`, sourcePageUrl: webProductAssetFixture.sourcePageUrl });
    expect(document.unassignedLibraryMatches).toEqual([]);
    expect(document.directions.every(({ libraryMatches }) => libraryMatches.length === 0)).toBe(true);
    expect(document.directions[0]!.concepts[0]!).toMatchObject({ imageUrl: `/share/inspiration/${shareId}/assets/${generatedConceptAssetFixture.id}` });
    expect(JSON.stringify(document)).not.toMatch(/patternId|savedPatternId|libraryHref|\/api\//);
    expect(publicInspirationDocumentDtoSchema.parse(document)).toEqual(document);
    expect(publicInspirationDocumentDtoSchema.safeParse(composeInspirationDocument({ ...input, libraryMatches: [libraryMatchAssetFixture] })).success).toBe(false);
  });

  it("never uses a citation absent from this report to choose an evidence signal", () => {
    const document = composeInspirationDocument({ ...input,
      result: { ...result, marketSignals: [{ ...result.marketSignals[0]!, sourceIndexes: [100] }, { ...result.marketSignals[1]!, sourceIndexes: [7] }] },
      webEvidence: [evidence(1, [100, 7])],
    });
    expect(document.marketSignals.map(({ evidence }) => evidence.map(({ ordinal }) => ordinal))).toEqual([[], [1]]);
  });

  it("keeps the maximum twenty citations in current report order", () => {
    const sources = Array.from({ length: 20 }, (_, ordinal) => ({ ...inspirationSourceFixture, index: 50 - ordinal }));
    const document = composeInspirationDocument({ ...input, sources, webEvidence: [{ ...webHeroAssetFixture, sourceIndexes: Array.from({ length: 20 }, (_, ordinal) => 31 + ordinal) }] });
    expect(document.hero?.sourceIndexes).toEqual([50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31]);
    expect(inspirationDocumentDtoSchema.parse(document)).toEqual(document);
  });

  it("sorts products and direction assets by ordinal without refresh state affecting content", () => {
    const content = { ...input,
      webEvidence: [{ ...webProductAssetFixture, ordinal: 9 }, { ...webProductAssetFixture, id: evidence(1).id, ordinal: 1 }],
      libraryMatches: [{ ...libraryMatchAssetFixture, ordinal: 8 }, { ...libraryMatchAssetFixture, id: evidence(2).id, ordinal: 2 }],
      concepts: [{ ...generatedConceptAssetFixture, ordinal: 7 }, { ...generatedConceptAssetFixture, id: evidence(3).id, ordinal: 3 }],
    };
    const document = composeInspirationDocument(content);
    expect(document.products.map(({ ordinal }) => ordinal)).toEqual([1, 9]);
    expect(document.unassignedLibraryMatches.map(({ ordinal }) => ordinal)).toEqual([2, 8]);
    expect(document.directions[0]!.concepts.map(({ ordinal }) => ordinal)).toEqual([3, 7]);
    const refreshing = { ...content, refreshJob: { status: "pending" }, warnings: ["INSPIRATION_WEB_VISUALS_UNAVAILABLE"] };
    expect(composeInspirationDocument(refreshing)).toEqual(document);
  });

  it("rejects owner image routes at the public document schema boundary", () => {
    const ownerDocument = composeInspirationDocument({ ...input, webEvidence: [webHeroAssetFixture, evidence(1, [1]), webProductAssetFixture] });
    expect(publicInspirationDocumentDtoSchema.safeParse(ownerDocument).success).toBe(false);
  });

});
