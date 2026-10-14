import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  patternQuerySchema,
  type PatternQuery,
} from "@/features/patterns/contracts";
import { QueryOwnerProvider } from "@/lib/query/provider";

import type { PatternItem } from "./library-types";
import { LibraryToolbar } from "./library-toolbar";
import { PatternCard } from "./pattern-card";
import {
  parseLibrarySearchParams,
  serializeLibrarySearchParams,
  toPatternQuery,
} from "./query-state";

const ownerId = "10000000-0000-4000-8000-000000000001";
const fieldId = "00000000-0000-4000-8000-000000000003";
const field = {
  id: fieldId,
  ownerId: null,
  scope: "system" as const,
  name: "口水巾",
  normalizedName: "口水巾",
  status: "active" as const,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  archivedAt: null,
};
const archivedField = {
  ...field,
  id: "00000000-0000-4000-8000-000000000004",
  name: "旧领域",
  normalizedName: "旧领域",
  status: "archived" as const,
  archivedAt: "2026-10-09T00:00:00.000Z",
};

const item = {
  id: "20000000-0000-4000-8000-000000000002",
  ownerId,
  name: "花叶",
  originalFilename: "leaf.png",
  extension: "png",
  detectedMimeType: "image/png",
  sizeBytes: "1024",
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
  commercialVersion: 2,
  commercialSummary: {
    state: "field_exclusive",
    activeCount: 2,
    revenueFen: "128000",
  },
  lastErrorCode: null,
  trashedAt: null,
  deletedAt: null,
  changeSeq: "1",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
} satisfies PatternItem;

function json(data: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderToolbar(
  onQueryChange: (query: PatternQuery) => void,
  query = patternQuerySchema.parse({}),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Tooltip.Provider>
          <LibraryToolbar
            inspectorHidden={false}
            onQueryChange={onQueryChange}
            onShowInspector={vi.fn()}
            onViewModeChange={vi.fn()}
            query={query}
            resultCount={1}
            selectedCount={0}
            viewMode="grid"
          />
        </Tooltip.Provider>
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
}

describe("commercial library filters", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/authorization-fields?includeArchived=true") {
          return json([field, archivedField]);
        }
        return json([]);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("round-trips commercial state and field in canonical URL state", () => {
    const raw = new URLSearchParams(
      `commercialState=field_exclusive&authorizationField=${fieldId}`,
    );
    const query = toPatternQuery(parseLibrarySearchParams(raw));

    expect(query).toMatchObject({
      commercialState: "field_exclusive",
      authorizationField: fieldId,
    });
    expect(serializeLibrarySearchParams(query).toString()).toBe(
      `commercialState=field_exclusive&authorizationField=${fieldId}`,
    );
  });

  it("updates both commercial filters and keeps the selected state", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn<(query: PatternQuery) => void>();
    renderToolbar(onQueryChange);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "按商业状态筛选" }),
      "field_exclusive",
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "口水巾" })).toBeInTheDocument(),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "按授权领域筛选" }),
      fieldId,
    );

    expect(onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        commercialState: "field_exclusive",
        authorizationField: fieldId,
        cursor: undefined,
      }),
    );
  });

  it("keeps an archived authorization field visible in a restored filter", async () => {
    renderToolbar(
      vi.fn(),
      patternQuerySchema.parse({ authorizationField: archivedField.id }),
    );

    const select = screen.getByRole("combobox", {
      name: "按授权领域筛选",
    });
    await waitFor(() => expect(select).toHaveValue(archivedField.id));
    expect(
      screen.getByRole("option", { name: "旧领域（已归档）" }),
    ).toBeInTheDocument();
  });

  it("renders one restrained commercial state with count and integer-safe income", () => {
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

    const summary = screen.getByLabelText("商业授权摘要");
    expect(summary).toHaveTextContent("领域独占");
    expect(summary).toHaveTextContent("2 笔");
    expect(summary).toHaveTextContent("¥1,280.00");
    expect(summary).not.toHaveTextContent("普通授权");
  });
});
