import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryOwnerProvider } from "@/lib/query/provider";
import { queryKeys } from "@/lib/query/keys";
import {
  useCreateFolderMutation,
  useRenameFolderMutation,
  useTrashFolderMutation,
  loadDeleteImpact,
} from "./folder-mutations";

const owner = "10000000-0000-4000-8000-000000000001";
const id = "20000000-0000-4000-8000-000000000001";
const operationId = "30000000-0000-4000-8000-000000000001";
const childId = "20000000-0000-4000-8000-000000000002";
const batchId = operationId;
const expectedImpact = {
  folderCount: 2,
  patternCount: 3,
  alreadyTrashedFolderCount: 0,
  alreadyTrashedPatternCount: 0,
  hasDeletingEntities: false,
  scopeFingerprint: "a".repeat(64),
};
const folder = {
  id,
  ownerId: owner,
  parentId: null,
  name: "原名",
  normalizedName: "原名",
  status: "active" as const,
  version: 0,
  trashBatchId: null,
  trashedAt: null,
  deletedAt: null,
  changeSeq: "1",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  directPatternCount: 2,
  recursivePatternCount: 3,
};
const key = queryKeys.folders(owner);
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function setup() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retryDelay: 0 },
    },
  });
  client.setQueryData(key, [folder]);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <QueryOwnerProvider ownerId={owner}>{children}</QueryOwnerProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("folder mutations", () => {
  it("creates optimistically, retries the exact operation, and reconciles authoritative DTO", async () => {
    const { client, wrapper } = setup();
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useCreateFolderMutation(), { wrapper });
    let request!: Promise<unknown>;
    act(() => {
      request = result.current.mutateAsync({
        operationId,
        input: { name: "新建", parentId: id },
      });
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(
      client
        .getQueryData<(typeof folder)[]>(key)
        ?.find((f) => f.id === operationId)?.name,
    ).toBe("新建");
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
      operationId,
      input: { name: "新建", parentId: id },
    });
    await act(async () => {
      finish(
        response(
          {
            ...folder,
            id: childId,
            parentId: id,
            name: "新建",
            normalizedName: "新建",
          },
          201,
        ),
      );
      await request;
    });
    expect(
      client.getQueryData<(typeof folder)[]>(key)?.map((f) => f.id),
    ).toEqual([id, childId]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
  it("rolls back only its optimistic create and does not retry a conflict", async () => {
    const { client, wrapper } = setup();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useCreateFolderMutation(), { wrapper });
    let request!: Promise<unknown>;
    act(() => {
      request = result.current
        .mutateAsync({ operationId, input: { name: "新建", parentId: null } })
        .catch((e) => e);
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    client.setQueryData<(typeof folder)[]>(key, (old) => [
      ...old!,
      { ...folder, id: childId },
    ]);
    await act(async () => {
      finish(
        response(
          {
            error: {
              code: "FOLDER_NAME_CONFLICT",
              message: "同名文件夹已存在",
            },
          },
          409,
        ),
      );
      await request;
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      client.getQueryData<(typeof folder)[]>(key)?.map((f) => f.id),
    ).toEqual([id, childId]);
  });
  it("renames optimistically and restores only changed fields while preserving concurrent counts", async () => {
    const { client, wrapper } = setup();
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
    const { result } = renderHook(() => useRenameFolderMutation(), { wrapper });
    let request!: Promise<unknown>;
    act(() => {
      request = result.current
        .mutateAsync({ id, operationId, patch: { name: "新名", version: 0 } })
        .catch((e) => e);
    });
    await waitFor(() =>
      expect(client.getQueryData<(typeof folder)[]>(key)?.[0]?.name).toBe(
        "新名",
      ),
    );
    client.setQueryData<(typeof folder)[]>(key, (old) =>
      old!.map((f) => ({ ...f, directPatternCount: 99 })),
    );
    await act(async () => {
      finish(response({ error: { code: "FOLDER_NAME_CONFLICT" } }, 409));
      await request;
    });
    expect(client.getQueryData<(typeof folder)[]>(key)?.[0]).toMatchObject({
      name: "原名",
      version: 0,
      directPatternCount: 99,
    });
  });
  it("does not roll back newer concurrent rename", async () => {
    const { client, wrapper } = setup();
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
    const { result } = renderHook(() => useRenameFolderMutation(), { wrapper });
    let request!: Promise<unknown>;
    act(() => {
      request = result.current
        .mutateAsync({ id, operationId, patch: { name: "新名", version: 0 } })
        .catch((e) => e);
    });
    await waitFor(() =>
      expect(client.getQueryData<(typeof folder)[]>(key)?.[0]?.name).toBe(
        "新名",
      ),
    );
    client.setQueryData(key, [
      { ...folder, name: "更新", normalizedName: "更新", version: 2 },
    ]);
    await act(async () => {
      finish(response({ error: { code: "FOLDER_STATE_CHANGED" } }, 409));
      await request;
    });
    expect(client.getQueryData<(typeof folder)[]>(key)?.[0]?.name).toBe("更新");
  });
  it("validates rename identity, owner, version and malformed 2xx before reconciling", async () => {
    for (const bad of [
      { ...folder, id: childId },
      { ...folder, ownerId: childId },
      { ...folder, version: 0 },
      {},
    ]) {
      const { client, wrapper } = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(bad)),
      );
      const { result, unmount } = renderHook(() => useRenameFolderMutation(), {
        wrapper,
      });
      await act(async () => {
        await expect(
          result.current.mutateAsync({
            id,
            operationId,
            patch: { name: "新名", version: 0 },
          }),
        ).rejects.toBeDefined();
      });
      expect(client.getQueryData<(typeof folder)[]>(key)?.[0]?.name).toBe(
        "原名",
      );
      unmount();
    }
  });
  it("keeps subtree until delete succeeds, then invalidates folder, pattern, details and trash caches", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(key, [
      folder,
      { ...folder, id: childId, parentId: id },
    ]);
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useTrashFolderMutation(), { wrapper });
    let request!: Promise<unknown>;
    act(() => {
      request = result.current.mutateAsync({
        id,
        operationId,
        version: 0,
        expectedImpact,
      });
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(client.getQueryData<(typeof folder)[]>(key)).toHaveLength(2);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      operationId,
      version: 0,
      expectedImpact,
    });
    await act(async () => {
      finish(
        response({
          state: "trashed",
          trashBatchId: batchId,
          rootFolderId: id,
          folderCount: 2,
          patternCount: 3,
        }),
      );
      await request;
    });
    expect(client.getQueryData(key)).toEqual([]);
    for (const suffix of ["folders", "patterns", "pattern", "trash"])
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["owner", owner, suffix] }),
      );
  });
  it("retains subtree on invalid delete success and invalidates to converge", async () => {
    const { client, wrapper } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          state: "trashed",
          rootFolderId: childId,
          trashBatchId: batchId,
          folderCount: 1,
          patternCount: 0,
        }),
      ),
    );
    const { result } = renderHook(() => useTrashFolderMutation(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          id,
          operationId,
          version: 0,
          expectedImpact,
        }),
      ).rejects.toBeDefined();
    });
    expect(client.getQueryData(key)).toEqual([folder]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
  it("rejects a delete success for a different operation batch", async () => {
    const { client, wrapper } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          state: "trashed",
          rootFolderId: id,
          trashBatchId: childId,
          folderCount: 1,
          patternCount: 0,
        }),
      ),
    );
    const { result } = renderHook(() => useTrashFolderMutation(), { wrapper });
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          id,
          operationId,
          version: 0,
          expectedImpact,
        }),
      ).rejects.toBeDefined();
    });
    expect(client.getQueryData(key)).toEqual([folder]);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
  it("strictly validates impact counts and deleting flags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          folderCount: 2,
          patternCount: 4,
          alreadyTrashedFolderCount: 2,
          alreadyTrashedPatternCount: 4,
          hasDeletingEntities: true,
          scopeFingerprint: "b".repeat(64),
        }),
      ),
    );
    expect(await loadDeleteImpact(id)).toMatchObject({
      hasDeletingEntities: true,
      patternCount: 4,
      scopeFingerprint: "b".repeat(64),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ folderCount: -1 })),
    );
    await expect(loadDeleteImpact(id)).rejects.toBeDefined();
  });
  it("retries a rename 503 once with the same request and applies authoritative fields", async () => {
    const { client, wrapper } = setup();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ error: { code: "TEMPORARY" } }, 503))
      .mockResolvedValueOnce(
        response({
          ...folder,
          name: "更新",
          normalizedName: "更新",
          version: 1,
          changeSeq: "10",
          updatedAt: "2026-10-09T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useRenameFolderMutation(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        id,
        operationId,
        patch: { name: "更新", version: 0 },
      });
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
    expect(client.getQueryData<(typeof folder)[]>(key)?.[0]).toMatchObject({
      name: "更新",
      version: 1,
      changeSeq: "10",
      updatedAt: "2026-10-09T00:00:00.000Z",
    });
  });
});
