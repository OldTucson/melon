import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseLibrarySearchParams, toPatternQuery } from "./query-state";
import type { PatternItem } from "./library-types";
import { BulkActionBar } from "./bulk-action-bar";
import { useSelectionStore } from "./selection-store";
import { QueryOwnerProvider } from "@/lib/query/provider";

const ownerId = "10000000-0000-4000-8000-000000000000";
const query = toPatternQuery(parseLibrarySearchParams(new URLSearchParams()));
const items = [1, 2].map((index): PatternItem => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  ownerId,
  name: `Pattern ${index}`,
  originalFilename: `pattern-${index}.png`,
  extension: "png",
  detectedMimeType: "image/png",
  sizeBytes: "1024",
  contentHash: null,
  status: "ready",
  folderId: null,
  trashBatchId: null,
  preTrashStatus: null,
  previewStatus: "ready",
  isFavorite: false,
  version: index,
  commercialVersion: 0,
  lastErrorCode: null,
  trashedAt: null,
  deletedAt: null,
  changeSeq: "0",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
}));

function renderBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Tooltip.Provider>
          <BulkActionBar
            activeQuery={query}
            loadedPatterns={items}
          />
        </Tooltip.Provider>
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
}

describe("bulk action bar", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    useSelectionStore.getState().clear();
    useSelectionStore.getState().selectAll(items.map((item) => item.id));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("cancels trash without sending a request", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    renderBar();

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    expect(screen.getByRole("dialog", { name: "移入回收站" })).toHaveTextContent(
      "2 个图案",
    );
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/patterns/batch",
      expect.anything(),
    );
  });

  it("confirms trash and restores the exact server-confirmed patterns with a new operation ID", async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/folders") return Response.json([]);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url === "/api/patterns/batch") {
        return Response.json({ patterns: items.map((item) => ({ ...item, status: "trashed", version: item.version + 1 })) });
      }
      if (url === "/api/trash/patterns/restore") {
        return Response.json({ state: "restored", patterns: items.map((item) => ({ id: item.id, status: "ready", folderId: null, version: item.version + 2, changeSeq: "2", updatedAt: item.updatedAt })) });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderBar();

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已将 2 个图案移入回收站");

    await user.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatchObject({ url: "/api/patterns/batch", body: { action: "trash" } });
    expect(calls[1]).toMatchObject({
      url: "/api/trash/patterns/restore",
      body: { patternIds: items.map((item) => item.id) },
    });
    expect(calls[1]!.body.operationId).not.toBe(calls[0]!.body.operationId);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("loads active folders and moves the selected versions to the chosen folder", async () => {
    const user = userEvent.setup();
    const folderId = "20000000-0000-4000-8000-000000000000";
    const batchBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/folders") {
        return Response.json([
          { id: folderId, name: "家居", parentId: null, status: "active" },
        ]);
      }
      if (url === "/api/patterns/batch") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        batchBodies.push(body);
        return Response.json({
          patterns: items.map((item) => ({
            ...item,
            folderId,
            version: item.version + 1,
          })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderBar();

    await user.click(screen.getByRole("button", { name: "移动" }));
    await user.click(await screen.findByRole("menuitem", { name: "家居" }));

    await waitFor(() => expect(batchBodies).toHaveLength(1));
    expect(batchBodies[0]).toMatchObject({
      action: "move",
      folderId,
      patterns: items.map(({ id, version }) => ({ id, version })),
    });
  });

  it("clears the current selection without a server request", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));

    expect(useSelectionStore.getState().selectedIds).toEqual([]);
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/patterns/batch",
      expect.anything(),
    );
  });
});
