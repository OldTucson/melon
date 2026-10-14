import {
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseLibrarySearchParams,
  toPatternQuery,
} from "@/features/library/query-state";
import { queryKeys } from "@/lib/query/keys";
import { QueryOwnerProvider } from "@/lib/query/provider";

import type { PatternItem, PatternPage } from "./library-types";
import { usePatternBatchMutation } from "./pattern-batch-mutations";
import { usePatternPatchMutation } from "./pattern-mutations";
import { useSelectionStore } from "./selection-store";

const ownerId = "10000000-0000-4000-8000-000000000000";
const folderId = "20000000-0000-4000-8000-000000000000";
const alternateFolderId = "30000000-0000-4000-8000-000000000000";
const query = toPatternQuery(parseLibrarySearchParams(new URLSearchParams()));
const favoriteQuery = { ...query, favorite: true };
const responseTimestamp = "2026-10-08T01:00:00.000Z";

type PatternBatchRequest =
  | {
      action: "move";
      folderId: string | null;
      operationId: string;
      patterns: Array<{ id: string; version: number }>;
    }
  | {
      action: "favorite";
      isFavorite: boolean;
      operationId: string;
      patterns: Array<{ id: string; version: number }>;
    }
  | {
      action: "trash";
      operationId: string;
      patterns: Array<{ id: string; version: number }>;
    };

const pattern = (index: number): PatternItem => ({
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
});

function validBatchPatterns(
  items: PatternItem[],
  intent: PatternBatchRequest,
  options: { moveNoOp?: boolean } = {},
): PatternItem[] {
  const versions = new Map(
    intent.patterns.map((item) => [item.id, item.version] as const),
  );
  return items.map((item) => {
    const inputVersion = versions.get(item.id)!;
    if (intent.action === "trash") {
      return {
        ...item,
        status: "trashed",
        preTrashStatus: item.status === "failed" ? "failed" : "ready",
        trashBatchId: intent.operationId,
        trashedAt: responseTimestamp,
        deletedAt: null,
        version: inputVersion + 1,
      };
    }
    return {
      ...item,
      status: item.status === "failed" ? "failed" : "ready",
      folderId: intent.action === "move" ? intent.folderId : item.folderId,
      isFavorite:
        intent.action === "favorite" ? intent.isFavorite : item.isFavorite,
      preTrashStatus: null,
      trashBatchId: null,
      trashedAt: null,
      deletedAt: null,
      version:
        intent.action === "move" && options.moveNoOp
          ? inputVersion
          : inputVersion + 1,
    };
  });
}

type BatchButton = "Favorite" | "Move" | "Trash";

type InvalidStateCase = {
  button: BatchButton;
  name: string;
  mutate: (
    patterns: PatternItem[],
    intent: PatternBatchRequest,
  ) => PatternItem[];
};

function changeFirst(
  patterns: PatternItem[],
  patch: Partial<PatternItem>,
): PatternItem[] {
  return patterns.map((item, index) =>
    index === 0 ? { ...item, ...patch } : item,
  );
}

