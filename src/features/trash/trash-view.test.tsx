import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryOwnerProvider } from "@/lib/query/provider";
import { queryKeys } from "@/lib/query/keys";
import { TrashView } from "./trash-view";
import {
  restorePatterns,
  purgePatterns,
  restoreFolderBatch,
  purgeFolderBatch,
  useTrashMutation,
} from "./trash-mutations";
import type { TrashList } from "./trash-types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(99),
  operationId = id(80);
const date = "2026-10-08T00:00:00.000Z";
const pattern = (n: number) => ({
  id: id(n),
  name: `图案${n}`,
  originalFilename: `${n}.png`,
  extension: "png",
  sizeBytes: "12",
  folderId: null,
  status: "trashed" as const,
  previewStatus: "ready" as const,
  previewAssetId: null,
  thumbnailAssetId: null,
  version: 1,
  lastErrorCode: null,
  trashedAt: date,
});
const data = (): TrashList => ({
  folderBatches: [
    {
      trashBatchId: id(10),
      rootFolderId: id(11),
      rootFolderName: "夏日果园",
      folderCount: 2,
      patternCount: 3,
      state: "trashed",
      lastErrorCode: null,
      purgeOperationId: null,
      trashedAt: date,
      expiresAt: "2026-11-07T00:00:00.000Z",
    },
  ],
  patternBatches: [
    {
      trashBatchId: id(20),
      state: "trashed",
      lastErrorCode: null,
      purgeOperationId: null,
      trashedAt: date,
      expiresAt: "2026-11-07T00:00:00.000Z",
      patterns: [pattern(1), pattern(2)],
    },
  ],
});
const restored = {
  state: "restored",
  patterns: [
    {
      id: id(1),
      status: "ready",
      folderId: null,
      version: 2,
      changeSeq: "3",
      updatedAt: date,
    },
  ],
};
function setup(initial?: TrashList) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  if (initial) client.setQueryData(queryKeys.trash(ownerId), initial);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>{children}</QueryOwnerProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}
const response = (value: unknown) => Promise.resolve(Response.json(value));
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => response(data())),
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders folder groups as one row and ordinary patterns as selectable rows", () => {
  const { wrapper } = setup(data());
  render(<TrashView />, { wrapper });
  const group = screen.getByRole("region", { name: "夏日果园" });
  expect(within(group).getByText("2 个文件夹 · 3 个图案")).toBeInTheDocument();
  expect(within(group).queryByRole("checkbox")).not.toBeInTheDocument();
  expect(within(group).getByText(/到期/)).toHaveTextContent("2026/11/7");
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
});
it("selects and focuses an ordinary pattern from a dashboard deep link", async () => {
  const { wrapper } = setup(data());
  render(
    <TrashView
      initialTarget={{ id: id(2), name: "图案2", trashBatchId: id(20) }}
    />,
    { wrapper },
  );

  const checkbox = await screen.findByRole("checkbox", {
    name: "选择图案2",
  });
  await waitFor(() => expect(checkbox).toBeChecked());
  expect(checkbox).toHaveFocus();
});
it("locates a deep-linked pattern inside its trashed folder batch", async () => {
  const { wrapper } = setup(data());
  render(
    <TrashView
      initialTarget={{
        id: id(30),
        name: "文件夹内图案",
        trashBatchId: id(10),
      }}
    />,
    { wrapper },
  );

  const group = await screen.findByRole("region", { name: "夏日果园" });
  expect(group).toHaveAttribute("data-targeted", "true");
  expect(within(group).getByRole("status")).toHaveTextContent(
    "包含目标图案：文件夹内图案",
  );
});
it("restores only checked ordinary patterns and invalidates owner caches after confirmation", async () => {
  const { client, wrapper } = setup(data());
  const invalidate = vi.spyOn(client, "invalidateQueries");
  vi.mocked(fetch).mockImplementation((url) =>
    response(url === "/api/trash" ? data() : restored),
  );
  render(<TrashView />, { wrapper });
  fireEvent.click(screen.getByRole("checkbox", { name: "选择图案1" }));
  fireEvent.click(screen.getByRole("button", { name: "恢复所选" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/trash/patterns/restore",
      expect.anything(),
    ),
  );
  const call = vi
    .mocked(fetch)
    .mock.calls.find(([url]) => url === "/api/trash/patterns/restore")!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({
    operationId: expect.any(String),
    patternIds: [id(1)],
  });
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.trash(ownerId),
    }),
  );
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: queryKeys.folders(ownerId),
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ["owner", ownerId, "patterns"],
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: queryKeys.pattern(ownerId, id(1)),
  });
});
it("requires a second confirmation with precise objects/counts, supports cancel, and keeps pending rows visible", async () => {
  const { wrapper } = setup(data());
  render(<TrashView />, { wrapper });
  fireEvent.click(screen.getByRole("checkbox", { name: "选择图案1" }));
  fireEvent.click(screen.getByRole("button", { name: "永久删除所选" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("1 个图案");
  expect(screen.getByRole("dialog")).toHaveTextContent("图案1");
  expect(screen.getByRole("dialog")).toHaveTextContent("不可恢复");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "永久删除所选" }));
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
  ).toEqual({ operationId: expect.any(String), patternIds: [id(1)] });
  expect(screen.getByLabelText("选择图案1")).toBeDisabled();
  expect(screen.getByText("正在永久删除...")).toBeInTheDocument();
});

