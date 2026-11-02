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

  const evidence = {
    ...webEvidenceAssetFixture,
    role: "evidence",
    sourceIndexes: [3, 1],
    brand: null,
    productName: null,
    priceText: null,
  };
  const product = {
    ...evidence,
    role: "product",
    brand: "Melon",
    productName: "棉麻衬衫",
    priceText: "¥299",
  };

  it.each(["hero", "evidence", "product"])(
    "accepts the web document role %s",
    (role) => {
      const asset = role === "product" ? product : { ...evidence, role };
      expect(webEvidenceAssetDtoSchema.parse(asset)).toEqual(asset);
    },
  );

  it("preserves unique source index order and accepts up to twenty references", () => {
    expect(webEvidenceAssetDtoSchema.parse(evidence).sourceIndexes).toEqual([
      3, 1,
    ]);
    expect(
      webEvidenceAssetDtoSchema.safeParse({
        ...evidence,
        sourceIndexes: Array.from({ length: 20 }, (_, index) => index + 1),
      }).success,
    ).toBe(true);
  });

  it.each(
    [
      [],
      [1, 1],
      [0],
      [101],
      [1.5],
      Array.from({ length: 21 }, (_, index) => index + 1),
    ].map((sourceIndexes) => ({ sourceIndexes })),
  )(
    "checks bounded unique source indexes: $sourceIndexes",
    ({ sourceIndexes }) => {
      // An empty array is valid for migrated legacy evidence.
      expect(
        webEvidenceAssetDtoSchema.safeParse({ ...evidence, sourceIndexes })
          .success,
      ).toBe(sourceIndexes.length === 0);
    },
  );

  it.each([
    { role: "cover" },
    { role: undefined },
    { sourceIndexes: undefined },
    { role: "product", productName: null },
    { role: "product", productName: "   " },
    { brand: "Melon" },
    { productName: "衬衫" },
    { priceText: "¥299" },
    { role: "hero", brand: "Melon" },
  ])("rejects invalid web role metadata %j", (overrides) => {
    expect(
      webEvidenceAssetDtoSchema.safeParse({ ...evidence, ...overrides })
        .success,
    ).toBe(false);
  });

  it.each([
    ["brand", 120],
    ["productName", 300],
    ["priceText", 120],
  ] as const)("bounds product %s at %i characters", (field, max) => {
    expect(
      webEvidenceAssetDtoSchema.safeParse({
        ...product,
        [field]: "a".repeat(max),
      }).success,
    ).toBe(true);
    expect(
      webEvidenceAssetDtoSchema.safeParse({
        ...product,
        [field]: "a".repeat(max + 1),
      }).success,
    ).toBe(false);
  });

  it.each([
    "ownerId",
    "requestId",
    "providerRequestId",
    "objectKey",
    "remoteImageUrl",
  ])("rejects private browser metadata %s", (field) => {
    expect(
      webEvidenceAssetDtoSchema.safeParse({ ...evidence, [field]: "private" })
        .success,
    ).toBe(false);
  });

  it.each([libraryMatchAssetDtoSchema, generatedConceptAssetDtoSchema])(
    "keeps document roles exclusive to web evidence",
    (schema) => {
      const fixture =
        schema === libraryMatchAssetDtoSchema
          ? libraryMatchAssetFixture
          : generatedConceptAssetFixture;
      expect(schema.safeParse({ ...fixture, role: "hero" }).success).toBe(
        false,
      );
    },
  );

  it.each([
    inspirationVisualBoardDtoSchema,
    publicInspirationVisualBoardDtoSchema,
  ])("limits both board variants to one hero and four products", (schema) => {
    const base =
      schema === inspirationVisualBoardDtoSchema
        ? visualBoardFixture
        : { concepts: [] };
    const hero = { ...evidence, role: "hero" };
    expect(
      schema.safeParse({
        ...base,
        webEvidence: [hero, ...Array(4).fill(product)],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...base, webEvidence: [hero, hero] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...base, webEvidence: Array(5).fill(product) })
        .success,
    ).toBe(false);
  });
});

it("carries existing concept sets while generation is unavailable", () => {
  const input = { ...visualBoardFixture, conceptGenerationAvailable: false, conceptSets: [] };
  expect(inspirationVisualBoardDtoSchema.parse(input)).toMatchObject({ conceptGenerationAvailable: false, conceptSets: [] });
});
