import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  imageSearchFiltersSchema,
  imageSearchRequestFieldsSchema,
  internalImageSearchResponseSchema,
} from "./contracts";

const patternId = "10000000-0000-4000-8000-000000000001";

describe("image search contracts", () => {
  it("accepts only the library filter subset", () => {
    const filters = imageSearchFiltersSchema.parse({
      q: " floral ",
      formats: ["png"],
      tagIds: [randomUUID()],
      tagMode: "any",
      favorite: true,
      previewStatus: "manual",
      commercialState: "standard",
      authorizationField: randomUUID(),
      folderId: randomUUID(),
      includeDescendants: false,
    });

    expect(filters.q).toBe("floral");
    expect(filters.formats).toEqual(["png"]);
  });

  it.each([
    { cursor: "opaque" },
    { scope: "trash" },
    { sort: "name_asc" },
    { limit: 10 },
    { tagIds: Array.from({ length: 21 }, () => randomUUID()) },
  ])("rejects unsupported or oversized filters %#", (filters) => {
    expect(() => imageSearchFiltersSchema.parse(filters)).toThrow();
  });

  it("requires a canonical UUID v4 request ID", () => {
    expect(
      imageSearchRequestFieldsSchema.parse({
        filters: {},
        requestId: "123e4567-e89b-42d3-a456-426614174000",
      }).requestId,
    ).toBe("123e4567-e89b-42d3-a456-426614174000");

    for (const requestId of [
      "not-a-uuid",
      "123e4567-e89b-12d3-a456-426614174000",
    ]) {
      expect(() =>
        imageSearchRequestFieldsSchema.parse({ filters: {}, requestId }),
      ).toThrow();
    }
  });

  it("accepts at most 30 unique, known-category internal results", () => {
    const response = internalImageSearchResponseSchema.parse({
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      query: { width: 1200, height: 900 },
      items: [
        { patternId, kind: "probable_source", score: 0.99 },
        {
          patternId: "20000000-0000-4000-8000-000000000002",
          kind: "visually_similar",
          score: 0.7,
        },
      ],
    });

    expect(response.items).toHaveLength(2);
  });

  it("rejects unknown categories, duplicate IDs, and more than 30 results", () => {
    const base = {
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      query: { width: 1200, height: 900 },
    };
    expect(() =>
      internalImageSearchResponseSchema.parse({
        ...base,
        items: [{ patternId, kind: "unknown", score: 1 }],
      }),
    ).toThrow();
    expect(() =>
      internalImageSearchResponseSchema.parse({
        ...base,
        items: [
          { patternId, kind: "probable_source", score: 1 },
          { patternId, kind: "possible_source", score: 0.9 },
        ],
      }),
    ).toThrow();
    expect(() =>
      internalImageSearchResponseSchema.parse({
        ...base,
        items: Array.from({ length: 31 }, (_, index) => ({
          patternId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          kind: "visually_similar",
          score: 0.5,
        })),
      }),
    ).toThrow();
  });
});
