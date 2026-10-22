import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImageSearchFiltersInput } from "@/features/image-search/contracts";

import type { PaletteSearchResponse } from "./contracts";
import { searchPatternsByPalette } from "./palette-search-client";
import { usePaletteSearchSession } from "./use-palette-search-session";

const baseFilters: ImageSearchFiltersInput = {
  formats: [],
  includeDescendants: true,
  tagIds: [],
  tagMode: "all",
};

function response(colors: readonly string[]): PaletteSearchResponse {
  return {
    query: { colors: [...colors] },
    items: [],
    timing: { totalMs: 12 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePaletteSearchSession", () => {
  it("enters once, keeps unique insertion order, removes colors, and restores on exit", () => {
    vi.useFakeTimers();
    const prepareEnter = vi.fn(() => ({ marker: "normal" }));
    const restoreSnapshot = vi.fn();
    const search = vi.fn<typeof searchPatternsByPalette>(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      usePaletteSearchSession({
        ownerId: "owner-1",
        filters: baseFilters,
        filterSignature: "all",
        prepareEnter,
        restoreSnapshot,
        search,
      }),
    );

    act(() => result.current.toggleColor("#285947"));
    act(() => result.current.toggleColor("#CC9C3F"));
    act(() => result.current.toggleColor("#285947"));

    expect(prepareEnter).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(true);
    expect(result.current.colors).toEqual(["#CC9C3F"]);

    act(() => result.current.removeColor("#CC9C3F"));
    expect(result.current.active).toBe(false);
    expect(result.current.colors).toEqual([]);
    expect(restoreSnapshot).toHaveBeenCalledWith({ marker: "normal" });

    act(() => result.current.toggleColor("#8F4038"));
    act(() => result.current.clear());
    expect(prepareEnter).toHaveBeenCalledTimes(2);
    expect(restoreSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rejects a sixth unique color with a polite limit message", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePaletteSearchSession({
        ownerId: "owner-1",
        filters: baseFilters,
        filterSignature: "all",
        prepareEnter: () => "snapshot",
        restoreSnapshot: vi.fn(),
        search: vi.fn<typeof searchPatternsByPalette>(() => new Promise(() => {})),
      }),
    );

    for (const color of [
      "#111111",
      "#222222",
      "#333333",
      "#444444",
      "#555555",
      "#666666",
    ]) {
      act(() => result.current.toggleColor(color));
    }

    expect(result.current.colors).toEqual([
      "#111111",
      "#222222",
      "#333333",
      "#444444",
      "#555555",
    ]);
    expect(result.current.limitMessage).toBe("最多选择 5 个颜色");
  });

  it("debounces changes for 150 ms and sends the ordered colors once", async () => {
    vi.useFakeTimers();
    const search = vi.fn<typeof searchPatternsByPalette>(async (input) =>
      response(input.colors),
    );
    const { result } = renderHook(() =>
      usePaletteSearchSession({
        ownerId: "owner-1",
        filters: baseFilters,
        filterSignature: "all",
        prepareEnter: () => "snapshot",
        restoreSnapshot: vi.fn(),
        search,
      }),
    );

    act(() => result.current.toggleColor("#285947"));
    act(() => result.current.toggleColor("#CC9C3F"));
    await act(async () => vi.advanceTimersByTimeAsync(149));
    expect(search).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0].colors).toEqual([
      "#285947",
      "#CC9C3F",
    ]);
    expect(result.current.response?.query.colors).toEqual([
      "#285947",
      "#CC9C3F",
    ]);
  });

  it("aborts replaced requests and ignores a stale response", async () => {
    vi.useFakeTimers();
    const first = deferred<PaletteSearchResponse>();
    const second = deferred<PaletteSearchResponse>();
    const search = vi
      .fn<typeof searchPatternsByPalette>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      usePaletteSearchSession({
        ownerId: "owner-1",
        filters: baseFilters,
        filterSignature: "all",
        prepareEnter: () => "snapshot",
        restoreSnapshot: vi.fn(),
        search,
      }),
    );

    act(() => result.current.toggleColor("#285947"));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const firstSignal = search.mock.calls[0]![0].signal;
    act(() => result.current.toggleColor("#CC9C3F"));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(150));

    await act(async () => {
      second.resolve(response(["#285947", "#CC9C3F"]));
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve(response(["#285947"]));
      await Promise.resolve();
    });

    expect(result.current.response?.query.colors).toEqual([
      "#285947",
      "#CC9C3F",
    ]);
  });

  it("reruns on filters, retaining the last response when the rerun fails", async () => {
    vi.useFakeTimers();
    const firstResponse = response(["#285947"]);
    const search = vi
      .fn<typeof searchPatternsByPalette>()
      .mockResolvedValueOnce(firstResponse)
      .mockRejectedValueOnce(new Error("offline"));
    const restoreSnapshot = vi.fn();
    const { result, rerender } = renderHook(
      ({ filters, filterSignature }) =>
        usePaletteSearchSession({
          ownerId: "owner-1",
          filters,
          filterSignature,
          prepareEnter: () => "snapshot",
          restoreSnapshot,
          search,
        }),
      {
        initialProps: {
          filters: baseFilters,
          filterSignature: "all",
        },
      },
    );

    act(() => result.current.toggleColor("#285947"));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(result.current.response).toEqual(firstResponse);

    rerender({
      filters: { ...baseFilters, formats: ["png"] },
      filterSignature: "format=png",
    });
    await act(async () => vi.advanceTimersByTimeAsync(150));

    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]?.[0].filters).toMatchObject({ formats: ["png"] });
    expect(result.current.response).toEqual(firstResponse);
    expect(result.current.error).toBe("配色搜索失败，请检查网络后重试");
    expect(restoreSnapshot).not.toHaveBeenCalled();
  });

  it("restores after an initial failure and can retry the failed colors", async () => {
    vi.useFakeTimers();
    const search = vi
      .fn<typeof searchPatternsByPalette>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(async (input) => response(input.colors));
    const prepareEnter = vi.fn(() => ({ marker: "normal" }));
    const restoreSnapshot = vi.fn();
    const { result } = renderHook(() =>
      usePaletteSearchSession({
        ownerId: "owner-1",
        filters: baseFilters,
        filterSignature: "all",
        prepareEnter,
        restoreSnapshot,
        search,
      }),
    );

    act(() => result.current.toggleColor("#285947"));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(result.current.active).toBe(false);
    expect(result.current.retry).toEqual({
      colors: ["#285947"],
      message: "配色搜索失败，请检查网络后重试",
    });
    expect(restoreSnapshot).toHaveBeenCalledWith({ marker: "normal" });

    act(() => result.current.retryInitialFailure());
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(prepareEnter).toHaveBeenCalledTimes(2);
    expect(result.current.active).toBe(true);
    expect(result.current.response?.query.colors).toEqual(["#285947"]);
  });

  it("aborts and resets on owner changes and aborts again on unmount", async () => {
    vi.useFakeTimers();
    const search = vi.fn<typeof searchPatternsByPalette>(() => new Promise(() => {}));
    const { result, rerender, unmount } = renderHook(
      ({ ownerId }) =>
        usePaletteSearchSession({
          ownerId,
          filters: baseFilters,
          filterSignature: "all",
          prepareEnter: () => "snapshot",
          restoreSnapshot: vi.fn(),
          search,
        }),
      { initialProps: { ownerId: "owner-1" } },
    );

    act(() => result.current.toggleColor("#285947"));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const firstSignal = search.mock.calls[0]![0].signal;
    rerender({ ownerId: "owner-2" });
    expect(firstSignal.aborted).toBe(true);
    expect(result.current.active).toBe(false);

    act(() => result.current.toggleColor("#CC9C3F"));
    await act(async () => vi.advanceTimersByTimeAsync(150));
    const secondSignal = search.mock.calls[1]![0].signal;
    unmount();
    expect(secondSignal.aborted).toBe(true);
  });
});
