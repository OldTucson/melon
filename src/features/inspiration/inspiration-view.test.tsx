import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  inspirationVisualBoardDtoSchema,
  type InspirationVisualBoardDto,
} from "@/features/inspiration-visuals/contracts";
import { visualBoardFixture } from "@/features/inspiration-visuals/test-fixtures";
import { ApiResponseError, createQueryClient } from "@/lib/query/client";
import { QueryOwnerProvider } from "@/lib/query/provider";
import {
  inspirationCreateMutationSchema,
  inspirationDetailDtoSchema,
  inspirationListDtoSchema,
  inspirationPatchMutationSchema,
  inspirationSummaryDtoSchema,
  type InspirationDetailDto,
  type InspirationListDto,
} from "./contracts";
import { InspirationView } from "./inspiration-view";
import {
  inspirationDetailFixture as completed,
  inspirationSummaryFixture as summary,
} from "./test-fixtures";
import { inspirationKeys } from "./query-keys";
import { inspirationApi } from "./inspiration-api";

const pageMocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listInspirationAnalyses: vi.fn(),
}));
const visualMocks = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/features/auth/session", () => ({
  requireUser: pageMocks.requireUser,
}));
vi.mock("@/features/inspiration/analysis-service", () => ({
  listInspirationAnalyses: pageMocks.listInspirationAnalyses,
}));
vi.mock("@/features/inspiration-visuals/inspiration-visual-api", () => ({
  inspirationVisualApi: visualMocks,
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const root = "/api/inspiration-analyses";
const endpoint = `${root}/${completed.id}`;
const failed: InspirationDetailDto = {
  ...completed,
  status: "failed",
  result: null,
  sources: null,
  errorCode: "INSPIRATION_SEARCH_TIMEOUT",
  completedAt: null,
};
const emptyVisualBoard: InspirationVisualBoardDto =
  inspirationVisualBoardDtoSchema.parse({
    refreshAvailable: true,
    activeJob: null,
    refreshJob: null,
    webEvidence: [],
    libraryMatches: [],
    conceptJobs: [],
    concepts: [],
  });
let record: InspirationDetailDto | null;
let listOverride: unknown;
let createResponse: () => Promise<Response>;
let patchResponse: () => Promise<Response>;
let requests: string[];
let clients: ReturnType<typeof createQueryClient>[];
let consoleError: MockInstance<typeof console.error>;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const detailResponse = () => json(inspirationDetailDtoSchema.parse(record));
function errorResponse(
  details: unknown,
  code = "INSPIRATION_SEARCH_TIMEOUT",
  status = 504,
) {
  return json(
    { error: { code, message: "PRIVATE upstream payload", details } },
    status,
  );
}
function renderWorkspace(
  ui = <InspirationView />,
  initialHistory?: InfiniteData<InspirationListDto, string | undefined>,
) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  clients.push(client);
  client.setQueryData(["owner", ownerId, "folders"], ["unrelated"]);
  if (initialHistory)
    client.setQueryData(inspirationKeys.list(ownerId), initialHistory);
  const rendered = render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Tooltip.Provider>{ui}</Tooltip.Provider>
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
  return { client, ...rendered };
}
async function submit(user: ReturnType<typeof userEvent.setup>) {
  if (record && !screen.queryByRole("dialog", { name: "新建灵感调研" })) {
    await screen.findByRole("heading", { name: record.title });
    await user.click(screen.getByRole("button", { name: "新建调研" }));
  } else if (!screen.queryByRole("textbox", { name: "研究需求" })) {
    await user.click(screen.getByRole("button", { name: "新建调研" }));
  }
  await user.type(
    screen.getByRole("textbox", { name: "研究需求" }),
    "分析近 30 天都市轻通勤女装",
  );
  await user.click(screen.getByRole("button", { name: "开始分析" }));
}
async function openRecord(user: ReturnType<typeof userEvent.setup>) {
  await selectHistoryRecord(user, /都市轻通勤女装研究/);
  await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
}
async function showHistory(user: ReturnType<typeof userEvent.setup>) {
  const current = screen.queryByRole("dialog", { name: "研究历史" });
  if (current) return current;
  await user.click(screen.getByRole("button", { name: "历史" }));
  return screen.findByRole("dialog", { name: "研究历史" });
}
async function historyRecord(
  user: ReturnType<typeof userEvent.setup>,
  name: string | RegExp,
) {
  return within(await showHistory(user)).findByRole("button", { name });
}
async function selectHistoryRecord(
  user: ReturnType<typeof userEvent.setup>,
  name: string | RegExp,
) {
  await user.click(await historyRecord(user, name));
}

beforeEach(() => {
  record = null;
  listOverride = undefined;
  requests = [];
  clients = [];
  consoleError = vi.spyOn(console, "error");
  visualMocks.get.mockReset().mockResolvedValue(emptyVisualBoard);
  visualMocks.create.mockReset().mockResolvedValue(visualBoardFixture);
  // jsdom omits the layout observer used by Radix when focus opens a tooltip.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  createResponse = async () => {
    record = completed;
    return detailResponse();
  };
  patchResponse = async () => detailResponse();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      const body: unknown =
        init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (url === `${root}?limit=20` && method === "GET") {
        expect(body).toBeUndefined();
        const data = listOverride ?? {
          items: record
            ? [inspirationSummaryDtoSchema.strip().parse(record)]
            : [],
          nextCursor: null,
        };
        if (listOverride === undefined) inspirationListDtoSchema.parse(data);
        return json(data);
      }
      if (url === `${root}?limit=20&cursor=b3BhcXVl` && method === "GET") {
        expect(body).toBeUndefined();
        return json(
          inspirationListDtoSchema.parse({
            items: [
              {
                ...summary,
                id: "00000000-0000-4000-8000-000000000002",
                title: "夏日材质研究",
              },
            ],
            nextCursor: null,
          }),
        );
      }
      if (url === root && method === "POST") {
        const mutation = inspirationCreateMutationSchema.parse(body);
        expect(mutation.prompt).toBe("分析近 30 天都市轻通勤女装");
        expect(init?.headers).toMatchObject({
          "Content-Type": "application/json",
        });
        return createResponse();
      }
      if (url === endpoint && method === "GET") {
        expect(body).toBeUndefined();
        return detailResponse();
      }
      if (url === endpoint && method === "PATCH") {
        expect(inspirationPatchMutationSchema.parse(body)).toEqual({
          title: "新版研究",
          version: 1,
        });
        return patchResponse();
      }
      if (url === endpoint && method === "DELETE") {
        expect(body).toBeUndefined();
        record = null;
        return json({ id: completed.id, deleted: true });
      }
      if (url === `${endpoint}/retry` && method === "POST") {
        expect(body).toBeUndefined();
        record = completed;
        return detailResponse();
      }
      if (url === `${endpoint}/share` && ["POST", "DELETE"].includes(method)) {
        expect(body).toBeUndefined();
        record = {
          ...completed,
          shareUrl:
            method === "POST"
              ? "https://app.example.test/share/inspiration/00000000-0000-4000-8000-000000000099"
              : null,
          version: method === "POST" ? 2 : 3,
        };
        return detailResponse();
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  expect(
    consoleError.mock.calls.filter((call) => String(call[0]).includes("act(")),
  ).toEqual([]);
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

describe("inspiration workspace", () => {
  it("labels the inspiration workspace as the page main content", () => {
    renderWorkspace();

    expect(
      screen.getByRole("main", { name: "灵感调研" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "灵感调研" }),
    ).toBeInTheDocument();
  });

  it("moves history into a named dialog and restores the trigger after Escape", async () => {
    const user = userEvent.setup();
    record = completed;
    renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    const trigger = screen.getByRole("button", { name: "历史" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "研究历史" });
    expect(
      within(dialog).getByRole("button", { name: /都市轻通勤女装研究/ }),
    ).toBeVisible();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("hides the permanent form for a report and restores the new-research trigger", async () => {
    const user = userEvent.setup();
    record = completed;
    renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    expect(
      screen.queryByRole("textbox", { name: "研究需求" }),
    ).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "新建调研" });

    await user.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "新建灵感调研" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "研究需求" })).toHaveFocus();
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "新建灵感调研" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not auto-backfill history, but auto-starts visuals for a newly completed analysis", async () => {
    const user = userEvent.setup();
    record = completed;
    renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    await waitFor(() =>
      expect(visualMocks.get).toHaveBeenCalledExactlyOnceWith(
        completed.id,
        expect.any(AbortSignal),
      ),
    );
    expect(visualMocks.create).not.toHaveBeenCalled();

    cleanup();
    for (const client of clients) client.clear();
    clients = [];
    record = null;
    renderWorkspace();
    await screen.findByText("暂无研究记录");
    await submit(user);

    await waitFor(() => expect(visualMocks.create).toHaveBeenCalledTimes(1));
    expect(visualMocks.create).toHaveBeenCalledWith(completed.id, {
      operationId: expect.stringMatching(/^[\da-f-]{36}$/),
    });
  });

  it("creates one stable visual operation per manual click and a new one on retry", async () => {
    const user = userEvent.setup();
    record = completed;
    visualMocks.create.mockResolvedValue(emptyVisualBoard);
    renderWorkspace();
    const refresh = await screen.findByRole("button", {
      name: "补充视觉素材",
    });

    await user.click(refresh);
    await waitFor(() => expect(visualMocks.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toBeEnabled());
    await user.click(refresh);
    await waitFor(() => expect(visualMocks.create).toHaveBeenCalledTimes(2));

    const firstOperation = visualMocks.create.mock.calls[0]![1].operationId;
    const secondOperation = visualMocks.create.mock.calls[1]![1].operationId;
    expect(firstOperation).toMatch(/^[\da-f-]{36}$/);
    expect(secondOperation).toMatch(/^[\da-f-]{36}$/);
    expect(secondOperation).not.toBe(firstOperation);
  });

  it("hides visual refresh when the server reports that it is unavailable", async () => {
    record = completed;
    visualMocks.get.mockResolvedValue({
      ...emptyVisualBoard,
      refreshAvailable: false,
    });
    renderWorkspace();

    expect(
      await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /视觉素材/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建调研" }),
    ).toBeEnabled();
  });

  it("keeps the active library mosaic while a visual refresh is pending", async () => {
    record = completed;
    visualMocks.get.mockResolvedValue({
      ...visualBoardFixture,
      refreshJob: {
        ...visualBoardFixture.activeJob,
        id: "00000000-0000-4000-8000-000000000199",
        status: "pending",
        completedAt: null,
      },
    });
    renderWorkspace();

    expect(
      await screen.findByRole("img", { name: "绿色植物图案" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("正在补充视觉素材");
    expect(screen.getByRole("link", { name: /雨后花园/ })).toHaveAttribute(
      "href",
      visualBoardFixture.libraryMatches[0]!.libraryHref,
    );
  });

  it("keeps the full text report visible when visual loading fails", async () => {
    record = completed;
    visualMocks.get.mockRejectedValue(
      new ApiResponseError(503, "INSPIRATION_VISUALS_UNAVAILABLE"),
    );
    renderWorkspace();

    expect(
      await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "市场信号" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "视觉素材加载失败",
    );
  });

  it("shows empty history with a native labelled textarea and validates before submission", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    expect(await screen.findByText("暂无研究记录")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "研究需求" }).tagName).toBe(
      "TEXTAREA",
    );
    await user.type(screen.getByLabelText("研究需求"), "短");
    expect(screen.getByRole("button", { name: "开始分析" })).toBeDisabled();
    expect(requests).toEqual([`GET ${root}?limit=20`]);
  });
  it("creates, automatically saves and selects the result without invalidating other features", async () => {
    const user = userEvent.setup();
    const { client } = renderWorkspace();
    await screen.findByText("暂无研究记录");
    await submit(user);
    expect(
      await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).toBeVisible();
    expect(await screen.findByText("已自动保存")).toBeVisible();
    expect(
      await historyRecord(user, /都市轻通勤女装研究/),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      client.getQueryState(["owner", ownerId, "folders"])?.isInvalidated,
    ).toBe(false);
    expect(
      client.getQueryData(inspirationKeys.detail(ownerId, completed.id)),
    ).toEqual(completed);
  });
  it("keeps history usable and prevents duplicate submissions while analysis is pending", async () => {
    const user = userEvent.setup();
    record = completed;
    let resolve!: (response: Response) => void;
    createResponse = () =>
      new Promise((done) => {
        resolve = done;
      });
    renderWorkspace();
    await submit(user);
    expect(screen.getByRole("button", { name: "新建调研" })).toBeDisabled();
    await openRecord(user);
    await act(async () => resolve(json(completed)));
    expect(await screen.findByText("已自动保存")).toBeVisible();
  });
  it("selects the safely identified saved failure and retries without rendering arbitrary error details", async () => {
    const user = userEvent.setup();
    createResponse = async () => {
      record = failed;
      return errorResponse({
        analysisId: completed.id,
        secret: "DO NOT SHOW DETAILS",
      });
    };
    renderWorkspace();
    await submit(user);
    await user.click(await screen.findByRole("button", { name: "重试分析" }));
    expect(
      await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).toBeVisible();
    expect(requests).toContain(`GET ${endpoint}`);
    expect(requests).toContain(`POST ${endpoint}/retry`);
    expect(
      screen.queryByText(/DO NOT SHOW DETAILS|PRIVATE upstream/),
    ).not.toBeInTheDocument();
  });
  it.each(["../../secret", 12, null])(
    "ignores unsafe failure analysisId %j and keeps provider internals private",
    async (analysisId) => {
      const user = userEvent.setup();
      createResponse = async () =>
        errorResponse({ analysisId, secret: "DO NOT SHOW DETAILS" });
      renderWorkspace();
      await submit(user);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "分析暂时失败，请稍后重试",
      );
      expect(
        screen.queryByText(/DO NOT SHOW DETAILS|PRIVATE upstream/),
      ).not.toBeInTheDocument();
      expect(
        requests.filter((request) => request.startsWith(`GET ${root}/`)),
      ).toEqual([]);
    },
  );
  it("refreshes a conflicted rename and keeps the saved title", async () => {
    const user = userEvent.setup();
    record = completed;
    patchResponse = async () => {
      record = { ...completed, title: "其他窗口的新标题", version: 2 };
      return errorResponse(
        { raw: "DO NOT SHOW DETAILS" },
        "INSPIRATION_BUSY",
        409,
      );
    };
    renderWorkspace();
    await openRecord(user);
    await user.click(screen.getByRole("button", { name: "重命名" }));
    await user.clear(screen.getByRole("textbox", { name: "研究标题" }));
    await user.type(
      screen.getByRole("textbox", { name: "研究标题" }),
      "新版研究",
    );
    await user.click(screen.getByRole("button", { name: "保存标题" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "记录已更新，请重试",
    );
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(
      await historyRecord(user, /其他窗口的新标题/),
    ).toBeVisible();
    expect(screen.queryByText("DO NOT SHOW DETAILS")).not.toBeInTheDocument();
  });
  it("requires confirmation before deleting and clears the selected record", async () => {
    const user = userEvent.setup();
    record = completed;
    renderWorkspace();
    await openRecord(user);
    await user.click(screen.getByRole("button", { name: "删除研究" }));
    const dialog = screen.getByRole("dialog", { name: "删除研究？" });
    expect(requests).not.toContain(`DELETE ${endpoint}`);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除研究" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("暂无研究记录")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).not.toBeInTheDocument();
    expect(
      requests.filter((request) => request === `GET ${endpoint}`),
    ).toHaveLength(1);
  });
  it("enables, copies and revokes a public share link", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    record = completed;
    renderWorkspace();
    await openRecord(user);
    await user.click(screen.getByRole("button", { name: "分享研究" }));
    await user.click(screen.getByRole("button", { name: "开启分享" }));
    const link = await screen.findByRole("link", { name: "打开分享链接" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    await user.click(screen.getByRole("button", { name: "复制链接" }));
    expect(await screen.findByText("已复制链接")).toBeVisible();
    expect(copy).toHaveBeenCalledWith(
      "https://app.example.test/share/inspiration/00000000-0000-4000-8000-000000000099",
    );
    await user.click(screen.getByRole("button", { name: "撤销分享" }));
    expect(
      await screen.findByRole("button", { name: "开启分享" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "打开分享链接" }),
    ).not.toBeInTheDocument();
  });
  it("shows a persisted pending record without unsafe commands", async () => {
    const user = userEvent.setup();
    record = { ...failed, status: "pending", errorCode: null };
    renderWorkspace();
    await selectHistoryRecord(user, /都市轻通勤女装研究/);
    expect(await screen.findByText("正在分析这份研究…")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "删除研究" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重试分析" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建调研" })).toBeDisabled();
  });
  it("fails closed when the list response violates the DTO contract", async () => {
    listOverride = {
      items: [summary],
      nextCursor: null,
      privatePayload: "DO NOT SHOW DETAILS",
    };
    renderWorkspace();
    const historyDialog = await showHistory(userEvent.setup());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "研究记录加载失败",
    );
    expect(
      within(historyDialog).queryByRole("button", {
        name: /都市轻通勤女装研究/,
      }),
    ).not.toBeInTheDocument();
  });
  it("appends another history page using its opaque cursor", async () => {
    const user = userEvent.setup();
    record = completed;
    listOverride = { items: [summary], nextCursor: "b3BhcXVl" };
    renderWorkspace();
    const historyDialog = await showHistory(user);
    await user.click(
      await within(historyDialog).findByRole("button", { name: "加载更多" }),
    );
    expect(
      await within(historyDialog).findByRole("button", {
        name: /夏日材质研究/,
      }),
    ).toBeVisible();
    expect(
      within(historyDialog).getByRole("button", {
        name: /都市轻通勤女装研究/,
      }),
    ).toBeVisible();
    expect(
      within(historyDialog).queryByRole("button", { name: "加载更多" }),
    ).not.toBeInTheDocument();
    expect(requests).toContain(`GET ${root}?limit=20&cursor=b3BhcXVl`);
    await user.keyboard("{Escape}");
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
  });
  it.each([
    {
      method: "create",
      run: () =>
        inspirationApi.create({
          operationId: "00000000-0000-4000-8000-000000000005",
          prompt: "分析近 30 天都市轻通勤女装",
        }),
    },
    { method: "detail", run: () => inspirationApi.detail(completed.id) },
    {
      method: "rename",
      run: () =>
        inspirationApi.rename(completed.id, { title: "新版研究", version: 1 }),
    },
    { method: "retry", run: () => inspirationApi.retry(completed.id) },
    { method: "share", run: () => inspirationApi.share(completed.id, true) },
    { method: "delete", run: () => inspirationApi.delete(completed.id) },
  ])("rejects malformed successful $method responses", async ({ run }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ...completed, unknown: "secret" })),
    );
    await expect(run()).rejects.toThrow();
  });
  it("does not display malformed successful create data as a saved result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ ...completed, unknown: "secret" })),
    );
    const user = userEvent.setup();
    // Keep list valid, and break only the create response.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init?: RequestInit) => {
        if (
          String(input) === `${root}?limit=20` &&
          (init?.method ?? "GET") === "GET"
        )
          return json({ items: [], nextCursor: null });
        expect(String(input)).toBe(root);
        expect(init?.method).toBe("POST");
        inspirationCreateMutationSchema.parse(JSON.parse(String(init?.body)));
        return json({ ...completed, unknown: "secret" });
      }),
    );
    renderWorkspace();
    await submit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "分析暂时失败，请稍后重试",
    );
    expect(screen.queryByText("已自动保存")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).not.toBeInTheDocument();
  });
});

