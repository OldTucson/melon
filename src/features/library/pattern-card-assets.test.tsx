import * as Tooltip from "@radix-ui/react-tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PatternItem } from "./library-types";
import { PatternCard } from "./pattern-card";

const item: PatternItem = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000000",
  name: "Leaf",
  originalFilename: "leaf.png",
  extension: "png",
  detectedMimeType: "image/png",
  sizeBytes: "123",
  contentHash: null,
  status: "ready",
  folderId: null,
  trashBatchId: null,
  preTrashStatus: null,
  previewStatus: "ready",
  previewAssetId: "00000000-0000-4000-8000-000000000002",
  thumbnailAssetId: "00000000-0000-4000-8000-000000000003",
  sourceAssetId: "00000000-0000-4000-8000-000000000004",
  isFavorite: false,
  version: 0,
  commercialVersion: 0,
  lastErrorCode: null,
  trashedAt: null,
  deletedAt: null,
  changeSeq: "1",
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
};

describe("pattern card assets", () => {
  afterEach(cleanup);
  it("uses the short-lived view route and real source download route", () => {
    render(
      <Tooltip.Provider>
        <PatternCard
          item={item}
          mode="grid"
          onFavorite={vi.fn()}
          onOpenPreview={vi.fn()}
          onSelect={vi.fn()}
          selected={false}
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("img", { name: "Leaf 缩略图" })).toHaveAttribute(
      "src",
      `/api/assets/${item.thumbnailAssetId}/view`,
    );
    expect(screen.getByRole("link", { name: "下载 Leaf" })).toHaveAttribute(
      "href",
      `/api/assets/${item.sourceAssetId}/download`,
    );
  });

  it("falls back to the format placeholder when an image fails", () => {
    render(
      <Tooltip.Provider>
        <PatternCard
          item={item}
          mode="grid"
          onFavorite={vi.fn()}
          onOpenPreview={vi.fn()}
          onSelect={vi.fn()}
          selected={false}
        />
      </Tooltip.Provider>,
    );
    fireEvent.error(screen.getByRole("img", { name: "Leaf 缩略图" }));
    expect(screen.getByText("PNG")).toBeVisible();
  });
});
