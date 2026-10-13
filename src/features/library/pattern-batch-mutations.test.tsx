import {
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
} from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseLibrarySearchParams,
  toPatternQuery,
} from "@/features/library/query-state";
import { queryKeys } from "@/lib/query/keys";
import { QueryOwnerProvider } from "@/lib/query/provider";

import type { PatternItem, PatternPage } from "./library-types";
import { usePatternBatchMutation } from "./pattern-batch-mutations";
import { useSelectionStore } from "./selection-store";

const ownerId = "10000000-0000-4000-8000-000000000000";
const folderId = "20000000-0000-4000-8000-000000000000";
const query = toPatternQuery(parseLibrarySearchParams(new URLSearchParams()));
const favoriteQuery = { ...query, favorite: true };

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
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network down");
      return Response.json({
        patterns: items.map((item) => ({ ...item, isFavorite: true, version: item.version + 1 })),
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

  it("keeps trashed rows until success and clears only IDs returned by the server", async () => {
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
      resolve(Response.json({ patterns: [{ ...items[0]!, status: "trashed", version: 2 }] }));
    });

    await waitFor(() => {
      expect(client.getQueryData<InfiniteData<PatternPage>>(queryKeys.patterns(ownerId, query))
        ?.pages[0]?.items.map((item) => item.id)).toEqual([items[1]!.id, items[2]!.id]);
      expect(useSelectionStore.getState().selectedIds).toEqual([items[1]!.id, items[2]!.id]);
    });
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
});
