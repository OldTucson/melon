import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { imageSearchFiltersSchema } from "@/features/image-search/contracts";
import type { PatternItem } from "@/features/library/library-types";
import type { InspirationAnalysisResult } from "@/features/inspiration/contracts";
import { inspirationResultFixture } from "@/features/inspiration/test-fixtures";
import type { searchPatternsByPalette } from "@/features/palette-search/palette-search-service";
import { AppError } from "@/lib/http/app-error";

import {
  extractResearchPalettes,
  matchLibraryPatterns,
} from "./library-matcher";

vi.mock("@/features/palette-search/palette-search-service", () => ({
  searchPatternsByPalette: vi.fn(),
}));

type PaletteSearchInput = Parameters<typeof searchPatternsByPalette>[0];

const pattern = (
  ownerId: string,
  overrides: Partial<PatternItem> = {},
): PatternItem => ({
  id: randomUUID(),
  ownerId,
  name: "雨后花园",
  originalFilename: "garden.png",
  extension: "png",
  detectedMimeType: "image/png",
  sizeBytes: "1024",
  contentHash: null,
  status: "ready",
  folderId: null,
  trashBatchId: null,
  preTrashStatus: null,
  previewStatus: "ready",
  previewAssetId: randomUUID(),
  thumbnailAssetId: randomUUID(),
  sourceAssetId: randomUUID(),
  isFavorite: false,
  version: 0,
  commercialVersion: 0,
  paletteStatus: "ready",
  palette: [{ hex: "#66805E", coverage: 1 }],
  lastErrorCode: null,
  trashedAt: null,
  deletedAt: null,
  changeSeq: "0",
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  ...overrides,
});

const withPalettes = (
  overview: Array<string | null>,
  directions: string[][],
): InspirationAnalysisResult => ({
  ...inspirationResultFixture,
  dimensions: {
    ...inspirationResultFixture.dimensions,
    colors: overview.map((colorHint, index) => ({
      ...inspirationResultFixture.dimensions.colors[0]!,
      name: `颜色 ${index}`,
      colorHint: colorHint as `#${string}` | null,
    })),
  },
  inspirationPrompts: inspirationResultFixture.inspirationPrompts.map(
    (prompt, index) => ({
      ...prompt,
      palette: directions[index] ?? [],
    }),
  ),
});