it("keeps a 100-name permanent-delete confirmation in a bounded scroll region with its footer outside", () => {
  const initial = data();
  initial.folderBatches = [];
  initial.patternBatches[0]!.patterns = Array.from({ length: 100 }, (_, i) => ({
    ...pattern(i + 1),
    name: `${i + 1} ${"长名称".repeat(50)}`,
  }));
  const { wrapper } = setup(initial);
  render(<TrashView />, { wrapper });
  for (const checkbox of screen.getAllByRole("checkbox"))
    fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "永久删除所选" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveClass("trash-confirm-dialog");
  expect(dialog).toHaveAccessibleDescription(
    "100 个图案。永久删除后不可恢复。",
  );
  const names = within(dialog).getByRole("list", { name: "永久删除对象" });
  expect(names).toHaveClass("trash-confirm-targets");
  expect(within(names).getAllByRole("listitem")).toHaveLength(100);
  for (const pattern of initial.patternBatches[0]!.patterns)
    expect(within(names).getByText(pattern.name)).toBeInTheDocument();
  const footer = within(dialog).getByRole("contentinfo");
  expect(names).not.toContainElement(footer);
  expect(
    within(footer).getByRole("button", { name: "确认永久删除" }),
  ).toBeEnabled();
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  expect(css).toMatch(
    /\.trash-confirm-dialog\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto[^}]*max-height:\s*min\(640px,\s*calc\(100dvh - 32px\)\)/s,
  );
  expect(css).toMatch(
    /\.trash-confirm-targets\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*overflow-wrap:\s*anywhere/s,
  );
});
it("restores and confirms a folder batch without exposing its patterns", async () => {
  const { wrapper } = setup(data());
  render(<TrashView />, { wrapper });
  const group = within(screen.getByRole("region", { name: "夏日果园" }));
  fireEvent.click(group.getByRole("button", { name: "永久删除" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("夏日果园");
  expect(screen.getByRole("dialog")).toHaveTextContent("2 个文件夹 · 3 个图案");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  vi.mocked(fetch).mockImplementation((url) =>
    response(
      url === "/api/trash"
        ? data()
        : {
            state: "restored",
            trashBatchId: id(10),
            rootFolderId: id(11),
            folderCount: 2,
            patternCount: 3,
          },
    ),
  );
  fireEvent.click(group.getByRole("button", { name: "恢复" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      `/api/trash/folder-batches/${id(10)}/restore`,
      expect.anything(),
    ),
  );
});
it("blocks deleting rows and reuses server purgeOperationId for only the failed deleting subset", async () => {
  const initial = data();
  initial.folderBatches[0] = {
    ...initial.folderBatches[0]!,
    state: "deleting",
    purgeOperationId: id(81),
  };
  initial.patternBatches[0] = {
    ...initial.patternBatches[0]!,
    state: "deleting",
    purgeOperationId: operationId,
    lastErrorCode: "OSS_DELETE_FAILED",
    patterns: [
      { ...pattern(1), status: "deleting", lastErrorCode: "OSS_DELETE_FAILED" },
      pattern(2),
    ],
  };
  const { wrapper } = setup(initial);
  render(<TrashView />, { wrapper });
  const folder = within(screen.getByRole("region", { name: "夏日果园" }));
  expect(folder.getByRole("button", { name: "恢复" })).toBeDisabled();
  expect(folder.getByRole("button", { name: "永久删除" })).toBeDisabled();
  expect(screen.getByText("删除失败，可重试")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试删除" }));
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
  ).toEqual({ operationId, patternIds: [id(1)] });
});
it("shows loading, exact empty state and recoverable query errors", async () => {
  const first = setup();
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  const view = render(<TrashView />, { wrapper: first.wrapper });
  expect(screen.getByText("正在载入回收站...")).toBeInTheDocument();
  view.unmount();
  const empty = setup({ folderBatches: [], patternBatches: [] });
  const emptyView = render(<TrashView />, { wrapper: empty.wrapper });
  expect(screen.getByText("回收站是空的")).toBeInTheDocument();
  emptyView.unmount();
  const failing = setup();
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ folderBatches: "invalid" }),
  );
  render(<TrashView />, { wrapper: failing.wrapper });
  expect(await screen.findByRole("alert")).toHaveTextContent("回收站载入失败");
  expect(screen.getByRole("button", { name: "重新载入" })).toBeInTheDocument();
});
it.each([
  ["restorePatterns", () => restorePatterns(operationId, [id(1)]), {}],
  ["restore wrong IDs", () => restorePatterns(operationId, [id(2)]), restored],
  [
    "purgePatterns",
    () => purgePatterns(operationId, [id(1)]),
    { state: "complete", deletedPatternCount: 0, deletedFolderCount: 0 },
  ],
  [
    "restoreFolderBatch",
    () => restoreFolderBatch(operationId, id(10)),
    {
      state: "restored",
      trashBatchId: id(20),
      rootFolderId: id(11),
      folderCount: 2,
      patternCount: 3,
    },
  ],
  [
    "purgeFolderBatch",
    () => purgeFolderBatch(operationId, id(10)),
    { state: "complete", deletedPatternCount: 2, deletedFolderCount: 0 },
  ],
] as const)(
  "rejects malformed successful %s responses",
  async (_name, run, body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    await expect(run()).rejects.toThrow();
  },
);
it.each(["restore", "purge"] as const)(
  "invalidates owner caches and propagates %s failures after requests were sent",
  async (action) => {
    for (const failure of [
      "malformed",
      "mismatch",
      "network",
      "api",
    ] as const) {
      const { client, wrapper } = setup(data());
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const { result, unmount } = renderHook(() => useTrashMutation(), {
        wrapper,
      });
      vi.mocked(fetch).mockImplementation(() => {
        if (failure === "network")
          return Promise.reject(new TypeError("offline"));
        if (failure === "api")
          return Promise.resolve(
            Response.json(
              { error: { code: "INTERNAL_ERROR" } },
              { status: 500 },
            ),
          );
        if (failure === "mismatch")
          return response(
            action === "restore"
              ? {
                  ...restored,
                  patterns: [{ ...restored.patterns[0], id: id(9) }],
                }
              : {
                  state: "complete",
                  deletedPatternCount: 0,
                  deletedFolderCount: 0,
                },
          );
        return response({});
      });
      await act(async () => {
        await expect(
          result.current.mutateAsync({
            kind: "patterns",
            action,
            operationId,
            patternIds: [id(1)],
          }),
        ).rejects.toThrow();
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.trash(ownerId),
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.folders(ownerId),
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["owner", ownerId, "patterns"],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.pattern(ownerId, id(1)),
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.isSuccess).toBe(false);
      unmount();
      client.clear();
    }
  },
);

it.each(["restore", "purge"] as const)(
  "does not invalidate %s rejected before a request by local input validation",
  async (action) => {
    const { client, wrapper } = setup(data());
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useTrashMutation(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          kind: "patterns",
          action,
          operationId: "invalid",
          patternIds: [id(1)],
        }),
      ).rejects.toThrow();
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  },
);

