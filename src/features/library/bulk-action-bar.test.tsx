import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "@/lib/query/keys";
import { QueryOwnerProvider } from "@/lib/query/provider";

import { parseLibrarySearchParams, toPatternQuery } from "./query-state";
import type { PatternItem } from "./library-types";
import { BulkActionBar } from "./bulk-action-bar";
import { useSelectionStore } from "./selection-store";
import { useCreateFolderMutation } from "@/features/folders/folder-mutations";
import { dashboardKeys } from "@/features/analytics/query-keys";

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
  previewAssetId: null,
  thumbnailAssetId: null,
  sourceAssetId: null,
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
const deletionImpact = {
  activeAuthorizationCount: 2,
  activeRevenueFen: "100000",
  totalAuthorizationCount: 3,
  assetCount: 4,
  purgeOn: "2026-11-13T00:00:00.000Z",
};

function CreateFolderButton() {
  const mutation = useCreateFolderMutation();
  return <button onClick={() => mutation.mutate({
    operationId: "30000000-0000-4000-8000-000000000001",
    input: {name: "等待创建", parentId: null},
  })}>创建测试文件夹</button>;
}

function renderBar(
  includeCreator = false,
  loadedPatterns: PatternItem[] = items,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <QueryOwnerProvider ownerId={ownerId}>
          <Tooltip.Provider>
            {includeCreator && <CreateFolderButton />}
            <BulkActionBar
              activeQuery={query}
              loadedPatterns={loadedPatterns}
            />
          </Tooltip.Provider>
        </QueryOwnerProvider>
      </QueryClientProvider>,
    ),
  };
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

  it("excludes a pending create from move targets until its real folder ID is reconciled", async () => {
    const realId = "20000000-0000-4000-8000-000000000009";
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>(resolve => {finish = resolve;}))
      .mockResolvedValueOnce(Response.json({patterns: items.map(item => ({...item, folderId: realId, version: item.version + 1}))}));
    vi.stubGlobal("fetch", fetcher);
    const {client} = renderBar(true);
    act(() => client.setQueryData(queryKeys.folders(ownerId), []));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", {name: "创建测试文件夹"}));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", {name: "移动"}));
    expect(screen.getByRole("menuitem", {name: "未分类"})).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", {name: "等待创建"})).not.toBeInTheDocument();
    await act(async () => finish(Response.json({
      id: realId, ownerId, parentId: null, name: "等待创建", normalizedName: "等待创建",
      status: "active", version: 0, trashBatchId: null, trashedAt: null, deletedAt: null,
      changeSeq: "1", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
      directPatternCount: 0, recursivePatternCount: 0,
    }, {status: 201})));
    await user.click(await screen.findByRole("menuitem", {name: "等待创建"}));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({action: "move", folderId: realId});
    expect(client.getQueryData<Array<{id: string}>>(queryKeys.folders(ownerId))?.map(folder => folder.id)).toEqual([realId]);
  });

  it("loads authoritative deletion impact and cancels without trashing", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/patterns/deletion-impact") {
          return Response.json(deletionImpact);
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }),
    );
    renderBar(
      false,
      items.map((item, index) => ({
        ...item,
        commercialSummary: {
          state: "standard",
          activeCount: 1,
          revenueFen: index === 0 ? "60000" : "40000",
        },
      })),
    );

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    const dialog = screen.getByRole("dialog", { name: "移入回收站" });
    expect(dialog).toHaveTextContent("2 个图案");
    expect(await screen.findByText("有效授权 2 笔 · ¥1,000.00")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("共 3 条授权记录 · 4 个文件");
    expect(dialog).toHaveTextContent("预计永久删除：");
    expect(dialog).toHaveTextContent(
      "永久删除后，授权历史和过去看板收入也会删除。",
    );
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/patterns/deletion-impact",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ patternIds: items.map((item) => item.id) }),
      }),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/patterns/batch",
      expect.anything(),
    );
  });

  it("blocks confirmation until authoritative deletion impact loads", async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    renderBar();

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    expect(
      screen.getByRole("button", { name: "确认移入回收站" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在核对授权和文件");

    await act(async () => {
      finish(
        Response.json({
          activeAuthorizationCount: 0,
          activeRevenueFen: "0",
          totalAuthorizationCount: 0,
          assetCount: 2,
          purgeOn: "2026-11-13T00:00:00.000Z",
        }),
      );
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认移入回收站" }),
      ).toBeEnabled(),
    );
  });

  it("keeps confirmation blocked after an impact request fails and recovers on retry", async () => {
    const user = userEvent.setup();
    let impactRequestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) !== "/api/patterns/deletion-impact") {
          throw new Error(`Unexpected request: ${String(input)}`);
        }
        impactRequestCount += 1;
        if (impactRequestCount === 1) {
          return Response.json(
            { error: { code: "INTERNAL_ERROR" } },
            { status: 500 },
          );
        }
        return Response.json(deletionImpact);
      }),
    );
    renderBar();

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法核对删除影响，请重试。",
    );
    expect(
      screen.getByRole("button", { name: "确认移入回收站" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "重新核对" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认移入回收站" }),
      ).toBeEnabled(),
    );
    expect(impactRequestCount).toBe(2);
  });

  it("rejects a deletion impact whose active count exceeds its total", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) !== "/api/patterns/deletion-impact") {
          throw new Error(`Unexpected request: ${String(input)}`);
        }
        return Response.json({
          ...deletionImpact,
          activeAuthorizationCount: 4,
          totalAuthorizationCount: 3,
        });
      }),
    );
    renderBar();

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法核对删除影响，请重试。",
    );
    expect(
      screen.getByRole("button", { name: "确认移入回收站" }),
    ).toBeDisabled();
  });

  it("confirms trash and restores the exact server-confirmed patterns with a new operation ID", async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/folders") return Response.json([]);
      if (url === "/api/patterns/deletion-impact") {
        return Response.json(deletionImpact);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url === "/api/patterns/batch") {
        return Response.json({ patterns: items.map((item) => ({
          ...item,
          status: "trashed",
          trashBatchId: body.operationId,
          preTrashStatus: item.status,
          trashedAt: "2026-10-08T01:00:00.000Z",
          deletedAt: null,
          version: item.version + 1,
        })) });
      }
      if (url === "/api/trash/patterns/restore") {
        return Response.json({ state: "restored", patterns: items.map((item) => ({ id: item.id, status: "ready", folderId: null, version: item.version + 2, changeSeq: "2", updatedAt: item.updatedAt })) });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderBar();

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认移入回收站" }),
      ).toBeEnabled(),
    );
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

  it("keeps the undo notice when restore returns only part of the requested set", async () => {
    const user = userEvent.setup();
    const restoreCalls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/patterns/deletion-impact") {
        return Response.json(deletionImpact);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url === "/api/patterns/batch") {
        return Response.json({ patterns: items.map((item) => ({
          ...item,
          status: "trashed",
          trashBatchId: body.operationId,
          preTrashStatus: item.status,
          trashedAt: "2026-10-08T01:00:00.000Z",
          deletedAt: null,
          version: item.version + 1,
        })) });
      }
      if (url === "/api/trash/patterns/restore") {
        restoreCalls.push(body);
        return Response.json({
          state: "restored",
          patterns: [{
            id: items[0]!.id,
            status: "ready",
            folderId: null,
            version: items[0]!.version + 2,
            changeSeq: "2",
            updatedAt: items[0]!.updatedAt,
          }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { client } = renderBar();

    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认移入回收站" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已将 2 个图案移入回收站");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "撤销" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("撤销失败");
    expect(screen.getByRole("status")).toHaveTextContent("已将 2 个图案移入回收站");
    expect(restoreCalls).toHaveLength(2);
    expect(restoreCalls[0]!.operationId).toBe(restoreCalls[1]!.operationId);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["owner", ownerId, "patterns"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.folders(ownerId),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.trash(ownerId),
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: dashboardKeys.all(ownerId),
    });
    for (const item of items) {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.pattern(ownerId, item.id),
        exact: true,
      });
    }
  });

  it.each(["Escape", "outside click"])(
    "keeps the trash dialog open during a pending request after %s",
    async (dismissal) => {
      const user = userEvent.setup();
      let resolve!: (response: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === "/api/patterns/deletion-impact") {
            return Promise.resolve(Response.json(deletionImpact));
          }
          return new Promise<Response>((done) => {
            resolve = (response) => done(response);
            void init;
          });
        }),
      );
      renderBar();

      await user.click(screen.getByRole("button", { name: "移入回收站" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "确认移入回收站" }),
        ).toBeEnabled(),
      );
      await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("dialog", { name: "移入回收站" })).toBeVisible();

      if (dismissal === "Escape") {
        await user.keyboard("{Escape}");
      } else {
        const overlay = document.querySelector<HTMLElement>(".dialog-overlay");
        expect(overlay).not.toBeNull();
        fireEvent.pointerDown(overlay!);
        fireEvent.click(overlay!);
      }

      expect(screen.getByRole("dialog", { name: "移入回收站" })).toBeVisible();

      const batchCall = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => url === "/api/patterns/batch")!;
      const body = JSON.parse(String(batchCall[1]?.body)) as {
        operationId: string;
      };
      await act(async () => {
        resolve(Response.json({ patterns: items.map((item) => ({
          ...item,
          status: "trashed",
          trashBatchId: body.operationId,
          preTrashStatus: item.status,
          trashedAt: "2026-10-08T01:00:00.000Z",
          deletedAt: null,
          version: item.version + 1,
        })) }));
      });
      expect(await screen.findByRole("status")).toHaveTextContent(
        "已将 2 个图案移入回收站",
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("reuses cached active folders and moves the selected versions to the chosen folder", async () => {
    const user = userEvent.setup();
    const folderId = "20000000-0000-4000-8000-000000000000";
    const batchBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/patterns/batch") {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
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
      }),
    );
    const { client } = renderBar();
    act(() =>
      client.setQueryData(queryKeys.folders(ownerId), [
        { id: folderId, name: "家居", parentId: null, status: "active" },
      ]),
    );

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