describe("inspiration library matcher", () => {
  it("extracts only unique exact hex colors without guessing named colors", () => {
    const result = withPalettes(
      ["#112233", "#112233", null, "#445566"],
      [
        [
          "鼠尾草绿",
          "#778899",
          "#778899",
          "#AABBCC",
          "#DDEEFF",
          "#123456",
          "#654321",
          "#ABCDEF",
          "#aabbcc",
        ],
        ["米白"],
        ["#010203"],
      ],
    );

    expect(extractResearchPalettes(result)).toEqual({
      overview: ["#112233", "#445566"],
      directions: [
        ["#778899", "#AABBCC", "#DDEEFF", "#123456", "#654321"],
        [],
        ["#010203"],
      ],
    });
  });

  it("matches the owner scope, filters unusable patterns, and assigns global ordinals", async () => {
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const signal = new AbortController().signal;
    const requestIds = Array.from({ length: 4 }, () => randomUUID());
    const overviewItems = Array.from({ length: 10 }, (_, index) =>
      pattern(ownerId, { name: `总览 ${index}` }),
    );
    const calls: PatternItem[][] = [
      [
        overviewItems[0]!,
        overviewItems[0]!,
        pattern(otherOwnerId),
        pattern(ownerId, { status: "trashed", trashedAt: "2026-10-29T00:00:00.000Z" }),
        pattern(ownerId, { thumbnailAssetId: null, previewAssetId: null }),
        ...overviewItems,
      ],
      Array.from({ length: 4 }, (_, index) =>
        pattern(ownerId, { name: `方向一 ${index}` }),
      ),
      Array.from({ length: 4 }, (_, index) =>
        pattern(ownerId, { name: `方向二 ${index}` }),
      ),
      Array.from({ length: 4 }, (_, index) =>
        pattern(ownerId, { name: `方向三 ${index}` }),
      ),
    ];
    let callIndex = 0;
    const search = vi.fn(async (input: PaletteSearchInput) => ({
      query: { colors: [...input.colors] },
      items: calls[callIndex++]!,
      timing: { totalMs: 1 },
    }));
    const result = withPalettes(
      ["#112233"],
      [["#223344"], ["#334455"], ["#445566"]],
    );

    const matched = await matchLibraryPatterns(
      { ownerId, result, signal },
      {
        isEnabled: () => true,
        createRequestId: () => requestIds.shift()!,
        search,
      },
    );

    expect(search).toHaveBeenCalledTimes(4);
    expect(search.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        ownerId,
        colors: ["#112233"],
        filters: imageSearchFiltersSchema.parse({}),
        signal,
      }),
      expect.objectContaining({ ownerId, colors: ["#223344"], signal }),
      expect.objectContaining({ ownerId, colors: ["#334455"], signal }),
      expect.objectContaining({ ownerId, colors: ["#445566"], signal }),
    ]);
    const usedRequestIds = search.mock.calls.map(([input]) => input.requestId);
    expect(new Set(usedRequestIds)).toHaveLength(4);
    expect(matched.assets).toHaveLength(17);
    expect(matched.assets.map(({ ordinal }) => ordinal)).toEqual(
      Array.from({ length: 17 }, (_, index) => index),
    );
    expect(matched.assets.map(({ directionIndex }) => directionIndex)).toEqual([
      ...Array(8).fill(null),
      ...Array(3).fill(0),
      ...Array(3).fill(1),
      ...Array(3).fill(2),
    ]);
    expect(matched.assets[0]).toEqual({
      kind: "library_match",
      ordinal: 0,
      directionIndex: null,
      title: "总览 0",
      altText: "总览 0 的图库图案预览",
      patternId: overviewItems[0]!.id,
    });
    expect(matched.warnings).toEqual([]);
    expect(JSON.stringify(matched)).not.toMatch(/ownerId|objectKey|distance/i);
  });

  it("caps the combined result at the board contract limit", async () => {
    const ownerId = randomUUID();
    const search = vi.fn(async (input: PaletteSearchInput) => ({
      query: { colors: [...input.colors] },
      items: Array.from({ length: 10 }, () => pattern(ownerId)),
      timing: { totalMs: 1 },
    }));
    const fiveDirections = Array.from({ length: 5 }, (_, index) => ({
      ...inspirationResultFixture.inspirationPrompts[0]!,
      title: `方向 ${index}`,
      palette: [`#00000${index}`],
    }));
    const result: InspirationAnalysisResult = {
      ...withPalettes(["#112233"], []),
      inspirationPrompts: fiveDirections,
    };

    const matched = await matchLibraryPatterns(
      { ownerId, result, signal: new AbortController().signal },
      { isEnabled: () => true, search },
    );

    expect(matched.assets).toHaveLength(20);
    expect(matched.assets.at(-1)).toMatchObject({
      ordinal: 19,
      directionIndex: 3,
    });
  });

  it("returns an empty warning without searching when the report has no exact colors", async () => {
    const search = vi.fn();
    const matched = await matchLibraryPatterns(
      {
        ownerId: randomUUID(),
        result: withPalettes([null], [["鼠尾草绿"], ["米白"], []]),
        signal: new AbortController().signal,
      },
      { isEnabled: () => true, search },
    );

    expect(search).not.toHaveBeenCalled();
    expect(matched).toEqual({
      assets: [],
      warnings: ["INSPIRATION_LIBRARY_MATCH_EMPTY"],
    });
  });

  it.each([
    ["PALETTE_SEARCH_NO_INDEX", "INSPIRATION_LIBRARY_MATCH_EMPTY"],
    ["PALETTE_SEARCH_UNAVAILABLE", "INSPIRATION_LIBRARY_MATCH_UNAVAILABLE"],
    ["PALETTE_SEARCH_TIMEOUT", "INSPIRATION_LIBRARY_MATCH_UNAVAILABLE"],
  ] as const)("degrades %s into %s", async (code, warning) => {
    const matched = await matchLibraryPatterns(
      {
        ownerId: randomUUID(),
        result: withPalettes(["#112233"], [[], [], []]),
        signal: new AbortController().signal,
      },
      {
        isEnabled: () => true,
        search: vi.fn(async () => {
          throw new AppError(code, code === "PALETTE_SEARCH_NO_INDEX" ? 409 : 503, code);
        }),
      },
    );

    expect(matched).toEqual({ assets: [], warnings: [warning] });
  });

  it("honors the image-search release gate", async () => {
    const search = vi.fn();
    const matched = await matchLibraryPatterns(
      {
        ownerId: randomUUID(),
        result: withPalettes(["#112233"], [[], [], []]),
        signal: new AbortController().signal,
      },
      { isEnabled: () => false, search },
    );

    expect(search).not.toHaveBeenCalled();
    expect(matched).toEqual({
      assets: [],
      warnings: ["INSPIRATION_LIBRARY_MATCH_DISABLED"],
    });
  });

  it("does not hide cancellation or unexpected implementation failures", async () => {
    const error = new Error("unexpected");
    await expect(
      matchLibraryPatterns(
        {
          ownerId: randomUUID(),
          result: withPalettes(["#112233"], [[], [], []]),
          signal: new AbortController().signal,
        },
        {
          isEnabled: () => true,
          search: vi.fn(async () => {
            throw error;
          }),
        },
      ),
    ).rejects.toBe(error);
  });
});