it("retries a transport failure using the same operation and selection", async () => {
  const { wrapper } = setup();
  const { result } = renderHook(() => useTrashMutation(), { wrapper });
  vi.mocked(fetch)
    .mockRejectedValueOnce(new TypeError("network"))
    .mockResolvedValueOnce(
      Response.json({
        state: "complete",
        deletedPatternCount: 1,
        deletedFolderCount: 0,
      }),
    );
  await act(async () => {
    await result.current.mutateAsync({
      kind: "patterns",
      action: "purge",
      operationId,
      patternIds: [id(1)],
    });
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(fetch).mock.calls[0]![1]!.body).toEqual(
    vi.mocked(fetch).mock.calls[1]![1]!.body,
  );
});

it("reuses a failed folder purge identity and confirms its exact scope", async () => {
  const initial = data();
  initial.folderBatches[0] = {
    ...initial.folderBatches[0]!,
    state: "deleting",
    lastErrorCode: "OSS_DELETE_FAILED",
    purgeOperationId: operationId,
  };
  const { wrapper } = setup(initial);
  render(<TrashView />, { wrapper });
  fireEvent.click(
    within(screen.getByRole("region", { name: "夏日果园" })).getByRole(
      "button",
      { name: "重试删除" },
    ),
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("2 个文件夹 · 3 个图案");
  vi.mocked(fetch).mockImplementation((url) =>
    response(
      url === "/api/trash"
        ? { folderBatches: [], patternBatches: [] }
        : { state: "complete", deletedPatternCount: 3, deletedFolderCount: 2 },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      `/api/trash/folder-batches/${id(10)}/purge`,
      expect.objectContaining({ body: JSON.stringify({ operationId }) }),
    ),
  );
  expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
});

it("blocks a stale confirmation when the batch starts deleting under another operation", async () => {
  const { client, wrapper } = setup(data());
  render(<TrashView />, { wrapper });
  fireEvent.click(screen.getByRole("checkbox", { name: "选择图案1" }));
  fireEvent.click(screen.getByRole("button", { name: "永久删除所选" }));
  const changed = data();
  changed.patternBatches[0] = {
    ...changed.patternBatches[0]!,
    state: "deleting",
    purgeOperationId: id(88),
    patterns: [{ ...pattern(1), status: "deleting" }, pattern(2)],
  };
  await act(async () => {
    client.setQueryData(queryKeys.trash(ownerId), changed);
  });
  fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
  expect(fetch).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("dialog")).toHaveTextContent("状态已变化"),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves cached deleting rows when a background refresh fails", async () => {
  const initial = data();
  initial.folderBatches[0] = {
    ...initial.folderBatches[0]!,
    state: "deleting",
    purgeOperationId: operationId,
  };
  const { client, wrapper } = setup(initial);
  render(<TrashView />, { wrapper });
  vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.trash(ownerId) });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("刷新失败");
  expect(screen.getByRole("region", { name: "夏日果园" })).toBeInTheDocument();
  expect(screen.getByText("正在永久删除...")).toBeInTheDocument();
});