// These deferred HTTP boundaries hold the UI in the race windows from review.
function delayedSecondAnalysis() {
  const next: InspirationDetailDto = {
    ...completed,
    id: "00000000-0000-4000-8000-000000000002",
    title: "夏日材质研究",
    result: { ...completed.result!, headline: "夏日材质新结果" },
  };
  const baseFetch = fetch;
  let finish!: (response: Response) => void;
  let created = false;
  const writes: { url: string; method: string; body: unknown }[] = [];
  createResponse = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `${root}?limit=20` && method === "GET" && created) {
        expect(init?.body).toBeUndefined();
        return json(
          inspirationListDtoSchema.parse({
            items: [inspirationSummaryDtoSchema.strip().parse(next), summary],
            nextCursor: null,
          }),
        );
      }
      if (url === `${root}/${next.id}` && method === "GET") {
        expect(init?.body).toBeUndefined();
        return json(inspirationDetailDtoSchema.parse(next));
      }
      if (
        method === "PATCH" &&
        [endpoint, `${root}/${next.id}`].includes(url)
      ) {
        const body = inspirationPatchMutationSchema.parse(
          JSON.parse(String(init?.body)),
        );
        expect(body).toEqual({ title: "新版研究", version: 1 });
        writes.push({ url, method, body });
        return json(
          inspirationDetailDtoSchema.parse({
            ...(url === endpoint ? completed : next),
            title: body.title,
            version: 2,
          }),
        );
      }
      return baseFetch(input, init);
    }),
  );
  return {
    next,
    writes,
    finish: () => {
      created = true;
      finish(json(inspirationDetailDtoSchema.parse(next), 201));
    },
  };
}

