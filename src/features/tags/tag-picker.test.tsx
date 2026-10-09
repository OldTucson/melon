import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseLibrarySearchParams,
  toPatternQuery,
} from "@/features/library/query-state";
import type { TagItem } from "@/features/library/library-types";
import { queryKeys } from "@/lib/query/keys";
import { QueryOwnerProvider } from "@/lib/query/provider";

import { TagPicker } from "./tag-picker";

const patternId = "00000000-0000-4000-8000-000000000010";
const ownerId = "10000000-0000-4000-8000-000000000000";
const tagA = "00000000-0000-4000-8000-000000000001";
const tagB = "00000000-0000-4000-8000-000000000002";
const query = toPatternQuery(parseLibrarySearchParams(new URLSearchParams()));
const tags: TagItem[] = [
  {
    id: tagA,
    ownerId,
    name: "花卉",
    normalizedName: "花卉",
    colorToken: "green",
    changeSeq: "1",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  },
  {
    id: tagB,
    ownerId,
    name: "几何",
    normalizedName: "几何",
    colorToken: "blue",
    changeSeq: "2",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  },
];

function createClient(activeTagIds: string[] = []) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(queryKeys.tags(ownerId), tags);
  client.setQueryData(queryKeys.patternTags(ownerId, patternId), {
    items: activeTagIds.map((tagId) => ({
      ownerId: tags[0]!.ownerId,
      patternId,
      tagId,
      isActive: true,
      version: 0,
      changeSeq: "1",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    })),
  });
  return client;
}

function createEmptyClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function renderPicker(client = createClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <QueryOwnerProvider ownerId={ownerId}>
          <TagPicker patternId={patternId} activeQuery={query} />
        </QueryOwnerProvider>
      </QueryClientProvider>,
    ),
  };
}

