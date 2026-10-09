import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseLibrarySearchParams,
  toPatternQuery,
} from "@/features/library/query-state";
import type {
  PatternItem,
  PatternPage,
} from "@/features/library/library-types";
import { queryKeys } from "@/lib/query/keys";

import { LibraryView } from "./library-view";
import { usePatternPatchMutation } from "./pattern-mutations";
import { WorkspaceShell } from "./workspace-shell";

const navigation = vi.hoisted(() => ({
  pathname: "/library",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}));

const makePattern = (index: number): PatternItem => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  ownerId: "10000000-0000-4000-8000-000000000000",
  name: `Pattern ${index}`,
  originalFilename: `pattern-${index}.psd`,
  extension: index % 2 === 0 ? "psd" : "png",
  detectedMimeType: null,
  sizeBytes: String(index * 1024),
  contentHash: null,
  status: "ready",
  previewStatus: index % 2 === 0 ? "unsupported" : "ready",
  isFavorite: false,
  version: 0,
  commercialVersion: 0,
  lastErrorCode: null,
  trashedAt: null,
  deletedAt: null,
  changeSeq: "0",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
});

const query = toPatternQuery(parseLibrarySearchParams(new URLSearchParams()));

function createClient(items: PatternItem[]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const page: PatternPage = { items, nextCursor: null };
  client.setQueryData<InfiniteData<PatternPage, string | null>>(
    queryKeys.patterns(query),
    { pages: [page], pageParams: [null] },
  );
  for (const item of items) {
    client.setQueryData(queryKeys.pattern(item.id), item);
    client.setQueryData(queryKeys.patternTags(item.id), { items: [] });
  }
  client.setQueryData(queryKeys.tags, []);
  return client;
}

function renderLibrary(items = Array.from({ length: 120 }, (_, i) => makePattern(i + 1))) {
  const client = createClient(items);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <Tooltip.Provider>
          <LibraryView initialQuery={query} />
        </Tooltip.Provider>
      </QueryClientProvider>,
    ),
  };
}

