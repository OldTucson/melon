import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query/client";
import { QueryOwnerProvider } from "@/lib/query/provider";
import { composeInspirationDocument } from "@/features/inspiration-visuals/document-composer";
import {
  conceptAssetFixture,
  conceptSetFixture,
} from "@/features/inspiration-concepts/test-fixtures";
import type { ConceptSetDto } from "@/features/inspiration-concepts/contracts";
import { inspirationConceptKeys } from "@/features/inspiration-concepts/query-keys";
import { inspirationVisualKeys } from "@/features/inspiration-visuals/query-keys";
import { InspirationConceptController } from "./inspiration-concept-controller";
import { InspirationDocument } from "./inspiration-document";
import {
  inspirationDetailFixture,
  inspirationResultFixture,
} from "./test-fixtures";

const owner = "10000000-0000-4000-8000-000000000001";
const analysisId = inspirationDetailFixture.id;
const root = `/api/inspiration-analyses/${analysisId}/concept-sets`;
const queued: ConceptSetDto = {
  ...conceptSetFixture,
  status: "queued",
  slots: [
    {
      kind: "sketch",
      asset: null,
      task: { status: "queued", errorCode: null },
    },
    { kind: "effect", asset: null, task: null },
    { kind: "flat", asset: null, task: null },
  ],
};
const done: ConceptSetDto = {
  ...conceptSetFixture,
  status: "completed",
  completedAt: "2026-11-02T02:00:00.000Z",
  slots: [
    conceptSetFixture.slots[0],
    {
      kind: "effect",
      asset: {
        ...conceptAssetFixture,
        kind: "effect",
        id: "00000000-0000-4000-8000-000000000021",
        altText: "完成效果图",
      },
      task: null,
    },
    {
      kind: "flat",
      asset: {
        ...conceptAssetFixture,
        kind: "flat",
        id: "00000000-0000-4000-8000-000000000022",
        altText: "完成款式图",
        width: 2048,
        height: 1536,
      },
      task: null,
    },
  ],
};
let sets: ConceptSetDto[];
let requests: { url: string; init?: RequestInit }[];
let failDelete: boolean;
let failGet: boolean;
let postReply: (body: unknown) => Promise<Response>;
const clients: ReturnType<typeof createQueryClient>[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
function workspace(
  available = true,
  initialSets: ConceptSetDto[] = [],
  id = analysisId,
) {
  return (
    <InspirationConceptController
      analysisId={id}
      available={available}
      initialSets={initialSets}
    >
      {(concepts) => (
        <InspirationDocument
          document={composeInspirationDocument({
            result: inspirationResultFixture,
            sources: [],
            conceptSets: concepts.sets,
          })}
          title="研究"
          prompt="需求"
          conceptControls={concepts}
        />
      )}
    </InspirationConceptController>
  );
}
function mount(available = true, initialSets: ConceptSetDto[] = []) {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: { retry: false },
    mutations: { retry: false },
  });
  clients.push(client);
  const wrap = (ui: React.ReactNode) => (
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={owner}>{ui}</QueryOwnerProvider>
    </QueryClientProvider>
  );
  return {
    client,
    ...render(wrap(workspace(available, initialSets))),
    switchTo: (id: string) => wrap(workspace(available, initialSets, id)),
  };
}
beforeEach(() => {
  sets = [];
  requests = [];
  failDelete = false;
  failGet = false;
  postReply = async () => {
    sets = [queued];
    return json(queued, 201);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "POST")
        return postReply(JSON.parse(String(init.body)));
      if (init?.method === "DELETE") {
        if (failDelete)
          return json(
            {
              error: { code: "UNAVAILABLE", message: "PRIVATE provider error" },
            },
            503,
          );
        sets = [];
        return new Response(null, { status: 204 });
      }
      if (failGet)
        return json(
          { error: { code: "UNAVAILABLE", message: "PRIVATE provider error" } },
          503,
        );
      return json(sets);
    }),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("analysis concept orchestration with real report components", () => {
  it("creates once, inserts into owned cache, invalidates visuals and keeps the report visible", async () => {
    const user = userEvent.setup();
    const { client } = mount();
    await waitFor(() => expect(requests).toHaveLength(1));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await user.click(
      screen.getAllByRole("button", { name: "生成整套成图" })[0]!,
    );
    const submit = within(screen.getByRole("dialog")).getByRole("button", {
      name: "生成整套成图",
    });
    await user.dblClick(submit);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("排队中")).toBeVisible();
    expect(screen.getByText(inspirationResultFixture.summary)).toBeVisible();
    expect(requests.filter(({ init }) => init?.method === "POST")).toHaveLength(
      1,
    );
    expect(
      JSON.parse(
        String(
          requests.find(({ init }) => init?.method === "POST")!.init!.body,
        ),
      ),
    ).toMatchObject({
      directionIndex: 0,
      visualJobId: null,
      referenceAssetIds: [],
    });
    expect(
      client.getQueryData(inspirationConceptKeys.analysis(owner, analysisId)),
    ).toEqual([queued]);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: inspirationVisualKeys.detail(owner, analysisId),
    });
    expect(
      within(screen.getByRole("region", { name: "柔和通勤" })).getByRole(
        "button",
        { name: "生成整套成图" },
      ),
    ).toBeDisabled();
    expect(screen.queryByText("正在分析…")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "柔和通勤" })).getByRole(
          "tab",
          { name: "方案 01" },
        ),
      ).toHaveFocus(),
    );
  });

  it("polls one analysis query through sketch and derivatives, then stops for terminal sets", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    sets = [queued];
    const { client } = mount();
    await screen.findByText("排队中");
    sets = [
      {
        ...conceptSetFixture,
        status: "generating",
        slots: [
          conceptSetFixture.slots[0],
          {
            kind: "effect",
            asset: null,
            task: { status: "generating", errorCode: null },
          },
          {
            kind: "flat",
            asset: null,
            task: { status: "queued", errorCode: null },
          },
        ],
      },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await screen.findByRole("img", { name: conceptAssetFixture.altText });
    expect(screen.getByText("生成中")).toBeVisible();
    sets = [done];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await screen.findByRole("img", { name: "完成款式图" });
    expect(screen.getAllByText("AI 生成")).toHaveLength(3);
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(requests).toHaveLength(count);
    expect(
      client
        .getQueryCache()
        .findAll({ queryKey: inspirationConceptKeys.all(owner) }),
    ).toHaveLength(1);
  });

  it("loads persisted history with paid actions off and disables new creation at three versions", async () => {
    sets = [done];
    const { rerender, switchTo } = mount(false, [done]);
    expect(screen.getByRole("img", { name: "完成款式图" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "生成整套成图" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(requests).toHaveLength(1));
    rerender(switchTo("00000000-0000-4000-8000-000000000099"));
    await waitFor(() =>
      expect(requests.some(({ url }) => url.includes("000000000099"))).toBe(
        true,
      ),
    );
  });

  it("keeps errors local and safe, retries a derivative, and rolls back failed deletion", async () => {
    sets = [conceptSetFixture];
    const user = userEvent.setup();
    const { client } = mount();
    await screen.findByRole("button", { name: "重试服装效果图" });
    postReply = async () =>
      json(
        { error: { code: "UNAVAILABLE", message: "PRIVATE provider error" } },
        503,
      );
    await user.click(screen.getByRole("button", { name: "重试服装效果图" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "成图操作失败，请重试",
    );
    expect(document.body.innerHTML).not.toContain("PRIVATE provider");
    expect(screen.getByRole("img")).toBeVisible();
    failDelete = true;
    await user.click(screen.getByRole("button", { name: "方案操作" }));
    await user.click(screen.getByRole("menuitem", { name: "删除方案" }));
    await waitFor(() => expect(screen.getByRole("img")).toBeVisible());
    expect(
      client.getQueryData(inspirationConceptKeys.analysis(owner, analysisId)),
    ).toEqual([conceptSetFixture]);
    failDelete = false;
    await user.click(screen.getByRole("button", { name: "方案操作" }));
    await user.dblClick(screen.getByRole("menuitem", { name: "删除方案" }));
    await waitFor(() =>
      expect(screen.queryByRole("tab")).not.toBeInTheDocument(),
    );
    expect(
      client.getQueryData(inspirationConceptKeys.analysis(owner, analysisId)),
    ).toEqual([]);
    expect(
      requests.filter(({ init }) => init?.method === "DELETE"),
    ).toHaveLength(2); // One failed request, then one successful request.
  });

  it("cancels an old report's in-flight query when switching reports", async () => {
    let oldSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input === root) {
          oldSignal = init?.signal as AbortSignal;
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(json([]));
      }),
    );
    const { rerender, switchTo } = mount();
    await waitFor(() => expect(oldSignal).toBeDefined());
    rerender(switchTo("00000000-0000-4000-8000-000000000099"));
    await waitFor(() => expect(oldSignal!.aborted).toBe(true));
    expect(screen.getByText(inspirationResultFixture.summary)).toBeVisible();
  });

  it("disables creation after three retained versions and selects a newly regenerated version", async () => {
    sets = [done];
    const user = userEvent.setup();
    const { client } = mount();
    await screen.findByRole("img", { name: "完成款式图" });
    const next: ConceptSetDto = {
      ...queued,
      id: "00000000-0000-4000-8000-000000000032",
      version: 2,
    };
    postReply = async () => {
      sets = [next, done];
      return json(next);
    };
    await user.click(screen.getByRole("button", { name: "方案操作" }));
    await user.click(
      screen.getByRole("menuitem", { name: "重新生成草图（新方案）" }),
    );
    await user.click(screen.getByRole("button", { name: "确认生成新方案" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "方案 02" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(requests.find(({ init }) => init?.method === "POST")!.url).toBe(
      `${root}/${done.id}/regenerate`,
    );
    await user.click(screen.getByRole("tab", { name: "方案 01" }));
    expect(screen.getByRole("img", { name: "完成款式图" })).toBeVisible();
    sets = [
      done,
      {
        ...next,
        status: "failed",
        slots: [
          {
            kind: "sketch",
            asset: null,
            task: {
              status: "failed",
              errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
            },
          },
          next.slots[1],
          next.slots[2],
        ],
      },
      {
        ...next,
        id: "00000000-0000-4000-8000-000000000033",
        version: 3,
        status: "failed",
        slots: [
          {
            kind: "sketch",
            asset: null,
            task: {
              status: "failed",
              errorCode: "INSPIRATION_CONCEPT_TIMEOUT",
            },
          },
          next.slots[1],
          next.slots[2],
        ],
      },
    ];
    await act(() =>
      client.invalidateQueries({
        queryKey: inspirationConceptKeys.analysis(owner, analysisId),
      }),
    );
    const direction = screen.getByRole("region", { name: "柔和通勤" });
    expect(
      within(direction).getByRole("button", { name: "生成整套成图" }),
    ).toBeDisabled();
    expect(
      await within(direction).findByText("已保留 3 个方案，请先删除一个"),
    ).toBeVisible();
  });

  it("retries a derivative through its own endpoint and keeps successful siblings", async () => {
    sets = [conceptSetFixture];
    const user = userEvent.setup();
    const { client } = mount();
    await screen.findByRole("button", { name: "重试服装效果图" });
    const retrying: ConceptSetDto = {
      ...conceptSetFixture,
      status: "generating",
      slots: [
        conceptSetFixture.slots[0],
        {
          kind: "effect",
          asset: null,
          task: { status: "generating", errorCode: null },
        },
        conceptSetFixture.slots[2],
      ],
    };
    postReply = async () => {
      sets = [retrying];
      return json(retrying);
    };
    await user.click(screen.getByRole("button", { name: "重试服装效果图" }));
    await screen.findByText("生成中");
    expect(
      screen.getByRole("img", { name: conceptAssetFixture.altText }),
    ).toBeVisible();
    expect(requests.find(({ init }) => init?.method === "POST")!.url).toBe(
      `${root}/${conceptSetFixture.id}/outputs/effect/retry`,
    );
    expect(
      client.getQueryData(inspirationConceptKeys.analysis(owner, analysisId)),
    ).toEqual([retrying]);
  });

  it("keeps a failed create local to the open drawer with references preserved for retry", async () => {
    postReply = async () =>
      json(
        { error: { code: "UNAVAILABLE", message: "PRIVATE provider error" } },
        503,
      );
    const user = userEvent.setup();
    mount();
    await user.click(
      screen.getAllByRole("button", { name: "生成整套成图" })[0]!,
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "生成整套成图",
      }),
    );
    const drawer = screen.getByRole("dialog");
    expect(await within(drawer).findByRole("alert")).toHaveTextContent(
      "成图操作失败，请重试",
    );
    expect(within(drawer).getByText("已选 0 / 3")).toBeVisible();
    expect(document.body.innerHTML).not.toContain("PRIVATE provider");
  });

  it("recovers a local list failure without hiding the report or persisted output", async () => {
    sets = [done];
    failGet = true;
    const user = userEvent.setup();
    mount(true, [done]);
    expect(await screen.findByRole("alert")).toHaveTextContent("成图加载失败");
    expect(screen.getByRole("img", { name: "完成款式图" })).toBeVisible();
    failGet = false;
    await user.click(screen.getByRole("button", { name: "重新加载成图" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(inspirationResultFixture.summary)).toBeVisible();
  });
});