describe("tag picker", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("filters searchable checkboxes and renders fixed color swatches", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderPicker();

    expect(screen.getByRole("checkbox", { name: "花卉" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "几何" })).toBeVisible();
    expect(document.querySelector('[data-color-token="green"]')).toHaveClass(
      "tag-swatch",
    );

    await user.type(screen.getByRole("searchbox", { name: "搜索标签" }), "花");
    expect(screen.getByRole("checkbox", { name: "花卉" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "几何" })).toBeNull();
  });

  it.each(["tags", "relations"] as const)(
    "blocks writes and retries when the initial %s query fails",
    async (failedQuery) => {
      let failedOnce = false;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const isTarget =
          failedQuery === "tags"
            ? url === "/api/tags"
            : url === `/api/patterns/${patternId}/tags`;
        if (isTarget && !failedOnce) {
          failedOnce = true;
          throw new TypeError("offline");
        }
        if (url === "/api/tags") return Response.json(tags);
        if (url === `/api/patterns/${patternId}/tags`) {
          return Response.json({ items: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      renderPicker(createEmptyClient());

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "标签数据无法载入，修改已禁用",
      );
      expect(screen.getByRole("button", { name: "创建标签" })).toBeDisabled();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "重试读取标签" }));

      expect(
        await screen.findByRole("checkbox", { name: "花卉" }),
      ).toBeEnabled();
      expect(screen.getByRole("button", { name: "创建标签" })).toBeEnabled();
    },
  );

  it("optimistically checks a tag and rolls back a readable 21st-tag error", async () => {
    let resolveRequest!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/tags/${tagA}`) && init?.method === "PUT") {
        return pending;
      }
      if (url === "/api/tags" && !init?.method) {
        return Promise.resolve(Response.json(tags));
      }
      if (url === `/api/patterns/${patternId}/tags` && !init?.method) {
        return Promise.resolve(Response.json({ items: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPicker();

    const checkbox = screen.getByRole("checkbox", { name: "花卉" });
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());

    await act(async () => {
      resolveRequest(
        Response.json(
          {
            error: {
              code: "TAG_LIMIT_EXCEEDED",
              message: "A pattern can have at most 20 tags",
            },
          },
          { status: 409 },
        ),
      );
      await pending;
    });

    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "每个图案最多可添加 20 个标签",
    );
  });

  it("creates a tag explicitly and associates it with the pattern", async () => {
    const created: TagItem = {
      ...tags[0]!,
      id: "00000000-0000-4000-8000-000000000003",
      name: "童装",
      normalizedName: "童装",
      colorToken: "yellow",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/tags" && init?.method === "POST") {
        return Response.json(created, { status: 201 });
      }
      if (
        url === `/api/patterns/${patternId}/tags/${created.id}` &&
        init?.method === "PUT"
      ) {
        return Response.json({
          patternId,
          tagId: created.id,
          isActive: true,
        });
      }
      if (url === "/api/tags" && !init?.method) {
        return Response.json([...tags, created]);
      }
      if (url === `/api/patterns/${patternId}/tags` && !init?.method) {
        return Response.json({ items: [{ tagId: created.id }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "创建标签" }));
    await user.type(screen.getByRole("textbox", { name: "标签名称" }), "童装");
    await user.click(screen.getByRole("radio", { name: "黄色" }));
    await user.click(screen.getByRole("button", { name: "保存并添加标签" }));

    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "童装" })).toBeChecked(),
    );
    const mutationCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST" || init?.method === "PUT",
    );
    expect(mutationCalls).toHaveLength(2);
    expect(
      JSON.parse(String(mutationCalls[0]?.[1]?.body)).operationId,
    ).toBeTruthy();
    expect(
      JSON.parse(String(mutationCalls[0]?.[1]?.body)).input.colorToken,
    ).toBe("yellow");
    expect(
      JSON.parse(String(mutationCalls[1]?.[1]?.body)).operationId,
    ).toBeTruthy();
  });

  it("retries only the association when tag creation has already succeeded", async () => {
    const created: TagItem = {
      ...tags[0]!,
      id: "00000000-0000-4000-8000-000000000004",
      name: "围巾",
      normalizedName: "围巾",
      colorToken: "red",
    };
    let associationAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/tags" && init?.method === "POST") {
        return Response.json(created, { status: 201 });
      }
      if (
        url === `/api/patterns/${patternId}/tags/${created.id}` &&
        init?.method === "PUT"
      ) {
        associationAttempts += 1;
        if (associationAttempts === 1) {
          return Response.json(
            { error: { code: "UNAVAILABLE", message: "unavailable" } },
            { status: 503 },
          );
        }
        return Response.json({ patternId, tagId: created.id, isActive: true });
      }
      if (url === "/api/tags" && !init?.method) {
        return Response.json([...tags, created]);
      }
      if (url === `/api/patterns/${patternId}/tags` && !init?.method) {
        return Response.json({
          items: associationAttempts >= 2 ? [{ tagId: created.id }] : [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "创建标签" }));
    await user.type(screen.getByRole("textbox", { name: "标签名称" }), "围巾");
    await user.click(screen.getByRole("button", { name: "保存并添加标签" }));

    expect(
      await screen.findByRole("button", { name: "重试添加标签" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "标签已创建，但尚未添加到图案",
    );
    await user.click(screen.getByRole("button", { name: "重试添加标签" }));

    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "围巾" })).toBeChecked(),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === "/api/tags" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    const associationCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith(`/tags/${created.id}`) && init?.method === "PUT",
    );
    expect(associationCalls).toHaveLength(2);
    expect(JSON.parse(String(associationCalls[0]![1]?.body)).operationId).toBe(
      JSON.parse(String(associationCalls[1]![1]?.body)).operationId,
    );
  });

  it("replays a response-lost create with the same operation id before associating", async () => {
    const created: TagItem = {
      ...tags[0]!,
      id: "00000000-0000-4000-8000-000000000006",
      name: "响应丢失",
      normalizedName: "响应丢失",
      colorToken: "purple",
    };
    let createAttempts = 0;
    let associated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/tags" && init?.method === "POST") {
        createAttempts += 1;
        if (createAttempts === 1) throw new TypeError("response lost");
        return Response.json(created, { status: 200 });
      }
      if (url === "/api/tags" && !init?.method) {
        return Response.json(
          createAttempts >= 1 ? [...tags, created] : tags,
        );
      }
      if (url === `/api/patterns/${patternId}/tags` && !init?.method) {
        return Response.json({
          items: associated ? [{ tagId: created.id }] : [],
        });
      }
      if (
        url === `/api/patterns/${patternId}/tags/${created.id}` &&
        init?.method === "PUT"
      ) {
        associated = true;
        return Response.json({ patternId, tagId: created.id, isActive: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "创建标签" }));
    await user.type(
      screen.getByRole("textbox", { name: "标签名称" }),
      "响应丢失",
    );
    await user.click(screen.getByRole("button", { name: "保存并添加标签" }));

    expect(
      await screen.findByRole("button", { name: "重试创建标签" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试创建标签" }));

    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "响应丢失" })).toBeChecked(),
    );
    const createCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === "/api/tags" && init?.method === "POST",
    );
    expect(createCalls).toHaveLength(2);
    expect(JSON.parse(String(createCalls[0]![1]?.body)).operationId).toBe(
      JSON.parse(String(createCalls[1]![1]?.body)).operationId,
    );
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(1);
  });

  it("explains a new tag that cannot be associated because the pattern is full", async () => {
    const created: TagItem = {
      ...tags[0]!,
      id: "00000000-0000-4000-8000-000000000005",
      name: "满额标签",
      normalizedName: "满额标签",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/tags" && init?.method === "POST") {
        return Response.json(created, { status: 201 });
      }
      if (init?.method === "PUT") {
        return Response.json(
          {
            error: {
              code: "TAG_LIMIT_EXCEEDED",
              message: "A pattern can have at most 20 tags",
            },
          },
          { status: 409 },
        );
      }
      if (String(input) === "/api/tags" && !init?.method) {
        return Response.json([...tags, created]);
      }
      if (
        String(input) === `/api/patterns/${patternId}/tags` &&
        !init?.method
      ) {
        return Response.json({ items: [] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "创建标签" }));
    await user.type(
      screen.getByRole("textbox", { name: "标签名称" }),
      "满额标签",
    );
    await user.click(screen.getByRole("button", { name: "保存并添加标签" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "每个图案最多可添加 20 个标签",
    );
    expect(
      screen.queryByRole("button", { name: "重试添加标签" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "满额标签" }))
      .not.toBeChecked();
  });

  it("offers fixed distinguishable color swatches as radios", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "创建标签" }));

    expect(
      screen.queryByRole("combobox", { name: "标签颜色" }),
    ).not.toBeInTheDocument();
    const colorGroup = screen.getByRole("radiogroup", { name: "标签颜色" });
    const colorNames = ["灰色", "蓝色", "绿色", "黄色", "红色", "紫色"];
    for (const colorName of colorNames) {
      const radio = within(colorGroup).getByRole("radio", { name: colorName });
      expect(radio.closest("label")?.querySelector(".tag-swatch")).toBeVisible();
    }
    expect(within(colorGroup).getByRole("radio", { name: "灰色" })).toBeChecked();
    await user.click(within(colorGroup).getByRole("radio", { name: "黄色" }));
    expect(within(colorGroup).getByRole("radio", { name: "黄色" })).toBeChecked();
  });
});
