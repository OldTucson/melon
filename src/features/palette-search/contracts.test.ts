import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  internalPaletteSearchRequestSchema,
  internalPaletteSearchResponseSchema,
  paletteSearchErrorCodes,
  paletteSearchRequestSchema,
} from "./contracts";

const ownerId = "10000000-0000-4000-8000-000000000001";
const patternId = "20000000-0000-4000-8000-000000000002";
const requestId = "123e4567-e89b-42d3-a456-426614174000";

describe("palette search contracts", () => {
  it("accepts one to five unique uppercase colors and shared filters", () => {
    const parsed = paletteSearchRequestSchema.parse({
      requestId,
      colors: ["#285947", "#CC9C3F"],
      filters: { favorite: true },
    });

    expect(parsed).toEqual({
      requestId,
      colors: ["#285947", "#CC9C3F"],
      filters: {
        favorite: true,
        formats: [],
        tagIds: [],
        tagMode: "all",
        includeDescendants: true,
      },
    });
  });

  it.each([
    { colors: [] },
    { colors: ["#285947", "#285947"] },
    { colors: ["#CC9C3F".toLowerCase()] },
    { colors: ["#12345G"] },
    {
      colors: [
        "#000000",
        "#111111",
        "#222222",
        "#333333",
        "#444444",
        "#555555",
      ],
    },
  ])("rejects invalid color collections %#", ({ colors }) => {
    expect(
      paletteSearchRequestSchema.safeParse({ requestId, colors, filters: {} })
        .success,
    ).toBe(false);
  });

  it("rejects unknown public fields and non-v4 request IDs", () => {
    expect(
      paletteSearchRequestSchema.safeParse({
        requestId,
        colors: ["#285947"],
        filters: {},
        ownerId,
      }).success,
    ).toBe(false);
    expect(
      paletteSearchRequestSchema.safeParse({
        requestId: "123e4567-e89b-52d3-a456-426614174000",
        colors: ["#285947"],
        filters: {},
      }).success,
    ).toBe(false);
  });

  it("defines the exact strict internal request contract", () => {
    expect(
      internalPaletteSearchRequestSchema.parse({
        ownerId,
        allowedPatternIds: [patternId],
        requestId,
        colors: ["#285947"],
      }),
    ).toEqual({
      ownerId,
      allowedPatternIds: [patternId],
      requestId,
      colors: ["#285947"],
    });
    expect(
      internalPaletteSearchRequestSchema.safeParse({
        ownerId,
        allowedPatternIds: [patternId, patternId],
        requestId,
        colors: ["#285947"],
      }).success,
    ).toBe(false);
  });

  it("accepts at most 30 unique ranked results with finite nonnegative distances", () => {
    expect(
      internalPaletteSearchResponseSchema.parse({
        requestId,
        query: { colors: ["#285947"] },
        items: [{ patternId, distance: 0.0125 }],
      }).items,
    ).toEqual([{ patternId, distance: 0.0125 }]);

    for (const items of [
      [
        { patternId, distance: 0.1 },
        { patternId, distance: 0.2 },
      ],
      [{ patternId, distance: -0.1 }],
      [{ patternId, distance: Number.POSITIVE_INFINITY }],
      Array.from({ length: 31 }, (_, index) => ({
        patternId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        distance: index / 100,
      })),
    ]) {
      expect(
        internalPaletteSearchResponseSchema.safeParse({
          requestId,
          query: { colors: ["#285947"] },
          items,
        }).success,
      ).toBe(false);
    }
    expect(
      internalPaletteSearchResponseSchema.safeParse({
        requestId,
        query: { colors: ["#285947"] },
        items: [{ patternId: randomUUID().toUpperCase(), distance: 0.1 }],
      }).success,
    ).toBe(false);
  });

  it("publishes only the approved stable error codes", () => {
    expect(paletteSearchErrorCodes).toEqual([
      "PALETTE_SEARCH_INVALID_COLORS",
      "PALETTE_SEARCH_NO_INDEX",
      "PALETTE_SEARCH_TIMEOUT",
      "PALETTE_SEARCH_UNAVAILABLE",
    ]);
  });
});