it("reconstructs all deleting targets when one failed purge spans ordinary batches", async () => {
  const initial = data();
  initial.patternBatches = [1, 2].map((n) => ({
    ...initial.patternBatches[0]!,
    trashBatchId: id(20 + n),
    state: "deleting",
    lastErrorCode: "OSS_DELETE_FAILED",
    purgeOperationId: operationId,
    patterns: [
      { ...pattern(n), status: "deleting", lastErrorCode: "OSS_DELETE_FAILED" },
    ],
  }));
  const { wrapper } = setup(initial);
  render(<TrashView />, { wrapper });
  fireEvent.click(screen.getAllByRole("button", { name: "重试删除" })[0]!);
  expect(screen.getByRole("dialog")).toHaveTextContent("2 个图案");
  vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
  ).toEqual({ operationId, patternIds: [id(1), id(2)] });
});

it.each(["folder", "patterns"] as const)(
  "continues a deferred %s purge after reload with the exact original operation and targets",
  async (kind) => {
    const deferred = data();
    if (kind === "folder") {
      deferred.folderBatches[0] = {
        ...deferred.folderBatches[0]!,
        state: "deleting",
        purgeOperationId: operationId,
      };
      deferred.patternBatches = [];
    } else {
      deferred.folderBatches = [];
      deferred.patternBatches = [1, 2].map((n) => ({
        ...data().patternBatches[0]!,
        trashBatchId: id(20 + n),
        state: "deleting",
        purgeOperationId: operationId,
        patterns: [{ ...pattern(n), status: "deleting" }, pattern(n + 10)],
      }));
    }
    const path =
      kind === "folder"
        ? `/api/trash/folder-batches/${id(10)}/purge`
        : "/api/trash/patterns/purge";
    const expectedBody =
      kind === "folder"
        ? { operationId }
        : { operationId, patternIds: [id(1), id(2)] };
    vi.mocked(fetch).mockImplementation((url) =>
      url === "/api/trash"
        ? response(deferred)
        : Promise.resolve(
            Response.json(
              { error: { code: "TRASH_PURGE_DEFERRED" } },
              { status: 409 },
            ),
          ),
    );
    const first = setup();
    const view = render(<TrashView />, { wrapper: first.wrapper });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "继续删除" }))[0]!,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      kind === "folder" ? "2 个文件夹 · 3 个图案" : "2 个图案",
    );
    fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("alert"),
      ).toHaveTextContent("稍后"),
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === path),
    ).toHaveLength(1);
    view.unmount();
    first.client.clear();
    const second = setup();
    const reloaded = render(<TrashView />, { wrapper: second.wrapper });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "继续删除" }))[0]!,
    );
    vi.mocked(fetch).mockImplementation((url) =>
      response(
        url === "/api/trash"
          ? { folderBatches: [], patternBatches: [] }
          : {
              state: "complete",
              deletedPatternCount: kind === "folder" ? 3 : 2,
              deletedFolderCount: kind === "folder" ? 2 : 0,
            },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url === path);
    expect(calls).toHaveLength(2);
    for (const call of calls)
      expect(JSON.parse(call[1]!.body as string)).toEqual(expectedBody);
    reloaded.unmount();
  },
);