describe("review regressions: concurrent completion, deletion, and dialog focus", () => {
  it("never sends a historical rename draft to a newly completed analysis", async () => {
    const user = userEvent.setup();
    record = completed;
    const server = delayedSecondAnalysis();
    renderWorkspace();
    await openRecord(user);
    await submit(user);
    await user.click(screen.getByRole("button", { name: "重命名" }));
    await user.clear(screen.getByRole("textbox", { name: "研究标题" }));
    await user.type(
      screen.getByRole("textbox", { name: "研究标题" }),
      "新版研究",
    );
    await act(async () => server.finish());
    await screen.findByRole("heading", {
      name: "夏日材质新结果",
      hidden: true,
    });
    const editor = screen.queryByRole("dialog", { name: "重命名研究" });
    if (editor)
      await user.click(
        within(editor).getByRole("button", { name: "保存标题" }),
      );
    expect(
      server.writes.filter(
        (write) => write.url === `${root}/${server.next.id}`,
      ),
    ).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "夏日材质新结果" }),
    ).toBeVisible();
  });

  it("closes the historical share dialog before selecting a newly completed analysis", async () => {
    const user = userEvent.setup();
    record = completed;
    const server = delayedSecondAnalysis();
    renderWorkspace();
    await openRecord(user);
    await submit(user);
    await user.click(screen.getByRole("button", { name: "分享研究" }));
    expect(screen.getByRole("dialog", { name: "分享研究" })).toHaveTextContent(
      "都市轻通勤女装研究",
    );
    await act(async () => server.finish());
    await screen.findByRole("heading", {
      name: "夏日材质新结果",
      hidden: true,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "夏日材质新结果" }),
    ).toBeVisible();
  });

  it.each(["success", "failure"] as const)(
    "does not resurrect a deleted first record while list revalidation is delayed (%s)",
    async (outcome) => {
      const user = userEvent.setup();
      record = completed;
      const baseFetch = fetch;
      let deleted = false;
      let refetchStarted = false;
      let finishList!: (response: Response) => void;
      const postDeleteDetailReads: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === endpoint && method === "DELETE") {
            expect(init?.body).toBeUndefined();
            const response = await baseFetch(input, init);
            deleted = true;
            return response;
          }
          if (deleted && url === `${root}?limit=20` && method === "GET") {
            expect(init?.body).toBeUndefined();
            refetchStarted = true;
            return new Promise<Response>((resolve) => {
              finishList = resolve;
            });
          }
          if (deleted && url === endpoint && method === "GET") {
            expect(init?.body).toBeUndefined();
            postDeleteDetailReads.push(url);
            return errorResponse(undefined, "INSPIRATION_NOT_FOUND", 404);
          }
          return baseFetch(input, init);
        }),
      );
      renderWorkspace();
      await openRecord(user);
      await user.click(screen.getByRole("button", { name: "删除研究" }));
      await user.click(screen.getByRole("button", { name: "确认删除" }));
      await waitFor(() => expect(refetchStarted).toBe(true));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(postDeleteDetailReads).toEqual([]);
      expect(screen.queryByText("研究详情加载失败")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "都市轻通勤的柔和层次" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "开始一份灵感调研" }),
      ).toBeVisible();
      await act(async () =>
        finishList(
          outcome === "success"
            ? json(
                inspirationListDtoSchema.parse({ items: [], nextCursor: null }),
              )
            : errorResponse(undefined, "REQUEST_FAILED", 503),
        ),
      );
      if (outcome === "failure") {
        await showHistory(user);
        await screen.findByText("研究记录加载失败");
      } else await screen.findByText("暂无研究记录");
      expect(postDeleteDetailReads).toEqual([]);
      expect(screen.queryByText("研究详情加载失败")).not.toBeInTheDocument();
    },
  );

  it.each(["first", "second"] as const)(
    "removes a deleted record from the %s infinite page and keeps its remaining selection and cursors",
    async (position) => {
      const user = userEvent.setup();
      const other = {
        ...completed,
        id: "00000000-0000-4000-8000-000000000002",
        title: "夏日材质研究",
        result: { ...completed.result!, headline: "夏日材质新结果" },
      };
      const otherSummary = inspirationSummaryDtoSchema.strip().parse(other);
      const baseFetch = fetch;
      let deleted = false;
      let finishList!: (response: Response) => void;
      const readsAfterDelete: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === endpoint && method === "DELETE") {
            const response = await baseFetch(input, init);
            deleted = true;
            return response;
          }
          if (deleted && url === `${root}?limit=20` && method === "GET") {
            expect(init?.body).toBeUndefined();
            return new Promise<Response>((resolve) => {
              finishList = resolve;
            });
          }
          if (url === `${root}/${other.id}` && method === "GET") {
            expect(init?.body).toBeUndefined();
            return json(inspirationDetailDtoSchema.parse(other));
          }
          if (deleted && url === endpoint && method === "GET")
            readsAfterDelete.push(url);
          return baseFetch(input, init);
        }),
      );
      record = completed;
      const { client } = renderWorkspace(<InspirationView />, {
        pages: [
          {
            items: [position === "first" ? summary : otherSummary],
            nextCursor: "b3BhcXVl",
          },
          {
            items: [position === "first" ? otherSummary : summary],
            nextCursor: null,
          },
        ],
        pageParams: [undefined, "b3BhcXVl"],
      });
      await openRecord(user);
      await user.click(screen.getByRole("button", { name: "删除研究" }));
      await user.click(screen.getByRole("button", { name: "确认删除" }));
      expect(
        await screen.findByRole("heading", { name: "夏日材质新结果" }),
      ).toBeVisible();
      expect(
        await historyRecord(user, /夏日材质研究/),
      ).toHaveAttribute("aria-pressed", "true");
      expect(readsAfterDelete).toEqual([]);
      expect(client.getQueryData(inspirationKeys.list(ownerId))).toEqual({
        pages: [
          {
            items: position === "first" ? [] : [otherSummary],
            nextCursor: "b3BhcXVl",
          },
          {
            items: position === "first" ? [otherSummary] : [],
            nextCursor: null,
          },
        ],
        pageParams: [undefined, "b3BhcXVl"],
      });
      await act(async () =>
        finishList(errorResponse(undefined, "REQUEST_FAILED", 503)),
      );
      await screen.findByText("研究记录加载失败");
      expect(readsAfterDelete).toEqual([]);
    },
  );

  it.each(["cancel", "escape", "save"] as const)(
    "restores rename trigger focus after %s",
    async (action) => {
      const user = userEvent.setup();
      record = completed;
      patchResponse = async () => {
        record = { ...completed, title: "新版研究", version: 2 };
        return detailResponse();
      };
      renderWorkspace();
      await openRecord(user);
      const trigger = screen.getByRole("button", { name: "重命名" });
      await user.click(trigger);
      if (action === "save") {
        await user.clear(screen.getByRole("textbox", { name: "研究标题" }));
        await user.type(
          screen.getByRole("textbox", { name: "研究标题" }),
          "新版研究",
        );
        await user.click(screen.getByRole("button", { name: "保存标题" }));
      } else if (action === "escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: "取消" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(trigger).toHaveFocus());
    },
  );

  it.each(["close", "escape", "revoke then close"] as const)(
    "restores share trigger focus after %s",
    async (action) => {
      const user = userEvent.setup();
      record = {
        ...completed,
        shareUrl:
          "https://app.example.test/share/inspiration/00000000-0000-4000-8000-000000000099",
      };
      renderWorkspace();
      await openRecord(user);
      const trigger = screen.getByRole("button", { name: "分享研究" });
      await user.click(trigger);
      if (action === "revoke then close") {
        await user.click(screen.getByRole("button", { name: "撤销分享" }));
        await screen.findByRole("button", { name: "开启分享" });
      }
      if (action === "escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: "关闭" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(trigger).toHaveFocus());
    },
  );

  it("focuses the research input when deletion removes the command trigger", async () => {
    const user = userEvent.setup();
    record = completed;
    renderWorkspace();
    await openRecord(user);
    await user.click(screen.getByRole("button", { name: "删除研究" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await screen.findByText("暂无研究记录");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "研究需求" })).toHaveFocus(),
    );
  });
});

