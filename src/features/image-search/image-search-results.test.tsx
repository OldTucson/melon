import * as Tooltip from "@radix-ui/react-tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PatternItem } from "@/features/library/library-types";

import type { ImageSearchResponse } from "./image-search-client";
import { ImageSearchResults } from "./image-search-results";

const ownerId = "10000000-0000-4000-8000-000000000000";

function makeResult(
  index: number,
  matchKind: NonNullable<PatternItem["matchKind"]>,
): PatternItem & { matchKind: NonNullable<PatternItem["matchKind"]> } {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ownerId,
    name: `Match ${index}`,
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
    paletteStatus: "pending",
    palette: [],
    lastErrorCode: null,
    trashedAt: null,
    deletedAt: null,
    changeSeq: String(index),
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    matchKind,
  };
}

function response(
  groups: ImageSearchResponse["groups"],
): ImageSearchResponse {
  return {
    query: { width: 640, height: 480 },
    groups,
    timing: { totalMs: 42 },
  };
}

function renderResults(
  groups: ImageSearchResponse["groups"],
  overrides: Partial<React.ComponentProps<typeof ImageSearchResults>> = {},
) {
  const props: React.ComponentProps<typeof ImageSearchResults> = {
    mode: "grid",
    onExit: vi.fn(),
    onFavorite: vi.fn(),
    onInspect: vi.fn(),
    onOpenPreview: vi.fn(),
    onSelect: vi.fn(),
    response: response(groups),
    selectedIds: new Set<string>(),
    thumbnailUrl: "blob:query-image",
    ...overrides,
  };
  render(
    <Tooltip.Provider>
      <ImageSearchResults {...props} />
    </Tooltip.Provider>,
  );
  return props;
}

describe("image search results", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("orders non-empty groups canonically and caps the rendered result set at 30", () => {
    const visual = Array.from({ length: 29 }, (_, index) =>
      makeResult(index + 3, "visually_similar"),
    );
    renderResults([
      { kind: "visually_similar", items: visual },
      { kind: "possible_source", items: [] },
      {
        kind: "probable_source",
        items: [makeResult(1, "probable_source"), makeResult(2, "probable_source")],
      },
    ]);

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "高概率原图",
      "视觉相似",
    ]);
    expect(screen.queryByRole("heading", { name: "可能是原图" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(30);
    expect(screen.getByText("30 个结果")).toBeVisible();
    expect(screen.queryByText("Match 31")).not.toBeInTheDocument();
  });

  it("shows the query thumbnail and an explicit no-source message", () => {
    renderResults([
      {
        kind: "visually_similar",
        items: [makeResult(1, "visually_similar")],
      },
    ]);

    expect(screen.getByRole("img", { name: "查询图片" })).toHaveAttribute(
      "src",
      "blob:query-image",
    );
    expect(screen.getByText("未找到可能的原图")).toBeVisible();
  });

  it("keeps checkbox selection and inspector opening as separate events", () => {
    const item = makeResult(1, "probable_source");
    const props = renderResults([
      { kind: "probable_source", items: [item] },
    ]);
    const card = screen.getByRole("listitem", { name: /Match 1/ });

    fireEvent.click(within(card).getByRole("checkbox"));
    expect(props.onSelect).toHaveBeenCalledWith(item.id, expect.any(Object));
    expect(props.onInspect).not.toHaveBeenCalled();

    vi.mocked(props.onSelect).mockClear();
    fireEvent.click(
      within(card).getByRole("button", { name: "打开 Match 1 检查器" }),
      { detail: 0 },
    );
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onInspect).toHaveBeenCalledWith(item.id);
  });

  it("allows a result palette to enter or extend palette search", () => {
    const item = {
      ...makeResult(1, "probable_source"),
      paletteStatus: "ready" as const,
      palette: [
        { hex: "#285947", coverage: 0.5 },
        { hex: "#CC9C3F", coverage: 0.3 },
        { hex: "#8F4038", coverage: 0.2 },
      ],
    };
    const onPaletteToggle = vi.fn();
    const props = renderResults(
      [{ kind: "probable_source", items: [item] }],
      {
        onPaletteToggle,
        paletteEnabled: true,
        selectedPaletteColors: new Set(["#285947"]),
      },
    );
    const card = screen.getByRole("listitem", { name: /Match 1/ });

    fireEvent.click(
      within(card).getByRole("button", { name: "按颜色 #285947 搜索" }),
    );
    expect(onPaletteToggle).toHaveBeenCalledWith("#285947");
    expect(props.onInspect).not.toHaveBeenCalled();
  });
});
