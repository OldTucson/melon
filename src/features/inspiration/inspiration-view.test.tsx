import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
function renderWorkspace(ui = <InspirationView />) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  clients.push(client);
  client.setQueryData(["owner", ownerId, "folders"], ["unrelated"]);
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