const invalidStateCases: InvalidStateCase[] = [
  {
    button: "Favorite",
    name: "favorite deleted status",
    mutate: (patterns) => changeFirst(patterns, { status: "deleted" }),
  },
  {
    button: "Favorite",
    name: "favorite pre-trash status",
    mutate: (patterns) => changeFirst(patterns, { preTrashStatus: "ready" }),
  },
  {
    button: "Favorite",
    name: "favorite trash batch",
    mutate: (patterns) => changeFirst(patterns, { trashBatchId: folderId }),
  },
  {
    button: "Favorite",
    name: "favorite trashed timestamp",
    mutate: (patterns) => changeFirst(patterns, { trashedAt: responseTimestamp }),
  },
  {
    button: "Favorite",
    name: "favorite deleted timestamp",
    mutate: (patterns) => changeFirst(patterns, { deletedAt: responseTimestamp }),
  },
  {
    button: "Move",
    name: "move trashed status",
    mutate: (patterns) => changeFirst(patterns, { status: "trashed" }),
  },
  {
    button: "Move",
    name: "move deleting status",
    mutate: (patterns) => changeFirst(patterns, { status: "deleting" }),
  },
  {
    button: "Move",
    name: "move deleted timestamp",
    mutate: (patterns) => changeFirst(patterns, { deletedAt: responseTimestamp }),
  },
  {
    button: "Trash",
    name: "trash missing pre-trash status",
    mutate: (patterns) => changeFirst(patterns, { preTrashStatus: null }),
  },
  {
    button: "Trash",
    name: "trash missing trashed timestamp",
    mutate: (patterns) => changeFirst(patterns, { trashedAt: null }),
  },
  {
    button: "Trash",
    name: "trash deleted timestamp",
    mutate: (patterns) => changeFirst(patterns, { deletedAt: responseTimestamp }),
  },
  {
    button: "Favorite",
    name: "favorite version does not advance",
    mutate: (patterns, intent) =>
      changeFirst(patterns, { version: intent.patterns[0]!.version }),
  },
  {
    button: "Favorite",
    name: "favorite version jumps",
    mutate: (patterns, intent) =>
      changeFirst(patterns, { version: intent.patterns[0]!.version + 2 }),
  },
  {
    button: "Trash",
    name: "trash version does not advance",
    mutate: (patterns, intent) =>
      changeFirst(patterns, { version: intent.patterns[0]!.version }),
  },
  {
    button: "Trash",
    name: "trash version jumps",
    mutate: (patterns, intent) =>
      changeFirst(patterns, { version: intent.patterns[0]!.version + 2 }),
  },
  {
    button: "Move",
    name: "move version regresses",
    mutate: (patterns, intent) =>
      changeFirst(patterns, {
        version: Math.max(0, intent.patterns[0]!.version - 1),
      }),
  },
  {
    button: "Move",
    name: "move version jumps",
    mutate: (patterns, intent) =>
      changeFirst(patterns, { version: intent.patterns[0]!.version + 2 }),
  },
];

function page(items: PatternItem[]): InfiniteData<PatternPage, string | null> {
  return { pages: [{ items, nextCursor: null }], pageParams: [null] };
}

function clientWith(items: PatternItem[]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(queryKeys.patterns(ownerId, query), page(items));
  client.setQueryData(queryKeys.patterns(ownerId, favoriteQuery), page(items));
  for (const item of items) {
    client.setQueryData(queryKeys.pattern(ownerId, item.id), item);
  }
  return client;
}

function Harness({ items }: { items: PatternItem[] }) {
  const mutation = usePatternBatchMutation(query);
  return (
    <>
      {mutation.error ? <div role="alert">Mutation failed</div> : null}
      <button
        type="button"
        onClick={() =>
          mutation.mutateBatch({ action: "favorite", isFavorite: true, patterns: items })
        }
      >
        Favorite
      </button>
      <button
        type="button"
        onClick={() =>
          mutation.mutateBatch({ action: "favorite", isFavorite: false, patterns: items })
        }
      >
        Unfavorite
      </button>
      <button
        type="button"
        onClick={() => mutation.mutateBatch({ action: "move", folderId, patterns: items })}
      >
        Move
      </button>
      <button
        type="button"
        onClick={() => mutation.mutateBatch({ action: "trash", patterns: items })}
      >
        Trash
      </button>
    </>
  );
}

