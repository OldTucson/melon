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
import { createQueryClient } from "@/lib/query/client";
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
vi.mock("@/features/auth/session", () => ({
  requireUser: pageMocks.requireUser,
}));
vi.mock("@/features/inspiration/analysis-service", () => ({
  listInspirationAnalyses: pageMocks.listInspirationAnalyses,
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
  await user.type(
    screen.getByRole("textbox", { name: "研究需求" }),
    "分析近 30 天都市轻通勤女装",
  );
  await user.click(screen.getByRole("button", { name: "开始分析" }));
}
async function openRecord(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: /都市轻通勤女装研究/ }),
  );
  await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
}

beforeEach(() => {
  record = null;
  listOverride = undefined;
  requests = [];
  clients = [];
  consoleError = vi.spyOn(console, "error");
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
      screen.getByRole("button", { name: /都市轻通勤女装研究/ }),
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
    expect(screen.getByRole("button", { name: "分析中…" })).toBeDisabled();
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
      await screen.findByRole("button", { name: /其他窗口的新标题/ }),
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
    await user.click(
      await screen.findByRole("button", { name: /都市轻通勤女装研究/ }),
    );
    expect(await screen.findByText("正在分析这份研究…")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "删除研究" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重试分析" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始分析" })).toBeDisabled();
  });
  it("fails closed when the list response violates the DTO contract", async () => {
    listOverride = {
      items: [summary],
      nextCursor: null,
      privatePayload: "DO NOT SHOW DETAILS",
    };
    renderWorkspace();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "研究记录加载失败",
    );
    expect(
      screen.queryByRole("button", { name: /都市轻通勤女装研究/ }),
    ).not.toBeInTheDocument();
  });
  it("appends another history page using its opaque cursor", async () => {
    const user = userEvent.setup();
    record = completed;
    listOverride = { items: [summary], nextCursor: "b3BhcXVl" };
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(
      await screen.findByRole("button", { name: /夏日材质研究/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /都市轻通勤女装研究/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "加载更多" }),
    ).not.toBeInTheDocument();
    expect(requests).toContain(`GET ${root}?limit=20&cursor=b3BhcXVl`);
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
      expect(screen.getByText("暂无研究结果")).toBeVisible();
      await act(async () =>
        finishList(
          outcome === "success"
            ? json(
                inspirationListDtoSchema.parse({ items: [], nextCursor: null }),
              )
            : errorResponse(undefined, "REQUEST_FAILED", 503),
        ),
      );
      if (outcome === "failure") await screen.findByText("研究记录加载失败");
      else await screen.findByText("暂无研究记录");
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
        screen.getByRole("button", { name: /夏日材质研究/ }),
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
      expect(
        screen.getByRole("heading", { name: "夏日材质新结果" }),
      ).toBeVisible();
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
    if (title === null)
      expect(screen.getByText("暂无研究记录")).toBeInTheDocument();
    else
      expect(
        within(
          screen.getByRole("complementary", { name: "研究历史", hidden: true }),
        ).getAllByRole("button", { hidden: true })[0],
      ).toHaveTextContent(title);
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
        screen.getByRole("button", { name: /都市轻通勤女装研究/ }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.getByRole("heading", { name: "都市轻通勤的柔和层次" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: /夏日材质研究/ }),
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
      await user.click(
        screen.getByRole("button", { name: /都市轻通勤女装研究/ }),
      );
      server.completeAndReorder();
      server.removeCurrent(outcome === "empty history");
      await refetchHistory(
        client,
        outcome === "empty history" ? null : "夏日材质研究",
      );
      if (outcome === "empty history")
        expect(await screen.findByText("暂无研究结果")).toBeVisible();
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
    const server = pollingHistoryServer();
    server.empty();
    const { client } = renderWorkspace();
    await screen.findByText("暂无研究记录");
    expect(screen.getByText("暂无研究结果")).toBeVisible();
    server.restore();
    await refetchHistory(client, "都市轻通勤女装研究");
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    server.completeAndReorder();
    await refetchHistory(client, "夏日材质研究");
    expect(
      screen.getByRole("button", { name: /都市轻通勤女装研究/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("respects a user's explicit next-record choice across later reordering", async () => {
    const user = userEvent.setup();
    const server = pollingHistoryServer();
    const { client } = renderWorkspace();
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
    server.completeAndReorder();
    await refetchHistory(client, "夏日材质研究");
    await user.click(screen.getByRole("button", { name: /夏日材质研究/ }));
    await screen.findByRole("heading", { name: "夏日材质新结果" });
    server.currentFirst();
    await refetchHistory(client, "都市轻通勤女装研究");
    expect(
      screen.getByRole("button", { name: /夏日材质研究/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("heading", { name: "夏日材质新结果" }),
    ).toBeVisible();
  });
});

describe("protected inspiration page", () => {
  it("hydrates the first twenty history items for the authenticated owner without an internal HTTP roundtrip", async () => {
    pageMocks.requireUser.mockResolvedValue({ id: ownerId });
    pageMocks.listInspirationAnalyses.mockResolvedValue({
      items: [summary],
      nextCursor: null,
    });
    record = completed;
    const { default: InspirationPage } =
      await import("@/app/(workspace)/inspiration/page");
    renderWorkspace(await InspirationPage());
    expect(
      await screen.findByRole("button", { name: /都市轻通勤女装研究/ }),
    ).toBeVisible();
    expect(pageMocks.listInspirationAnalyses).toHaveBeenCalledExactlyOnceWith({
      ownerId,
      limit: 20,
    });
    expect(requests).not.toContain(`GET ${root}?limit=20`);
    await screen.findByRole("heading", { name: "都市轻通勤的柔和层次" });
  });
  it("requires a session before reading history", async () => {
    pageMocks.requireUser.mockRejectedValue(new Error("redirect to login"));
    const { default: InspirationPage } =
      await import("@/app/(workspace)/inspiration/page");
    await expect(InspirationPage()).rejects.toThrow("redirect to login");
    expect(pageMocks.listInspirationAnalyses).not.toHaveBeenCalled();
  });
});
