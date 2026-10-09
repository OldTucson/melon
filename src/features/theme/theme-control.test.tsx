import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTheme } from "next-themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeControl } from "@/features/theme/theme-control";

vi.mock("next-themes", () => ({
  useTheme: vi.fn(),
}));

const setTheme = vi.fn();
const mockedUseTheme = vi.mocked(useTheme);

const response = (themePreference: "system" | "light" | "dark") =>
  new Response(JSON.stringify({ themePreference }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const failureResponse = () =>
  new Response(JSON.stringify({ error: "Unable to save theme" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });

const queuedFetch = () => {
  type QueuedRequest = {
    body: unknown;
    resolve: (response: Response) => void;
  };

  const requests: QueuedRequest[] = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

    return new Promise<Response>((resolve) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        resolve: (nextResponse) => {
          activeRequests -= 1;
          resolve(nextResponse);
        },
      });
    });
  });

  return {
    fetchMock,
    get maxActiveRequests() {
      return maxActiveRequests;
    },
    requests,
  };
};

const settle = async (
  request: { resolve: (response: Response) => void },
  nextResponse: Response,
) => {
  await act(async () => {
    request.resolve(nextResponse);
    await Promise.resolve();
  });
};

describe("ThemeControl", () => {
  beforeEach(() => {
    setTheme.mockReset();
    mockedUseTheme.mockReturnValue({
      setTheme,
    } as unknown as ReturnType<typeof useTheme>);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ themePreference: "dark" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses the server preference initially and persists one selected change", async () => {
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="light" />);

    expect(setTheme).toHaveBeenCalledWith("light");

    await user.click(screen.getByRole("radio", { name: "夜间" }));

    expect(setTheme).toHaveBeenLastCalledWith("dark");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/api/settings/theme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themePreference: "dark" }),
    });
  });

  it("rolls back to the prior server preference and announces a failed save", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unable to save theme" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="light" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));

    await waitFor(() => {
      expect(setTheme).toHaveBeenLastCalledWith("light");
    });
    expect(
      screen.getByRole("alert", { name: "主题保存失败" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "浅色" })).toBeChecked();
  });

  it("serializes an in-flight success before persisting the latest success", async () => {
    const queue = queuedFetch();
    vi.stubGlobal("fetch", queue.fetchMock);
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="light" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(queue.requests).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();

    await settle(queue.requests[0]!, response("dark"));
    await waitFor(() => expect(queue.requests).toHaveLength(2));
    await settle(queue.requests[1]!, response("system"));

    expect(queue.requests.map(({ body }) => body)).toEqual([
      { themePreference: "dark" },
      { themePreference: "system" },
    ]);
    expect(queue.maxActiveRequests).toBe(1);
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rolls a failed latest request back to the preceding confirmed success", async () => {
    const queue = queuedFetch();
    vi.stubGlobal("fetch", queue.fetchMock);
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="light" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));

    await settle(queue.requests[0]!, response("dark"));
    await waitFor(() => expect(queue.requests).toHaveLength(2));
    await settle(queue.requests[1]!, failureResponse());

    expect(queue.maxActiveRequests).toBe(1);
    expect(screen.getByRole("radio", { name: "夜间" })).toBeChecked();
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    expect(
      screen.getByRole("alert", { name: "主题保存失败" }),
    ).toBeInTheDocument();
  });

  it("continues to the latest request without rollback when an earlier request fails", async () => {
    const queue = queuedFetch();
    vi.stubGlobal("fetch", queue.fetchMock);
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="light" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));

    await settle(queue.requests[0]!, failureResponse());
    await waitFor(() => expect(queue.requests).toHaveLength(2));
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await settle(queue.requests[1]!, response("system"));

    expect(queue.maxActiveRequests).toBe(1);
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();
    expect(setTheme).toHaveBeenLastCalledWith("system");
  });

  it("coalesces rapid pending selections to the latest intent", async () => {
    const queue = queuedFetch();
    vi.stubGlobal("fetch", queue.fetchMock);
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="system" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "浅色" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(queue.requests).toHaveLength(1);

    await settle(queue.requests[0]!, response("dark"));
    await waitFor(() => expect(queue.requests).toHaveLength(2));
    await settle(queue.requests[1]!, response("system"));

    expect(queue.requests.map(({ body }) => body)).toEqual([
      { themePreference: "dark" },
      { themePreference: "system" },
    ]);
    expect(queue.maxActiveRequests).toBe(1);
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();
  });

  it("does not update theme or start pending work after unmount", async () => {
    const queue = queuedFetch();
    vi.stubGlobal("fetch", queue.fetchMock);
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<ThemeControl serverPreference="light" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(queue.requests).toHaveLength(1);
    const setThemeCalls = setTheme.mock.calls.length;

    unmount();
    await settle(queue.requests[0]!, response("dark"));

    expect(queue.requests).toHaveLength(1);
    expect(setTheme).toHaveBeenCalledTimes(setThemeCalls);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("synchronizes when the authenticated server preference changes", () => {
    const { rerender } = render(<ThemeControl serverPreference="system" />);

    rerender(<ThemeControl serverPreference="dark" />);

    expect(setTheme).toHaveBeenLastCalledWith("dark");
    expect(fetch).not.toHaveBeenCalled();
  });
});
