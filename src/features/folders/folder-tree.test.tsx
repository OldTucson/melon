import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryOwnerProvider } from "@/lib/query/provider";
import { queryKeys } from "@/lib/query/keys";
import { useSelectionStore } from "@/features/library/selection-store";
import type { FolderDto } from "./folder-client";
import { FolderTree } from "./folder-tree";

const navigation = vi.hoisted(() => ({
  search: new URLSearchParams(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.search,
  usePathname: () => "/library",
  useRouter: () => ({ replace: navigation.replace }),
}));
const owner = "10000000-0000-4000-8000-000000000001";
const id = "20000000-0000-4000-8000-000000000001",
  childId = "20000000-0000-4000-8000-000000000002",
  grandId = "20000000-0000-4000-8000-000000000003";
const root: FolderDto = {
  id,
  ownerId: owner,
  parentId: null,
  name: "花卉",
  normalizedName: "花卉",
  status: "active",
  version: 0,
  trashBatchId: null,
  trashedAt: null,
  deletedAt: null,
  changeSeq: "1",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  directPatternCount: 1,
  recursivePatternCount: 7,
};
const child = {
  ...root,
  id: childId,
  parentId: id,
  name: "长名称子文件夹",
  normalizedName: "长名称子文件夹",
};
const grand = {
  ...root,
  id: grandId,
  parentId: childId,
  name: "孙文件夹",
  normalizedName: "孙文件夹",
};
const impact = {
  folderCount: 2,
  patternCount: 7,
  alreadyTrashedFolderCount: 1,
  alreadyTrashedPatternCount: 3,
  hasDeletingEntities: true,
  scopeFingerprint: "a".repeat(64),
  activeAuthorizationCount: 2,
  activeRevenueFen: "100000",
  totalAuthorizationCount: 3,
  assetCount: 4,
  purgeOn: "2026-11-07T00:00:00.000Z",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function setup(search = "") {
  navigation.search = new URLSearchParams(search);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retryDelay: 0 },
    },
  });
  client.setQueryData(queryKeys.folders(owner), [grand, child, root]);
  render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={owner}>
        <FolderTree />
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
  return { client, user: userEvent.setup() };
}
async function menu(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  command: string,
) {
  const trigger = screen.getByRole("button", { name: `${name}的操作` });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: command }));
}
beforeEach(() => {
  navigation.replace.mockReset();
  useSelectionStore.getState().clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("folder tree interactions", () => {
  it("shows pending creation without a link or row actions, then enables the authoritative ID", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "新建文件夹" }));
    await user.type(screen.getByRole("textbox"), "等待创建{Enter}");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(screen.getByText("等待创建")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "等待创建" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "正在创建等待创建" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "等待创建的操作" }),
    ).toBeDisabled();
    const realId = "20000000-0000-4000-8000-000000000009";
    await act(async () =>
      finish(
        response(
          { ...root, id: realId, name: "等待创建", normalizedName: "等待创建" },
          201,
        ),
      ),
    );
    expect(
      await screen.findByRole("link", { name: "等待创建" }),
    ).toHaveAttribute("href", `/library?folderId=${realId}`);
    expect(
      screen.getByRole("button", { name: "等待创建的操作" }),
    ).not.toBeDisabled();
  });
  it("provides an accessible rail toggle that closes with Escape", async () => {
    const { user } = setup();
    const toggle = screen.getByRole("button", { name: "浏览文件夹" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });
  it("cancels an untouched create draft without sending a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: "新建文件夹" }));
    expect(
      screen.getByRole("textbox", { name: "文件夹名称" }),
    ).toHaveFocus();

    await user.click(
      screen.getByRole("button", { name: "取消新建文件夹" }),
    );

    expect(
      screen.queryByRole("textbox", { name: "文件夹名称" }),
    ).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("expands with keyboard, exposes current link/title/count and preserves navigation filters", async () => {
    const { user } = setup(
      `folderId=${id}&includeDescendants=false&q=花&cursor=old&favorite=true`,
    );
    const rootLink = screen.getByRole("link", { name: "花卉" });
    expect(rootLink).toHaveAttribute("aria-current", "page");
    const expand = screen.getByRole("button", { name: "展开花卉" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expand.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "收起花卉" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const link = screen.getByRole("link", { name: child.name });
    expect(link).toHaveAttribute("title", child.name);
    const params = new URL(link.getAttribute("href")!, "https://test")
      .searchParams;
    expect(params.get("includeDescendants")).toBe("false");
    expect(params.get("favorite")).toBe("true");
    expect(params.has("cursor")).toBe(false);
    useSelectionStore.setState({ selectedIds: ["p"], previewId: "p" });
    fireEvent.click(link);
    expect(useSelectionStore.getState()).toMatchObject({
      selectedIds: [],
      previewId: null,
    });
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);
  });
  it("marks unfiled current and clears folder/descendant/paging params", () => {
    setup(
      `unfiled=true&folderId=${id}&includeDescendants=false&cursor=old&q=x`,
    );
    const link = screen.getByRole("link", { name: "未分类" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveAttribute("href", "/library?q=x&unfiled=true");
  });
  it("auto-expands ancestors of a nested URL selection", () => {
    setup(`folderId=${grandId}`);
    expect(screen.getByRole("link", { name: grand.name })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "收起花卉" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
  it("creates root and child via inline keyboard form; conflict preserves the exact draft", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ error: { code: "FOLDER_NAME_CONFLICT" } }, 409),
      )
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(init.body);
        return response(
          {
            ...root,
            id: "20000000-0000-4000-8000-000000000009",
            parentId: body.input.parentId,
            name: body.input.name.trim(),
            normalizedName: body.input.name.trim(),
          },
          201,
        );
      });
    vi.stubGlobal("fetch", fetcher);
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "新建文件夹" }));
    const input = screen.getByRole("textbox", { name: "文件夹名称" });
    await user.type(input, " 重复 ");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("同名文件夹");
    expect(input).toHaveValue(" 重复 ");
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).input.parentId).toBe(
      null,
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await menu(user, "花卉", "新建子文件夹");
    expect(screen.getByRole("textbox")).toHaveFocus();
    await user.type(screen.getByRole("textbox"), "新子文件夹{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).input.parentId).toBe(id);
  });
  it("renames with exact body and closes only after a valid response", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({
        ...root,
        name: "新名字",
        normalizedName: "新名字",
        version: 1,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { user } = setup();
    await menu(user, "花卉", "重命名");
    const input = screen.getByRole("textbox");
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "新名字{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      operationId: expect.any(String),
      patch: { name: "新名字", version: 0 },
    });
    expect(screen.getByRole("link", { name: "新名字" })).toBeInTheDocument();
  });
  it.each([409, 200])(
    "retains exact rename draft for conflict or malformed success (%s)",
    async (status) => {
      const fetcher = vi.fn(async () =>
        response(
          status === 409 ? { error: { code: "FOLDER_NAME_CONFLICT" } } : {},
          status,
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      const { user } = setup();
      await menu(user, "花卉", "重命名");
      const input = screen.getByRole("textbox");
      await user.clear(input);
      await user.type(input, " 保留空格 {Enter}");
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(input).toHaveValue(" 保留空格 ");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps a failed rename draft visible when a concurrent refresh removes its folder", async () => {
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
    const { user, client } = setup();
    await menu(user, "花卉", "重命名");
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "保留草稿{Enter}");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => client.setQueryData(queryKeys.folders(owner), []));
    await act(async () =>
      finish(response({ error: { code: "FOLDER_NOT_ACTIVE" } }, 409)),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("保留草稿");
  });
  it("fetches exact impact before opening confirmation, cancellation never deletes", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { user } = setup();
    await menu(user, "花卉", "移入回收站");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(`/api/folders/${id}/delete-impact`);
    await act(async () => finish(response(impact)));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "2 个文件夹和 7 个图案",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "1 个文件夹、3 个图案已在回收站",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("正在永久删除");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "有效授权 2 笔 · ¥1,000.00",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "共 3 条授权记录 · 4 个文件",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "永久删除后，授权历史和过去看板收入也会删除。",
    );
    expect(
      screen.getByRole("button", { name: "确认移入回收站" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rechecks impact and requires confirmation again when the delete scope changes", async () => {
    const initialImpact = {
      ...impact,
      folderCount: 1,
      patternCount: 0,
      alreadyTrashedFolderCount: 0,
      alreadyTrashedPatternCount: 0,
      hasDeletingEntities: false,
    };
    const changedImpact = {
      ...initialImpact,
      folderCount: 2,
      patternCount: 1,
      scopeFingerprint: "b".repeat(64),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(initialImpact))
      .mockResolvedValueOnce(response(changedImpact))
      .mockResolvedValueOnce(response(changedImpact))
      .mockImplementationOnce(async (_url, init) => {
        const operationId = JSON.parse(String(init?.body)).operationId;
        return response({
          state: "trashed",
          rootFolderId: id,
          trashBatchId: operationId,
          folderCount: 2,
          patternCount: 1,
        });
      });
    vi.stubGlobal("fetch", fetcher);
    const { user } = setup();

    await menu(user, "花卉", "移入回收站");
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "1 个文件夹和 0 个图案",
    );
    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "删除范围已变化，请核对后再次确认",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "2 个文件夹和 1 个图案",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(fetcher.mock.calls[3]![1]?.method).toBe("DELETE");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("keeps the dialog and uses the locked server impact after an atomic scope conflict", async () => {
    const initialImpact = {
      ...impact,
      folderCount: 1,
      patternCount: 0,
      alreadyTrashedFolderCount: 0,
      alreadyTrashedPatternCount: 0,
      hasDeletingEntities: false,
    };
    const latestImpact = {
      ...initialImpact,
      folderCount: 2,
      patternCount: 1,
      scopeFingerprint: "c".repeat(64),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(initialImpact))
      .mockResolvedValueOnce(response(initialImpact))
      .mockResolvedValueOnce(
        response(
          {
            error: {
              code: "FOLDER_DELETE_SCOPE_CHANGED",
              message: "Folder delete scope changed",
              details: latestImpact,
            },
          },
          409,
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const { user, client } = setup();

    await menu(user, "花卉", "移入回收站");
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "删除范围已变化，请核对后再次确认",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "2 个文件夹和 1 个图案",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      client.getQueryData<FolderDto[]>(queryKeys.folders(owner)),
    ).toHaveLength(3);
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toMatchObject({
      expectedImpact: initialImpact,
    });
  });
  it("guards pending dialog and removes subtree/navigates to active ancestor only after success", async () => {
    let finishImpact!: (response: Response) => void;
    let finishDelete!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...impact, hasDeletingEntities: false }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishImpact = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishDelete = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetcher);
    const { user, client } = setup(
      `folderId=${grandId}&includeDescendants=false&q=保留&cursor=old`,
    );
    await menu(user, child.name, "移入回收站");
    await screen.findByRole("dialog");
    useSelectionStore.setState({ selectedIds: ["p"], previewId: "p" });
    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await user.keyboard("{Escape}");
    const overlay = document.querySelector<HTMLElement>(".dialog-overlay")!;
    fireEvent.pointerDown(overlay);
    fireEvent.click(overlay);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(
      client.getQueryData<FolderDto[]>(queryKeys.folders(owner)),
    ).toHaveLength(3);
    await act(async () =>
      finishImpact(response({ ...impact, hasDeletingEntities: false })),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    const operationId = JSON.parse(fetcher.mock.calls[2]![1].body).operationId;
    await act(async () =>
      finishDelete(
        response({
          state: "trashed",
          rootFolderId: childId,
          trashBatchId: operationId,
          folderCount: 2,
          patternCount: 7,
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(client.getQueryData<FolderDto[]>(queryKeys.folders(owner))).toEqual([
      root,
    ]);
    expect(navigation.replace).toHaveBeenCalledWith(
      `/library?q=%E4%BF%9D%E7%95%99&folderId=${id}&includeDescendants=false`,
    );
    expect(useSelectionStore.getState()).toMatchObject({
      selectedIds: [],
      previewId: null,
    });
  });
  it("keeps failed deletion dialog and tree", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ ...impact, hasDeletingEntities: false }),
        )
        .mockResolvedValueOnce(
          response({ ...impact, hasDeletingEntities: false }),
        )
        .mockResolvedValueOnce(
          response({ error: { code: "FOLDER_STATE_CHANGED" } }, 409),
        ),
    );
    const { user, client } = setup();
    await menu(user, "花卉", "移入回收站");
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "文件夹状态已变化",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      client.getQueryData<FolderDto[]>(queryKeys.folders(owner)),
    ).toHaveLength(3);
  });
  it("keeps the dialog and tree when the impact recheck fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ ...impact, hasDeletingEntities: false }),
      )
      .mockResolvedValueOnce(response({ error: { code: "UNAVAILABLE" } }, 503));
    vi.stubGlobal("fetch", fetcher);
    const { user, client } = setup();
    await menu(user, "花卉", "移入回收站");
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "文件夹操作未完成",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    expect(
      client.getQueryData<FolderDto[]>(queryKeys.folders(owner)),
    ).toHaveLength(3);
  });
  it("returns to filtered library when deleting the current root", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "DELETE"
          ? response({
              state: "trashed",
              rootFolderId: id,
              trashBatchId: JSON.parse(String(init.body)).operationId,
              folderCount: 3,
              patternCount: 7,
            })
          : response({ ...impact, hasDeletingEntities: false }),
      ),
    );
    const { user } = setup(
      `folderId=${id}&includeDescendants=false&cursor=old&favorite=true&scope=trash`,
    );
    await menu(user, "花卉", "移入回收站");
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "确认移入回收站" }));
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/library?favorite=true"),
    );
  });
});
