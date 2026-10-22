import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PatternItem } from "@/features/library/library-types";

import type { PaletteSearchResponse } from "./contracts";
import { PaletteSearchResults } from "./palette-search-results";

const ownerId = "10000000-0000-4000-8000-000000000000";

function makePattern(index: number): PatternItem {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ownerId,
    name: `Palette match ${index}`,
    originalFilename: `match-${index}.png`,
    extension: "png",
    detectedMimeType: "image/png",
    sizeBytes: "2048",
    contentHash: null,
    status: "ready",
    folderId: null,
    trashBatchId: null,
    preTrashStatus: null,
    previewStatus: "ready",
    previewAssetId: null,
    thumbnailAssetId: null,
    sourceAssetId: null,
    isFavorite: false,
    version: 0,
    commercialVersion: 0,
    paletteStatus: "ready",
    palette: [
      { hex: "#285947", coverage: 0.5 },
      { hex: "#CC9C3F", coverage: 0.3 },
      { hex: "#8F4038", coverage: 0.2 },
    ],
    lastErrorCode: null,
    trashedAt: null,
    deletedAt: null,
    changeSeq: String(index),
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  };
}

function response(items: PatternItem[]): PaletteSearchResponse {
  return {
    query: { colors: ["#285947"] },
    items,
    timing: { totalMs: 18 },
  };
}

function renderResults(
  overrides: Partial<React.ComponentProps<typeof PaletteSearchResults>> = {},
) {
  const props: React.ComponentProps<typeof PaletteSearchResults> = {
    busy: false,
    colors: ["#285947"],
    error: null,
    limitMessage: null,
    mode: "grid",
    onClear: vi.fn(),
    onFavorite: vi.fn(),
    onInspect: vi.fn(),
    onOpenPreview: vi.fn(),
    onPaletteToggle: vi.fn(),
    onRemoveColor: vi.fn(),
    onSelect: vi.fn(),
    response: response([makePattern(3), makePattern(1), makePattern(2)]),
    selectedIds: new Set<string>(),
    ...overrides,
  };
  render(
    <Tooltip.Provider>
      <PaletteSearchResults {...props} />
    </Tooltip.Provider>,
  );
  return props;
}

afterEach(cleanup);

describe("PaletteSearchResults", () => {
  it("preserves server order and lets result swatches update the query", () => {
    const props = renderResults();
    expect(
      screen.getAllByRole("listitem").map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Palette match 3, PNG",
      "Palette match 1, PNG",
      "Palette match 2, PNG",
    ]);

    const first = screen.getAllByRole("listitem")[0]!;
    fireEvent.click(
      within(first).getByRole("button", { name: "按颜色 #CC9C3F 搜索" }),
    );
    expect(props.onPaletteToggle).toHaveBeenCalledWith("#CC9C3F");
    expect(props.onInspect).not.toHaveBeenCalled();
  });

  it("keeps empty and error states inside the palette result region", () => {
    renderResults({
      error: "配色搜索暂时不可用",
      response: response([]),
    });
    const region = screen.getByRole("region", { name: "配色搜索结果" });

    expect(within(region).getByRole("alert")).toHaveTextContent(
      "配色搜索暂时不可用",
    );
    expect(within(region).getByText("没有找到接近这组配色的图案")).toBeVisible();
  });
});