it.each([
  "folder-operation",
  "folder-scope",
  "patterns-operation",
  "patterns-scope",
])("rejects changed deferred confirmation %s", async (change) => {
  const initial = data();
  initial.folderBatches[0] = {
    ...initial.folderBatches[0]!,
    state: "deleting",
    purgeOperationId: operationId,
  };
  initial.patternBatches[0] = {
    ...initial.patternBatches[0]!,
    state: "deleting",
    purgeOperationId: id(81),
    patterns: [{ ...pattern(1), status: "deleting" }, pattern(2)],
  };
  const { client, wrapper } = setup(initial);
  render(<TrashView />, { wrapper });
  const region = change.startsWith("folder")
    ? screen.getByRole("region", { name: "夏日果园" })
    : screen.getByRole("region", { name: "已删除图案批次" });
  fireEvent.click(within(region).getByRole("button", { name: "继续删除" }));
  const changed = structuredClone(initial);
  if (change === "folder-operation")
    changed.folderBatches[0]!.purgeOperationId = id(88);
  if (change === "folder-scope") changed.folderBatches[0]!.patternCount = 4;
  if (change === "patterns-operation")
    changed.patternBatches[0]!.purgeOperationId = id(88);
  if (change === "patterns-scope")
    changed.patternBatches[0]!.patterns[1]!.status = "deleting";
  await act(async () => {
    client.setQueryData(queryKeys.trash(ownerId), changed);
  });
  fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
  expect(
    await within(screen.getByRole("dialog")).findByRole("alert"),
  ).toHaveTextContent("状态已变化");
  expect(fetch).not.toHaveBeenCalled();
});