describe("Mac-first workspace", () => {
  beforeEach(() => {
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        constructor(
          private readonly callback: ResizeObserverCallback,
        ) {}
        observe(target: Element) {
          this.callback(
            [
              {
                target,
                contentRect: {
                  width: 900,
                  height: 700,
                } as DOMRectReadOnly,
              } as ResizeObserverEntry,
            ],
            this,
          );
        }
        disconnect() {}
        unobserve() {}
      },
    );
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the specified desktop, inspector, rail, and iPad overflow geometry", () => {
    const client = createClient([]);
    render(
      <QueryClientProvider client={client}>
        <WorkspaceShell
          user={{ displayName: "Lin", email: "lin@example.test" }}
        >
          <p>Workspace content</p>
        </WorkspaceShell>
      </QueryClientProvider>,
    );

    expect(document.querySelector(".workspace")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "主导航" })).toHaveClass(
      "workspace-sidebar",
    );

    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.workspace\s*\{[^}]*grid-template-columns:\s*220px minmax\(0,\s*1fr\) auto/s,
    );
    expect(css).toMatch(/\.library-inspector\s*\{[^}]*width:\s*340px/s);
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1100px\)[\s\S]*grid-template-columns:\s*56px minmax\(0,\s*1fr\) auto/,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1200px\)[\s\S]*\.library-inspector\s*\{[^}]*position:\s*absolute/,
    );
    expect(css).toMatch(/\.workspace\s*\{[^}]*overflow-x:\s*clip/s);
  });

  it("renders a bounded virtual result region instead of every result", async () => {
    renderLibrary();

    const region = await screen.findByRole("region", { name: "图案结果" });
    const renderedOptions = screen.getAllByRole("option");

    expect(region).toHaveAttribute("data-virtualized", "true");
    expect(renderedOptions.length).toBeGreaterThan(0);
    expect(renderedOptions.length).toBeLessThan(120);
  });

  it("measures the result region before the first ResizeObserver callback", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function clientWidth(this: HTMLElement) {
        return this.classList.contains("pattern-results") ? 1180 : 0;
      },
    );

    renderLibrary(Array.from({ length: 12 }, (_, i) => makePattern(i + 1)));

    const firstRow = await waitFor(() => {
      const row = document.querySelector<HTMLElement>(".virtual-pattern-row");
      expect(row).not.toBeNull();
      return row!;
    });
    expect(firstRow.style.gridTemplateColumns).toBe(
      "repeat(6, minmax(0, 1fr))",
    );
  });

  it("selects without refetching and opens or closes preview with Space and Escape", async () => {
    const fetchMock = vi.mocked(fetch);
    const user = userEvent.setup();
    renderLibrary([makePattern(1), makePattern(2)]);

    const first = await screen.findByRole("option", { name: /Pattern 1/ });
    await user.click(first);
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.keyboard(" ");
    expect(screen.getByRole("dialog", { name: "Pattern 1 预览" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(first).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Escape}");
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not run the preview shortcut while an interactive control has focus", async () => {
    const user = userEvent.setup();
    renderLibrary([makePattern(1)]);

    await user.click(screen.getByRole("option", { name: /Pattern 1/ }));
    const listView = screen.getByRole("button", { name: "列表视图" });
    listView.focus();
    await user.keyboard(" ");

    expect(listView).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clears selections that disappear after the active result refreshes", async () => {
    const item = makePattern(1);
    const { client } = renderLibrary([item]);

    fireEvent.click(await screen.findByRole("option", { name: /Pattern 1/ }));
    expect(screen.getByText("已选择 1 项")).toBeVisible();
    act(() => {
      client.setQueryData<InfiniteData<PatternPage, string | null>>(
        queryKeys.patterns(query),
        { pages: [{ items: [], nextCursor: null }], pageParams: [null] },
      );
    });

    await waitFor(() =>
      expect(screen.queryByText("已选择 1 项")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("complementary", { name: "图案检查器" }))
      .not.toBeInTheDocument();
  });

  it("offers a checkbox menu that writes tag filters to the canonical URL", async () => {
    const user = userEvent.setup();
    const { client } = renderLibrary([makePattern(1)]);
    act(() => {
      client.setQueryData(queryKeys.tags, [
        {
          id: "00000000-0000-4000-8000-000000000091",
          ownerId: "10000000-0000-4000-8000-000000000000",
          name: "花卉",
          normalizedName: "花卉",
          colorToken: "green",
          changeSeq: "1",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
        },
        {
          id: "00000000-0000-4000-8000-000000000092",
          ownerId: "10000000-0000-4000-8000-000000000000",
          name: "几何",
          normalizedName: "几何",
          colorToken: "blue",
          changeSeq: "2",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
        },
      ]);
    });

    await user.click(screen.getByRole("button", { name: "筛选标签" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /花卉/ }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /几何/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "任一匹配" }));

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/library?tag=00000000-0000-4000-8000-000000000091&tag=00000000-0000-4000-8000-000000000092&tagMode=any",
    );
  });

  it("opens preview on double click and allows the 340 px inspector to collapse", async () => {
    const user = userEvent.setup();
    renderLibrary([makePattern(1)]);

    const first = await screen.findByRole("option", { name: /Pattern 1/ });
    await user.click(first);
    expect(screen.getByRole("complementary", { name: "图案检查器" })).toHaveClass(
      "library-inspector",
    );

    await user.click(screen.getByRole("button", { name: "收起检查器" }));
    expect(
      screen.queryByRole("complementary", { name: "图案检查器" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "显示检查器" }));
    expect(screen.getByRole("complementary", { name: "图案检查器" })).toBeVisible();

    fireEvent.doubleClick(first);
    expect(screen.getByRole("dialog", { name: "Pattern 1 预览" })).toBeVisible();
  });

  it("debounces name changes for 400 ms and flushes the latest name on blur", async () => {
    vi.useFakeTimers();
    const item = makePattern(1);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        ...item,
        ...body.patch,
        version: item.version + 1,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLibrary([item]);

    fireEvent.click(screen.getByRole("option", { name: /Pattern 1/ }));
    const input = screen.getByRole("textbox", { name: "图案名称" });
    fireEvent.change(input, { target: { value: "New pattern name" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const patchCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(1);
    expect(
      JSON.parse(String(patchCalls[0]?.[1]?.body)).patch.name,
    ).toBe("New pattern name");
  });

  it("restores the committed name when an automatic rename fails", async () => {
    vi.useFakeTimers();
    const item = makePattern(1);
    let resolvePatch!: (response: Response) => void;
    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return pendingPatch;
      if (String(input).startsWith("/api/patterns?")) {
        return Promise.resolve(
          Response.json({ items: [item], nextCursor: null }),
        );
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLibrary([item]);

    fireEvent.click(screen.getByRole("option", { name: /Pattern 1/ }));
    const input = screen.getByRole("textbox", { name: "图案名称" });
    fireEvent.change(input, { target: { value: "Rejected name" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(1);

    await act(async () => {
      resolvePatch(
        Response.json(
          { error: { code: "PATTERN_STATE_CHANGED", message: "changed" } },
          { status: 409 },
        ),
      );
      await pendingPatch;
      await vi.runAllTimersAsync();
    });

    expect(input).toHaveValue(item.name);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "名称未能保存，已恢复原值",
    );
  });

  it("does not submit the same rename twice when blur follows the timer", async () => {
    vi.useFakeTimers();
    const item = makePattern(1);
    const pendingPatch = new Promise<Response>(() => {});
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return pendingPatch;
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLibrary([item]);

    fireEvent.click(screen.getByRole("option", { name: /Pattern 1/ }));
    const input = screen.getByRole("textbox", { name: "图案名称" });
    fireEvent.change(input, { target: { value: "One request" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(1);

    fireEvent.blur(input);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(1);
  });

  it("serializes a newer rename behind the pending request and uses its returned version", async () => {
    vi.useFakeTimers();
    const item = makePattern(1);
    const patchResolvers: Array<(response: Response) => void> = [];
    let serverItem = item;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => patchResolvers.push(resolve));
      }
      if (String(input).startsWith("/api/patterns?")) {
        return Promise.resolve(
          Response.json({ items: [serverItem], nextCursor: null }),
        );
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLibrary([item]);

    fireEvent.click(screen.getByRole("option", { name: /Pattern 1/ }));
    const input = screen.getByRole("textbox", { name: "图案名称" });
    fireEvent.change(input, { target: { value: "First name" } });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    fireEvent.change(input, { target: { value: "Latest name" } });
    await act(async () => vi.advanceTimersByTimeAsync(400));

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(1);
    expect(input).toHaveValue("Latest name");

    serverItem = { ...item, name: "First name", version: 1 };
    await act(async () => {
      patchResolvers[0]!(Response.json(serverItem));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(2);
    expect(input).toHaveValue("Latest name");

    const patchCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCalls[0]![1]?.body)).patch).toMatchObject({
      name: "First name",
      version: 0,
    });
    expect(JSON.parse(String(patchCalls[1]![1]?.body)).patch).toMatchObject({
      name: "Latest name",
      version: 1,
    });

    serverItem = { ...serverItem, name: "Latest name", version: 2 };
    await act(async () => {
      patchResolvers[1]!(Response.json(serverItem));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input).toHaveValue("Latest name");
  });

  it("serializes favorite behind a pending rename and refreshes its version", async () => {
    vi.useFakeTimers();
    const item = makePattern(1);
    const patchResolvers: Array<(response: Response) => void> = [];
    let serverItem = item;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => patchResolvers.push(resolve));
      }
      if (String(input).startsWith("/api/patterns?")) {
        return Promise.resolve(
          Response.json({ items: [serverItem], nextCursor: null }),
        );
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLibrary([item]);

    fireEvent.click(screen.getByRole("option", { name: /Pattern 1/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "图案名称" }), {
      target: { value: "Renamed first" },
    });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    fireEvent.click(
      within(screen.getByRole("option", { name: /Pattern 1/ })).getByRole(
        "button",
        { name: "收藏" },
      ),
    );

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(1);

    serverItem = { ...item, name: "Renamed first", version: 1 };
    await act(async () => {
      patchResolvers[0]!(Response.json(serverItem));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"))
      .toHaveLength(2);
    const favoriteBody = JSON.parse(
      String(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")[1]![1]
          ?.body,
      ),
    );
    expect(favoriteBody.patch).toMatchObject({ isFavorite: true, version: 1 });

    serverItem = { ...serverItem, isFavorite: true, version: 2 };
    await act(async () => {
      patchResolvers[1]!(Response.json(serverItem));
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});

function MutationHarness({ item }: { item: PatternItem }) {
  const mutation = usePatternPatchMutation(query);
  return (
    <button
      type="button"
      onClick={() =>
        mutation.mutatePattern({
          patternId: item.id,
          patch: { version: item.version, isFavorite: true },
        })
      }
    >
      Favorite
    </button>
  );
}

describe("pattern editor mutation", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("updates detail and active list optimistically, then fully rolls back", async () => {
    const item = makePattern(1);
    const client = createClient([item]);
    let rejectRequest!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      rejectRequest = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pendingResponse);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={client}>
        <MutationHarness item={item} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    await waitFor(() => {
      expect(
        client.getQueryData<PatternItem>(queryKeys.pattern(item.id))
          ?.isFavorite,
      ).toBe(true);
      expect(
        client.getQueryData<InfiniteData<PatternPage, string | null>>(
          queryKeys.patterns(query),
        )?.pages[0]?.items[0]?.isFavorite,
      ).toBe(true);
    });

    await act(async () => {
      rejectRequest(
        Response.json(
          { error: { code: "PATTERN_STATE_CHANGED", message: "changed" } },
          { status: 409 },
        ),
      );
      await pendingResponse;
    });

    await waitFor(() => {
      expect(
        client.getQueryData<PatternItem>(queryKeys.pattern(item.id))
          ?.isFavorite,
      ).toBe(false);
      expect(
        client.getQueryData<InfiniteData<PatternPage, string | null>>(
          queryKeys.patterns(query),
        )?.pages[0]?.items[0]?.isFavorite,
      ).toBe(false);
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