function renderHarness(client: QueryClient, items: PatternItem[]) {
  return render(
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={ownerId}>
        <Harness items={items} />
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
}

describe("pattern batch mutation", () => {
  it.each([
    ["patch", false],
    ["batch", false],
    ["patch", true],
    ["batch", true],
  ] as const)(
    "queues overlapping writes after %s and awaits authoritative refresh (failure=%s)",
    async (firstKind, fails) => {
      const item = pattern(1);
      const client = clientWith([item]);
      let finishFirst!: (response: Response) => void;
      let releaseRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const authority = { ...item, name: "服务器名称", version: 9 };
      const refresh = vi.fn(async () => {
        await refreshGate;
        return page([authority]);
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((url, init) => {
          if (vi.mocked(fetch).mock.calls.length === 1)
            return new Promise<Response>((resolve) => {
              finishFirst = resolve;
            });
          const body = JSON.parse(String(init?.body));
          return Promise.resolve(
            Response.json(
              url === "/api/patterns/batch"
                ? { patterns: validBatchPatterns([authority], body) }
                : {
                    ...authority,
                    ...body.patch,
                    version: body.patch.version + 1,
                  },
            ),
          );
        }),
      );
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>
          <QueryOwnerProvider ownerId={ownerId}>{children}</QueryOwnerProvider>
        </QueryClientProvider>
      );
      const { result } = renderHook(
        () => {
          useQuery({
            queryKey: queryKeys.patterns(ownerId, query),
            queryFn: refresh,
          });
          return {
            patch: usePatternPatchMutation(query),
            batch: usePatternBatchMutation(query),
          };
        },
        { wrapper },
      );
      const patch = () =>
        result.current.patch.mutatePatternAsync({
          patternId: item.id,
          patch: { version: item.version, name: "用户改名" },
        });
      const batch = () =>
        result.current.batch.mutateBatchAsync({
          action: "move",
          folderId,
          patterns: [item],
        });
      let first!: Promise<unknown>, second!: Promise<unknown>;
      act(() => {
        first = (firstKind === "patch" ? patch() : batch()).catch(
          () => undefined,
        );
      });
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      act(() => {
        second = firstKind === "patch" ? batch() : patch();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        firstKind === "patch"
          ? result.current.batch.isPending
          : result.current.patch.isPending,
      ).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const queuedCache = client.getQueryData<PatternItem>(
        queryKeys.pattern(ownerId, item.id),
      )!;
      if (firstKind === "patch") expect(queuedCache.folderId).toBeNull();
      else expect(queuedCache.name).toBe(item.name);
      await act(async () => {
        const body = JSON.parse(
          String(vi.mocked(fetch).mock.calls[0]![1]?.body),
        );
        finishFirst(
          fails
            ? Response.json(
                { error: { code: "PATTERN_STATE_CHANGED" } },
                { status: 409 },
              )
            : Response.json(
                firstKind === "patch"
                  ? { ...item, name: "用户改名", version: 2 }
                  : { patterns: validBatchPatterns([item], body) },
              ),
        );
      });
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      expect(fetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        releaseRefresh();
        await first;
        await second;
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]?.body));
      if (firstKind === "patch")
        expect(body.patterns).toEqual([{ id: item.id, version: 9 }]);
      else expect(body.patch.version).toBe(9);
    },
  );

  it("allows writes for disjoint patterns to run concurrently", async () => {
    const items = [pattern(1), pattern(2)];
    const client = clientWith(items);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <QueryOwnerProvider ownerId={ownerId}>{children}</QueryOwnerProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        patch: usePatternPatchMutation(query),
        batch: usePatternBatchMutation(query),
      }),
      { wrapper },
    );
    act(() => {
      void result.current.batch.mutateBatchAsync({
        action: "move",
        folderId,
        patterns: [items[0]!],
      });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => {
      void result.current.patch.mutatePatternAsync({
        patternId: items[1]!.id,
        patch: { version: items[1]!.version, name: "独立改名" },
      });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
  beforeEach(() => useSelectionStore.getState().clear());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reuses its operation ID on retry and sends current IDs and versions", async () => {
    const items = [pattern(1), pattern(2)];
    const client = clientWith(items);
    client.setQueryData(queryKeys.pattern(ownerId, items[0]!.id), {
      ...items[0]!,
      version: 9,
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network down");
      const intent = JSON.parse(String(init?.body)) as PatternBatchRequest;
      return Response.json({
        patterns: validBatchPatterns(items, intent),
      });
    }));
    useSelectionStore.getState().selectAll(items.map((item) => item.id));
    renderHarness(client, items);

    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const bodies = vi.mocked(fetch).mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies[0].operationId).toBe(bodies[1].operationId);
    expect(bodies[0].patterns).toEqual([
      { id: items[0]!.id, version: 9 },
      { id: items[1]!.id, version: items[1]!.version },
    ]);
    await waitFor(() => expect(useSelectionStore.getState().selectedIds).toEqual([]));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["owner", ownerId, "patterns"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.folders(ownerId), exact: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.trash(ownerId), exact: true });
    for (const item of items) {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.pattern(ownerId, item.id),
        exact: true,
      });
    }
  });

  it("preserves the commercial summary when a batch response omits it", async () => {
    const commercialSummary = {
      state: "field_exclusive" as const,
      activeCount: 2,
      revenueFen: "128000",
    };
    const item = { ...pattern(1), commercialSummary };
    const client = clientWith([item]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const intent = JSON.parse(String(init?.body)) as PatternBatchRequest;
        const [serverPattern] = validBatchPatterns([item], intent);
        const responsePattern = { ...serverPattern! };
        delete responsePattern.commercialSummary;
        return Response.json({ patterns: [responsePattern] });
      }),
    );
    useSelectionStore.getState().selectAll([item.id]);
    renderHarness(client, [item]);

    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    await waitFor(() =>
      expect(useSelectionStore.getState().selectedIds).toEqual([]),
    );
    expect(
      client.getQueryData<PatternItem>(queryKeys.pattern(ownerId, item.id))
        ?.commercialSummary,
    ).toEqual(commercialSummary);
    expect(
      client.getQueryData<InfiniteData<PatternPage>>(
        queryKeys.patterns(ownerId, query),
      )?.pages[0]?.items[0]?.commercialSummary,
    ).toEqual(commercialSummary);
  });

  it("keeps trashed rows until success and clears only the requested IDs", async () => {
    const items = [pattern(1), pattern(2), pattern(3)];
    const client = clientWith(items);
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    useSelectionStore.getState().selectAll(items.map((item) => item.id));
    renderHarness(client, items.slice(0, 2));

    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(client.getQueryData<InfiniteData<PatternPage>>(queryKeys.patterns(ownerId, query))
      ?.pages[0]?.items.map((item) => item.id)).toEqual(items.map((item) => item.id));

    await act(async () => {
      const intent = JSON.parse(
        String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
      ) as PatternBatchRequest;
      resolve(Response.json({
        patterns: validBatchPatterns(items.slice(0, 2), intent),
      }));
    });

    await waitFor(() => {
      expect(client.getQueryData<InfiniteData<PatternPage>>(queryKeys.patterns(ownerId, query))
        ?.pages[0]?.items.map((item) => item.id)).toEqual([items[2]!.id]);
      expect(useSelectionStore.getState().selectedIds).toEqual([items[2]!.id]);
    });
  });

  it.each([
    ["malformed", () => ({ patterns: "invalid" })],
    ["missing fields", (valid: PatternItem[]) => {
      const missing = { ...valid[0] } as Partial<PatternItem>;
      delete missing.name;
      return { patterns: [missing, valid[1]] };
    }],
    ["empty", () => ({ patterns: [] })],
    ["partial", (valid: PatternItem[]) => ({ patterns: [valid[0]] })],
    ["duplicate", (valid: PatternItem[]) => ({ patterns: [valid[0], valid[0]] })],
    ["wrong ID", (valid: PatternItem[]) => ({
      patterns: [valid[0], { ...valid[1], id: pattern(99).id }],
    })],
    ["extra ID", (valid: PatternItem[]) => ({
      patterns: [...valid, { ...pattern(99), isFavorite: true }],
    })],
    ["unexpected fields", (valid: PatternItem[]) => ({
      patterns: valid,
      unexpected: true,
    })],
  ] as const)("rejects a %s batch success response without clearing selection", async (_name, makeResponse) => {
    const items = [pattern(1), pattern(2)];
    const valid = items.map((item) => ({
      ...item,
      isFavorite: true,
      version: item.version + 1,
    }));
    const client = clientWith(items);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(makeResponse(valid))));
    useSelectionStore.getState().selectAll(items.map((item) => item.id));
    renderHarness(client, items);

    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Mutation failed");
    expect(fetch).toHaveBeenCalledTimes(2);
    const requestBodies = vi.mocked(fetch).mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as { operationId: string },
    );
    expect(requestBodies[0]!.operationId).toBe(requestBodies[1]!.operationId);
    expect(useSelectionStore.getState().selectedIds).toEqual(
      items.map((item) => item.id),
    );
    for (const item of items) {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.pattern(ownerId, item.id),
        exact: true,
      });
    }
  });

  it.each([
    { action: "favorite", button: "Favorite" },
    { action: "move", button: "Move" },
    { action: "trash", button: "Trash" },
  ])("rejects a $action response whose action result does not match", async ({ button }) => {
    const items = [pattern(1), pattern(2)];
    const client = clientWith(items);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      patterns: items.map((item) => ({ ...item, version: item.version + 1 })),
    })));
    useSelectionStore.getState().selectAll(items.map((item) => item.id));
    renderHarness(client, items);

    fireEvent.click(screen.getByRole("button", { name: button }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Mutation failed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useSelectionStore.getState().selectedIds).toEqual(
      items.map((item) => item.id),
    );
  });

  it.each(invalidStateCases)(
    "rejects $name without changing caches or selection",
    async ({ button, mutate }) => {
      const items = [pattern(1), pattern(2)];
      const client = clientWith(items);
      const invalidate = vi.spyOn(client, "invalidateQueries");
      vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
        const intent = JSON.parse(String(init?.body)) as PatternBatchRequest;
        return Response.json({
          patterns: mutate(validBatchPatterns(items, intent), intent),
        });
      }));
      useSelectionStore.getState().selectAll(items.map((item) => item.id));
      renderHarness(client, items);

      fireEvent.click(screen.getByRole("button", { name: button }));

      expect(
        await screen.findByRole("alert", {}, { timeout: 500 }),
      ).toHaveTextContent("Mutation failed");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(useSelectionStore.getState().selectedIds).toEqual(
        items.map((item) => item.id),
      );
      expect(
        items.map((item) =>
          client.getQueryData(queryKeys.pattern(ownerId, item.id)),
        ),
      ).toEqual(items);
      expect(
        client
          .getQueryData<InfiniteData<PatternPage>>(queryKeys.patterns(ownerId, query))
          ?.pages[0]?.items,
      ).toEqual(items);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["owner", ownerId, "patterns"],
      });
    },
  );

  it.each([
    {
      name: "unfiled pattern that reports a no-op version",
      responseVersionDelta: 0,
      sourceFolderId: null,
    },
    {
      name: "pattern from another folder that reports a no-op version",
      responseVersionDelta: 0,
      sourceFolderId: alternateFolderId,
    },
    {
      name: "same-folder no-op that reports an advanced version",
      responseVersionDelta: 1,
      sourceFolderId: folderId,
    },
  ])("rejects a move response for $name", async ({
    responseVersionDelta,
    sourceFolderId,
  }) => {
    const item = { ...pattern(1), folderId: sourceFolderId };
    const client = clientWith([item]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        operationId: string;
        patterns: Array<{ id: string; version: number }>;
      };
      return Response.json({
        patterns: [{
          ...item,
          folderId,
          version: request.patterns[0]!.version + responseVersionDelta,
        }],
      });
    }));
    useSelectionStore.getState().selectAll([item.id]);
    renderHarness(client, [item]);

    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Mutation failed",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useSelectionStore.getState().selectedIds).toEqual([item.id]);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["owner", ownerId, "patterns"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.pattern(ownerId, item.id),
      exact: true,
    });
  });

  it("accepts mixed move results with a per-pattern no-op and change version", async () => {
    const items = [
      { ...pattern(1), folderId },
      { ...pattern(2), folderId: null },
    ];
    const client = clientWith(items);
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        patterns: Array<{ id: string; version: number }>;
      };
      const versions = new Map(
        request.patterns.map((item) => [item.id, item.version] as const),
      );
      return Response.json({
        patterns: items.map((item) => ({
          ...item,
          folderId,
          version:
            versions.get(item.id)! + (item.folderId === folderId ? 0 : 1),
        })),
      });
    }));
    useSelectionStore.getState().selectAll(items.map((item) => item.id));
    renderHarness(client, items);

    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(useSelectionStore.getState().selectedIds).toEqual([]),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { wrongIndex: 0, name: "no-op row advances" },
    { wrongIndex: 1, name: "changed row does not advance" },
  ])("rejects a mixed move result when its $name", async ({ wrongIndex }) => {
    const items = [
      { ...pattern(1), folderId },
      { ...pattern(2), folderId: null },
    ];
    const client = clientWith(items);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        patterns: Array<{ id: string; version: number }>;
      };
      const versions = new Map(
        request.patterns.map((item) => [item.id, item.version] as const),
      );
      return Response.json({
        patterns: items.map((item, index) => ({
          ...item,
          folderId,
          version:
            versions.get(item.id)! +
            (index === wrongIndex
              ? item.folderId === folderId
                ? 1
                : 0
              : item.folderId === folderId
                ? 0
                : 1),
        })),
      });
    }));
    useSelectionStore.getState().selectAll(items.map((item) => item.id));
    renderHarness(client, items);

    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Mutation failed",
    );
    expect(useSelectionStore.getState().selectedIds).toEqual(
      items.map((item) => item.id),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["owner", ownerId, "patterns"],
    });
  });

  it.each([
    {
      activeFolderId: alternateFolderId,
      activeVersion: 7,
      detailFolderId: folderId,
      detailVersion: 7,
      name: "detail cache when versions tie",
    },
    {
      activeFolderId: folderId,
      activeVersion: 8,
      detailFolderId: alternateFolderId,
      detailVersion: 7,
      name: "active list when its version is newer",
    },
  ])("uses the $name for move source metadata", async ({
    activeFolderId,
    activeVersion,
    detailFolderId,
    detailVersion,
  }) => {
    const input = pattern(1);
    const active = {
      ...input,
      folderId: activeFolderId,
      version: activeVersion,
    };
    const detail = {
      ...input,
      folderId: detailFolderId,
      version: detailVersion,
    };
    const expected = activeVersion > detailVersion ? active : detail;
    const client = clientWith([input]);
    client.setQueryData(queryKeys.patterns(ownerId, query), page([active]));
    client.setQueryData(queryKeys.pattern(ownerId, input.id), detail);
    let requestBody: {
      patterns: Array<Record<string, unknown>>;
    } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return Response.json({
        patterns: [{ ...expected, folderId, version: expected.version }],
      });
    }));
    useSelectionStore.getState().selectAll([input.id]);
    renderHarness(client, [input]);

    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(useSelectionStore.getState().selectedIds).toEqual([]),
    );
    expect(requestBody?.patterns).toEqual([
      { id: input.id, version: expected.version },
    ]);
    expect(requestBody?.patterns[0]).not.toHaveProperty("sourceFolderId");
    expect(requestBody?.patterns[0]).not.toHaveProperty("currentFolderId");
  });

  it.each([
    {
      button: "Move" as const,
      items: [
        { ...pattern(1), folderId },
        { ...pattern(2), folderId },
      ],
      moveNoOp: true,
      name: "move no-op keeps the input version",
    },
    {
      button: "Move" as const,
      items: [pattern(1), pattern(2)],
      moveNoOp: false,
      name: "move change advances by one version",
    },
    {
      button: "Favorite" as const,
      items: [pattern(1), pattern(2)],
      moveNoOp: false,
      name: "favorite advances by one version",
    },
    {
      button: "Trash" as const,
      items: [pattern(1), pattern(2)],
      moveNoOp: false,
      name: "trash advances by one version",
    },
  ])("accepts a valid $name response", async ({ button, items, moveNoOp }) => {
    const client = clientWith(items);
    let responsePatterns: PatternItem[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const intent = JSON.parse(String(init?.body)) as PatternBatchRequest;
      responsePatterns = validBatchPatterns(items, intent, { moveNoOp });
      return Response.json({ patterns: responsePatterns });
    }));
    useSelectionStore.getState().selectAll(items.map((item) => item.id));
    renderHarness(client, items);

    fireEvent.click(screen.getByRole("button", { name: button }));

    await waitFor(() =>
      expect(useSelectionStore.getState().selectedIds).toEqual([]),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      items.map((item) =>
        client.getQueryData(queryKeys.pattern(ownerId, item.id)),
      ),
    ).toEqual(responsePatterns);
  });

  it("keeps filtered rows selected until an optimistic favorite request succeeds", async () => {
    const item = { ...pattern(1), isFavorite: true };
    const client = clientWith([item]);
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    useSelectionStore.getState().selectAll([item.id]);
    renderHarness(client, [item]);

    fireEvent.click(screen.getByRole("button", { name: "Unfavorite" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    expect(
      client
        .getQueryData<InfiniteData<PatternPage>>(queryKeys.patterns(ownerId, favoriteQuery))
        ?.pages[0]?.items,
    ).toEqual([expect.objectContaining({ id: item.id, isFavorite: false })]);
    expect(useSelectionStore.getState().selectedIds).toEqual([item.id]);

    await act(async () => {
      resolve(Response.json({
        patterns: [{ ...item, isFavorite: false, version: item.version + 1 }],
      }));
    });
    await waitFor(() => expect(useSelectionStore.getState().selectedIds).toEqual([]));
  });

  it.each([
    { action: "favorite" as const, button: "Favorite" },
    { action: "move" as const, button: "Move" },
  ])("fully restores every matching cache snapshot when $action fails", async ({ button }) => {
    const items = [pattern(1), pattern(2)];
    const client = clientWith(items);
    const beforeAll = client.getQueryData(queryKeys.patterns(ownerId, query));
    const beforeFavorite = client.getQueryData(queryKeys.patterns(ownerId, favoriteQuery));
    const beforeDetails = items.map((item) =>
      client.getQueryData(queryKeys.pattern(ownerId, item.id)),
    );
    let reject!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { reject = done; })));
    renderHarness(client, items);

    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => {
      expect(client.getQueryData(queryKeys.patterns(ownerId, query))).not.toEqual(beforeAll);
    });
    await act(async () => {
      reject(Response.json({ error: { code: "PATTERN_STATE_CHANGED", message: "changed" } }, { status: 409 }));
    });

    await waitFor(() => {
      expect(client.getQueryData(queryKeys.patterns(ownerId, query))).toEqual(beforeAll);
      expect(client.getQueryData(queryKeys.patterns(ownerId, favoriteQuery))).toEqual(beforeFavorite);
      expect(
        items.map((item) =>
          client.getQueryData(queryKeys.pattern(ownerId, item.id)),
        ),
      ).toEqual(beforeDetails);
    });
  });

  it("preserves concurrent higher-version writes while rolling back and invalidating a failed batch", async () => {
    const items = [pattern(1), pattern(2)];
    const client = clientWith(items);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    let reject!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { reject = done; })));
    renderHarness(client, items);

    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    const concurrent = {
      ...items[0]!,
      name: "Concurrent rename",
      isFavorite: true,
      version: 20,
      commercialVersion: 4,
      changeSeq: "20",
    };
    client.setQueryData(queryKeys.pattern(ownerId, concurrent.id), concurrent);
    client.setQueryData<InfiniteData<PatternPage, string | null>>(
      queryKeys.patterns(ownerId, query),
      page([concurrent, { ...items[1]!, isFavorite: true }]),
    );

    await act(async () => {
      reject(Response.json(
        { error: { code: "PATTERN_STATE_CHANGED", message: "changed" } },
        { status: 409 },
      ));
    });

    await waitFor(() => {
      expect(client.getQueryData(queryKeys.pattern(ownerId, concurrent.id)))
        .toEqual(concurrent);
      expect(
        client
          .getQueryData<InfiniteData<PatternPage>>(queryKeys.patterns(ownerId, query))
          ?.pages[0]?.items,
      ).toEqual([concurrent, items[1]]);
    });
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
    for (const item of items) {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.pattern(ownerId, item.id),
        exact: true,
      });
    }
  });
});