function pollingHistoryServer() {
  const nextId = "00000000-0000-4000-8000-000000000002";
  let current = { ...completed };
  let next: InspirationDetailDto = {
    ...completed,
    id: nextId,
    title: "夏日材质研究",
    status: "pending",
    completedAt: null,
    result: null,
    sources: null,
  };
  let records = [current, next];
  const writes: { id: string; method: string; body: unknown }[] = [];
  const initialHistory = {
    pages: [
      {
        items: records.map((item) =>
          inspirationSummaryDtoSchema.strip().parse(item),
        ),
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === `${root}?limit=20` && method === "GET") {
        expect(init?.body).toBeUndefined();
        return json(
          inspirationListDtoSchema.parse({
            items: records.map((item) =>
              inspirationSummaryDtoSchema.strip().parse(item),
            ),
            nextCursor: null,
          }),
        );
      }
      const id =
        url === endpoint || url === `${endpoint}/share`
          ? completed.id
          : url === `${root}/${nextId}` || url === `${root}/${nextId}/share`
            ? nextId
            : null;
      if (!id) throw new Error(`Unexpected polling request: ${method} ${url}`);
      const target = records.find((item) => item.id === id);
      if (method === "GET" && url === `${root}/${id}`) {
        expect(init?.body).toBeUndefined();
        return target
          ? json(inspirationDetailDtoSchema.parse(target))
          : errorResponse(undefined, "INSPIRATION_NOT_FOUND", 404);
      }
      if (method === "PATCH" && url === `${root}/${id}`) {
        expect(init?.headers).toMatchObject({
          "Content-Type": "application/json",
        });
        const body = inspirationPatchMutationSchema.parse(
          JSON.parse(String(init?.body)),
        );
        writes.push({ id, method, body });
        if (!target)
          return errorResponse(undefined, "INSPIRATION_NOT_FOUND", 404);
        if (body.version !== target.version)
          return errorResponse(undefined, "INSPIRATION_BUSY", 409);
        const updated = {
          ...target,
          title: body.title,
          version: target.version + 1,
        };
        records = records.map((item) => (item.id === id ? updated : item));
        return json(inspirationDetailDtoSchema.parse(updated));
      }
      if (method === "POST" && url === `${root}/${id}/share`) {
        expect(init?.body).toBeUndefined();
        writes.push({ id, method, body: undefined });
        if (!target)
          return errorResponse(undefined, "INSPIRATION_NOT_FOUND", 404);
        const updated = {
          ...target,
          shareUrl: `https://app.example.test/share/inspiration/${id}`,
          version: target.version + 1,
        };
        records = records.map((item) => (item.id === id ? updated : item));
        return json(inspirationDetailDtoSchema.parse(updated));
      }
      if (method === "DELETE" && url === `${root}/${id}`) {
        expect(init?.body).toBeUndefined();
        writes.push({ id, method, body: undefined });
        records = records.filter((item) => item.id !== id);
        return json({ id, deleted: true });
      }
      throw new Error(`Unexpected polling request: ${method} ${url}`);
    }),
  );
  return {
    initialHistory,
    nextId,
    writes,
    completeAndReorder() {
      next = {
        ...completed,
        id: nextId,
        title: "夏日材质研究",
        result: { ...completed.result!, headline: "夏日材质新结果" },
      };
      records = [next, current];
    },
    bumpCurrentVersion() {
      current = { ...current, version: 2 };
      records = records.map((item) =>
        item.id === current.id ? current : item,
      );
    },
    removeCurrent(empty: boolean) {
      records = empty ? [] : [next];
    },
    empty() {
      records = [];
    },
    restore() {
      records = [current, next];
    },
    currentFirst() {
      records = [current, next];
    },
  };
}
async function waitForHistoryFirst(title: string | null) {
  await waitFor(() => {
    const current = clients.at(-1)?.getQueryData<
      InfiniteData<InspirationListDto, string | undefined>
    >(inspirationKeys.list(ownerId));
    const first = current?.pages.flatMap((page) => page.items)[0]?.title ?? null;
    expect(first).toBe(title);
  });
}
async function refetchHistory(
  client: ReturnType<typeof createQueryClient>,
  firstTitle: string | null,
) {
  await act(async () => {
    await client.refetchQueries({
      queryKey: inspirationKeys.list(ownerId),
      exact: true,
    });
  });
  await waitForHistoryFirst(firstTitle);
}
async function refetchWithCompletedNext(
  client: ReturnType<typeof createQueryClient>,
  nextId: string,
) {
  // Read B through the real client before the list update, avoiding an unrelated loading gap.
  await act(async () => {
    await client.fetchQuery({
      queryKey: inspirationKeys.detail(ownerId, nextId),
      queryFn: () => inspirationApi.detail(nextId),
    });
    await client.refetchQueries({
      queryKey: inspirationKeys.list(ownerId),
      exact: true,
    });
  });
  await waitForHistoryFirst("夏日材质研究");
}

