import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  generatedConceptAssetDtoSchema,
  inspirationVisualBoardDtoSchema,
  inspirationVisualJobDtoSchema,
  libraryMatchAssetDtoSchema,
  publicInspirationVisualBoardDtoSchema,
  researchVisualMutationSchema,
  webEvidenceAssetDtoSchema,
} from "./contracts";
import {
  generatedConceptAssetFixture,
  libraryMatchAssetFixture,
  visualBoardFixture,
  visualJobFixture,
  webEvidenceAssetFixture,
} from "./test-fixtures";

describe("inspiration visual contracts", () => {
  it("accepts only a public operation ID for a research refresh", () => {
    const input = { operationId: randomUUID() };

    expect(researchVisualMutationSchema.parse(input)).toEqual(input);
    expect(() =>
      researchVisualMutationSchema.parse({
        ...input,
        ownerId: randomUUID(),
      }),
    ).toThrow();
  });

  it("rejects inconsistent job targets and terminal states", () => {
    expect(() =>
      inspirationVisualJobDtoSchema.parse({
        ...visualJobFixture,
        directionIndex: 0,
      }),
    ).toThrow();
    expect(() =>
      inspirationVisualJobDtoSchema.parse({
        ...visualJobFixture,
        status: "failed",
        errorCode: null,
      }),
    ).toThrow();
    expect(() =>
      inspirationVisualJobDtoSchema.parse({
        ...visualJobFixture,
        status: "pending",
      }),
    ).toThrow();
  });

  it("keeps library matches free of ownership, score, and storage fields", () => {
    const parsed = libraryMatchAssetDtoSchema.parse(libraryMatchAssetFixture);

    expect(parsed).not.toHaveProperty("ownerId");
    expect(parsed).not.toHaveProperty("distance");
    expect(parsed).not.toHaveProperty("objectKey");
    expect(() =>
      libraryMatchAssetDtoSchema.parse({
        ...libraryMatchAssetFixture,
        distance: 0.12,
      }),
    ).toThrow();
  });

  it("accepts only uppercase palettes and bounded direction indexes", () => {
    expect(() =>
      libraryMatchAssetDtoSchema.parse({
        ...libraryMatchAssetFixture,
        palette: ["#66805e"],
      }),
    ).toThrow();
    expect(() =>
      libraryMatchAssetDtoSchema.parse({
        ...libraryMatchAssetFixture,
        directionIndex: 5,
      }),
    ).toThrow();
  });

  it("requires safe local image paths and HTTPS evidence sources", () => {
    expect(webEvidenceAssetDtoSchema.parse(webEvidenceAssetFixture)).toEqual(
      webEvidenceAssetFixture,
    );
    expect(() =>
      webEvidenceAssetDtoSchema.parse({
        ...webEvidenceAssetFixture,
        imageUrl: "https://provider.example/image.png",
      }),
    ).toThrow();
    expect(() =>
      webEvidenceAssetDtoSchema.parse({
        ...webEvidenceAssetFixture,
        sourcePageUrl: "http://example.test/source",
      }),
    ).toThrow();
  });

  it("requires generated save identifiers and links to change together", () => {
    expect(
      generatedConceptAssetDtoSchema.parse(generatedConceptAssetFixture),
    ).toEqual(generatedConceptAssetFixture);
    expect(() =>
      generatedConceptAssetDtoSchema.parse({
        ...generatedConceptAssetFixture,
        savedPatternId: randomUUID(),
      }),
    ).toThrow();
  });

  it("caps board collections without admitting unknown fields", () => {
    expect(inspirationVisualBoardDtoSchema.parse(visualBoardFixture)).toEqual(
      visualBoardFixture,
    );
    expect(() =>
      inspirationVisualBoardDtoSchema.parse({
        ...visualBoardFixture,
        webEvidence: Array(9).fill(webEvidenceAssetFixture),
      }),
    ).toThrow();
    expect(() =>
      inspirationVisualBoardDtoSchema.parse({
        ...visualBoardFixture,
        unknown: true,
      }),
    ).toThrow();
  });

  it("public output cannot contain private matches or saved-library metadata", () => {
    const publicBoard = {
      webEvidence: [webEvidenceAssetFixture],
      concepts: [
        {
          id: generatedConceptAssetFixture.id,
          kind: generatedConceptAssetFixture.kind,
          ordinal: generatedConceptAssetFixture.ordinal,
          directionIndex: generatedConceptAssetFixture.directionIndex,
          title: generatedConceptAssetFixture.title,
          altText: generatedConceptAssetFixture.altText,
          imageUrl: generatedConceptAssetFixture.imageUrl,
          width: generatedConceptAssetFixture.width,
          height: generatedConceptAssetFixture.height,
        },
      ],
    };

    expect(publicInspirationVisualBoardDtoSchema.parse(publicBoard)).toEqual(
      publicBoard,
    );
    expect(() =>
      publicInspirationVisualBoardDtoSchema.parse({
        ...publicBoard,
        libraryMatches: [libraryMatchAssetFixture],
      }),
    ).toThrow();
    expect(() =>
      publicInspirationVisualBoardDtoSchema.parse({
        ...publicBoard,
        concepts: [generatedConceptAssetFixture],
      }),
    ).toThrow();
  });
});
