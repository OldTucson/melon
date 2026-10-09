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
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseLibrarySearchParams,
  toPatternQuery,
} from "@/features/library/query-state";
import type { TagItem } from "@/features/library/library-types";
import { queryKeys } from "@/lib/query/keys";

import { TagPicker } from "./tag-picker";

const patternId = "00000000-0000-4000-8000-000000000010";
const tagA = "00000000-0000-4000-8000-000000000001";
const tagB = "00000000-0000-4000-8000-000000000002";
const query = toPatternQuery(parseLibrarySearchParams(new URLSearchParams()));
const tags: TagItem[] = [
  {
    id: tagA,
    ownerId: "10000000-0000-4000-8000-000000000000",
    name: "花卉",
    normalizedName: "花卉",
    colorToken: "green",
    changeSeq: "1",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  },
  {
    id: tagB,
    ownerId: "10000000-0000-4000-8000-000000000000",
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
  client.setQueryData(queryKeys.tags, tags);
  client.setQueryData(queryKeys.patternTags(patternId), {
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

function renderPicker(client = createClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <TagPicker patternId={patternId} activeQuery={query} />
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

  it("optimistically checks a tag and rolls back a readable 21st-tag error", async () => {
    let resolveRequest!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending));
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
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "创建标签" }));
    await user.type(screen.getByRole("textbox", { name: "标签名称" }), "童装");
    await user.selectOptions(screen.getByRole("combobox", { name: "标签颜色" }), "yellow");
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
});