describe("review regressions: default selection during history polling", () => {
  it.each(["hydrated", "fetched"] as const)(
    "pins the default first record after %s history arrives, even when a pending item finishes and sorts first",
    async (arrival) => {
      const user = userEvent.setup();
      const server = pollingHistoryServer();
      const { client } = renderWorkspace(
        <InspirationView />,
        arrival === "hydrated" ? server.initialHistory : undefined,
      );
      // Do not click any history item: this must exercise the implicit initial selection path.
      await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
      server.completeAndReorder();
      await refetchHistory(client, "夏日材质研究");
      expect(
        screen.getByRole("heading", { name: "都市轻通勤的柔和层次" }),
      ).toBeVisible();
      const historyDialog = await showHistory(user);
      expect(
        within(historyDialog).getByRole("button", {
          name: /都市轻通勤女装研究/,
        }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        within(historyDialog).getByRole("button", { name: /夏日材质研究/ }),
      ).toHaveAttribute("aria-pressed", "false");
    },
  );

  it("never PATCHes the default record's draft to the new first record after a real history refetch", async () => {
    const user = userEvent.setup();
    const server = pollingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    const trigger = screen.getByRole("button", { name: "重命名" });
    await user.click(trigger);
    await user.clear(screen.getByRole("textbox", { name: "研究标题" }));
    await user.type(
      screen.getByRole("textbox", { name: "研究标题" }),
      "新版研究",
    );
    server.completeAndReorder();
    await refetchWithCompletedNext(client, server.nextId);
    await user.click(screen.getByRole("button", { name: "保存标题" }));
    expect(server.writes).toEqual([
      {
        id: completed.id,
        method: "PATCH",
        body: { title: "新版研究", version: 1 },
      },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the default record's share dialog and POST target bound when polling reorders history", async () => {
    const user = userEvent.setup();
    const server = pollingHistoryServer();
    const { client } = renderWorkspace(
      <InspirationView />,
      server.initialHistory,
    );
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    const trigger = screen.getByRole("button", { name: "分享研究" });
    await user.click(trigger);
    server.completeAndReorder();
    await refetchWithCompletedNext(client, server.nextId);
    expect(screen.getByRole("dialog", { name: "分享研究" })).toHaveTextContent(
      "都市轻通勤女装研究",
    );
    expect(
      screen.getByRole("dialog", { name: "分享研究" }),
    ).not.toHaveTextContent("夏日材质研究");
    await user.click(screen.getByRole("button", { name: "开启分享" }));
    await screen.findByRole("link", { name: "打开分享链接" });
    expect(server.writes).toEqual([
      { id: completed.id, method: "POST", body: undefined },
    ]);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps delete confirmation bound to the default record when polling reorders history", async () => {
    const user = userEvent.setup();
    const server = pollingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    await user.click(screen.getByRole("button", { name: "删除研究" }));
    server.completeAndReorder();
    await refetchWithCompletedNext(client, server.nextId);
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(server.writes).toEqual([
      { id: completed.id, method: "DELETE", body: undefined },
    ]);
    expect(
      await screen.findByRole("heading", { name: "夏日材质新结果" }),
    ).toBeVisible();
  });

  it("retains the rename version captured when the dialog opened despite a detail refresh", async () => {
    const user = userEvent.setup();
    const server = pollingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    const trigger = screen.getByRole("button", { name: "重命名" });
    await user.click(trigger);
    await user.clear(screen.getByRole("textbox", { name: "研究标题" }));
    await user.type(
      screen.getByRole("textbox", { name: "研究标题" }),
      "新版研究",
    );
    server.bumpCurrentVersion();
    await act(async () => {
      await client.refetchQueries({
        queryKey: inspirationKeys.detail(ownerId, completed.id),
        exact: true,
      });
    });
    await user.click(screen.getByRole("button", { name: "保存标题" }));
    expect(server.writes).toEqual([
      {
        id: completed.id,
        method: "PATCH",
        body: { title: "新版研究", version: 1 },
      },
    ]);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "记录已更新，请重试",
    );
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["next record", "empty history"] as const)(
    "recovers an explicitly selected record that disappears from history into %s",
    async (outcome) => {
      const user = userEvent.setup();
      const server = pollingHistoryServer();
      const { client } = renderWorkspace();
      await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
      await selectHistoryRecord(user, /都市轻通勤女装研究/);
      server.completeAndReorder();
      server.removeCurrent(outcome === "empty history");
      await refetchHistory(
        client,
        outcome === "empty history" ? null : "夏日材质研究",
      );
      if (outcome === "empty history")
        expect(await screen.findByText("暂无研究记录")).toBeVisible();
      else
        expect(
          await screen.findByRole("heading", { name: "夏日材质新结果" }),
        ).toBeVisible();
      expect(screen.queryByText("研究详情加载失败")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "都市轻通勤的柔和层次" }),
      ).not.toBeInTheDocument();
    },
  );

  it("initializes selection when an initially empty history receives its first records and then keeps it pinned", async () => {
    const user = userEvent.setup();
    const server = pollingHistoryServer();
    server.empty();
    const { client } = renderWorkspace();
    await screen.findByText("暂无研究记录");
    expect(
      screen.getByRole("heading", { name: "开始一份灵感调研" }),
    ).toBeVisible();
    server.restore();
    await refetchHistory(client, "都市轻通勤女装研究");
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    server.completeAndReorder();
    await refetchHistory(client, "夏日材质研究");
    expect(
      await historyRecord(user, /都市轻通勤女装研究/),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("respects a user's explicit next-record choice across later reordering", async () => {
    const user = userEvent.setup();
    const server = pollingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    server.completeAndReorder();
    await refetchHistory(client, "夏日材质研究");
    await selectHistoryRecord(user, /夏日材质研究/);
    await screen.findByRole("heading", { name: "夏日材质新结果" });
    server.currentFirst();
    await refetchHistory(client, "都市轻通勤女装研究");
    expect(
      screen.getByRole("heading", { name: "夏日材质新结果" }),
    ).toBeVisible();
    expect(
      await historyRecord(user, /夏日材质研究/),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

function missingHistoryServer() {
  const server = pollingHistoryServer();
  const originalFetch = fetch;
  let missing = false;
  let missingResponse = async () =>
    errorResponse(undefined, "INSPIRATION_BUSY", 503);
  let confirmations = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (
        String(input) === endpoint &&
        (init?.method ?? "GET") === "GET" &&
        missing
      ) {
        expect(init?.body).toBeUndefined();
        confirmations += 1;
        return missingResponse();
      }
      return originalFetch(input, init);
    }),
  );
  return {
    ...server,
    confirmations: () => confirmations,
    loseCurrent(empty = false) {
      server.completeAndReorder();
      server.removeCurrent(empty);
      missing = true;
    },
    respondWith(response: () => Promise<Response>) {
      missingResponse = response;
    },
  };
}

describe("review regressions: missing detail retry recovery", () => {
  it("uses an already confirmed current 404 when history subsequently drops the record", async () => {
    const server = missingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    server.loseCurrent();
    server.respondWith(async () =>
      errorResponse(undefined, "INSPIRATION_NOT_FOUND", 404),
    );
    await act(async () => {
      await client.refetchQueries({
        queryKey: inspirationKeys.detail(ownerId, completed.id),
        exact: true,
      });
    });
    await screen.findByRole("alert");
    // The confirmed 404 remains authoritative even if a later request would fail transiently.
    server.respondWith(async () =>
      errorResponse(undefined, "INSPIRATION_BUSY", 503),
    );
    await refetchHistory(client, "夏日材质研究");
    expect(
      await screen.findByRole("heading", { name: "夏日材质新结果" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).not.toBeInTheDocument();
  });

  it("recovers an automatic 404, closes the old dialog, and restores stable focus", async () => {
    const user = userEvent.setup();
    const server = missingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    await user.click(screen.getByRole("button", { name: "重命名" }));
    server.respondWith(async () =>
      errorResponse(undefined, "INSPIRATION_NOT_FOUND", 404),
    );
    server.loseCurrent();
    await refetchHistory(client, "夏日材质研究");
    await screen.findByRole("heading", { name: "夏日材质新结果" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("研究详情加载失败")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "新建调研" })).toHaveFocus(),
    );
  });

  it.each(["next record", "empty history"] as const)(
    "recovers a manual 404 after an automatic 503 into %s",
    async (outcome) => {
      const user = userEvent.setup();
      const server = missingHistoryServer();
      const { client } = renderWorkspace();
      await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
      server.loseCurrent(outcome === "empty history");
      await refetchHistory(
        client,
        outcome === "empty history" ? null : "夏日材质研究",
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "研究详情加载失败",
      );
      expect(
        screen.getByRole("button", { name: "重新加载详情" }),
      ).toBeVisible();
      server.respondWith(async () =>
        errorResponse(undefined, "INSPIRATION_NOT_FOUND", 404),
      );
      await user.click(screen.getByRole("button", { name: "重新加载详情" }));
      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: "都市轻通勤的柔和层次" }),
        ).not.toBeInTheDocument();
        if (outcome === "empty history")
          expect(screen.getByText("暂无研究记录")).toBeVisible();
        else
          expect(
            screen.getByRole("heading", { name: "夏日材质新结果" }),
          ).toBeVisible();
      });
      expect(screen.queryByText("研究详情加载失败")).not.toBeInTheDocument();
      expect(
        client.getQueryData(inspirationKeys.detail(ownerId, completed.id)),
      ).toBeUndefined();
      await waitFor(() => {
        if (outcome === "empty history")
          expect(
            screen.getByRole("textbox", { name: "研究需求" }),
          ).toHaveFocus();
        else
          expect(
            screen.getByRole("button", { name: "新建调研" }),
          ).toHaveFocus();
      });
    },
  );

  it("keeps non-404 detail failures visible and allows another manual retry", async () => {
    const user = userEvent.setup();
    const server = missingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    server.loseCurrent();
    await refetchHistory(client, "夏日材质研究");
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "重新加载详情" }));
    await waitFor(() => expect(server.confirmations()).toBe(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "研究详情加载失败",
    );
    expect(screen.getByRole("button", { name: "重新加载详情" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).toBeVisible();
  });

  it("ignores A's late manual 404 after the user selects B following a 503", async () => {
    const user = userEvent.setup();
    const server = missingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    server.loseCurrent();
    await refetchHistory(client, "夏日材质研究");
    await screen.findByRole("alert");
    let finish!: (response: Response) => void;
    server.respondWith(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "重新加载详情" }));
    await waitFor(() => expect(server.confirmations()).toBe(2));
    await selectHistoryRecord(user, /夏日材质研究/);
    await screen.findByRole("heading", { name: "夏日材质新结果" });
    await act(async () => {
      finish(errorResponse(undefined, "INSPIRATION_NOT_FOUND", 404));
    });
    // Wait for the detached request to settle at the real query boundary.
    await waitFor(() =>
      expect(
        client.getQueryState(inspirationKeys.detail(ownerId, completed.id))
          ?.fetchStatus,
      ).toBe("idle"),
    );
    expect(
      screen.getByRole("heading", { name: "夏日材质新结果" }),
    ).toBeVisible();
    expect(
      await historyRecord(user, /夏日材质研究/),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("研究详情加载失败")).not.toBeInTheDocument();
  });
});

describe("protected inspiration page", () => {
  it("hydrates the first twenty history items for the authenticated owner without an internal HTTP roundtrip", async () => {
    const user = userEvent.setup();
    pageMocks.requireUser.mockResolvedValue({ id: ownerId });
    pageMocks.listInspirationAnalyses.mockResolvedValue({
      items: [summary],
      nextCursor: null,
    });
    record = completed;
    const { default: InspirationPage } =
      await import("@/app/(workspace)/inspiration/page");
    renderWorkspace(await InspirationPage());
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    expect(
      await historyRecord(user, /都市轻通勤女装研究/),
    ).toBeVisible();
    expect(pageMocks.listInspirationAnalyses).toHaveBeenCalledExactlyOnceWith({
      ownerId,
      limit: 20,
    });
    expect(requests).not.toContain(`GET ${root}?limit=20`);
  });
  it("requires a session before reading history", async () => {
    pageMocks.requireUser.mockRejectedValue(new Error("redirect to login"));
    const { default: InspirationPage } =
      await import("@/app/(workspace)/inspiration/page");
    await expect(InspirationPage()).rejects.toThrow("redirect to login");
    expect(pageMocks.listInspirationAnalyses).not.toHaveBeenCalled();
  });
});
