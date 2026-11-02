import { describe, expect, it } from "vitest";
import { inspirationResultFixture } from "@/features/inspiration/test-fixtures";
import { webEvidenceAssetFixture, webHeroAssetFixture, webProductAssetFixture, libraryMatchAssetFixture, generatedConceptAssetFixture } from "@/features/inspiration-visuals/test-fixtures";
import type { WebEvidenceAssetDto } from "@/features/inspiration-visuals/contracts";
import { selectDefaultConceptReferences } from "./reference-selector";

const direction = inspirationResultFixture.inspirationPrompts[0]!;
describe("default concept references", () => {
  it("ranks source overlap before role, product before evidence, and removes duplicate IDs", () => {
    const assets = [{ ...webHeroAssetFixture, sourceIndexes: [] }, webEvidenceAssetFixture, webProductAssetFixture, webProductAssetFixture];
    const before = structuredClone(assets);
    expect(selectDefaultConceptReferences({ direction, assets }).map(({ id }) => id)).toEqual([
      "00000000-0000-4000-8000-000000000108", "00000000-0000-4000-8000-000000000102", "00000000-0000-4000-8000-000000000107",
    ]);
    expect(assets).toEqual(before);
  });
  it("prefers overlapping hero evidence to a non-overlapping product", () => {
    expect(selectDefaultConceptReferences({ direction, assets: [{ ...webProductAssetFixture, sourceIndexes: [9] }, webHeroAssetFixture] }).map(({ role }) => role)).toEqual(["hero", "product"]);
  });
  it("uses ordinal then binary ID order for ties and caps unique choices at three", () => {
    const assets = [4, 3, 1, 2].map((n) => ({ ...webEvidenceAssetFixture, id: `00000000-0000-4000-8000-00000000000${n}`, ordinal: n === 4 ? 1 : 0 }));
    const want = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
    expect(selectDefaultConceptReferences({ direction, assets }).map(({ id }) => id)).toEqual(want);
    expect(selectDefaultConceptReferences({ direction, assets: assets.reverse() }).map(({ id }) => id)).toEqual(want);
  });
  it("falls back to report-wide external assets when direction has no sources", () => {
    expect(selectDefaultConceptReferences({ direction: { ...direction, sourceIndexes: [] }, assets: [webHeroAssetFixture, webEvidenceAssetFixture, webProductAssetFixture] }).map(({ role }) => role)).toEqual(["product", "evidence", "hero"]);
    expect(selectDefaultConceptReferences({ direction, assets: [] })).toEqual([]);
  });
  it("excludes private-library, generated and malformed assets even at runtime", () => {
    const assets = [libraryMatchAssetFixture, generatedConceptAssetFixture, { ...webEvidenceAssetFixture, imageUrl: "https://untrusted.test/image" }, webProductAssetFixture] as WebEvidenceAssetDto[];
    expect(selectDefaultConceptReferences({ direction, assets }).map(({ id }) => id)).toEqual(["00000000-0000-4000-8000-000000000108"]);
  });
});
