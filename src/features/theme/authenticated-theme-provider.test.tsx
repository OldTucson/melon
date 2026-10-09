import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTheme } from "next-themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticatedThemeProvider } from "@/features/theme/authenticated-theme-provider";
import { ThemeControl } from "@/features/theme/theme-control";

vi.mock("next-themes", () => ({
  useTheme: vi.fn(),
}));

const setTheme = vi.fn();

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
  status: 200 | 500,
) => {
  await act(async () => {
    request.resolve(
      Response.json(status === 200 ? { themePreference: "dark" } : {}, {
        status,
      }),
    );
    await Promise.resolve();
  });
};

const workspace = (
  userId: string,
  serverPreference: "system" | "light" | "dark",
) => (
  <AuthenticatedThemeProvider
    userId={userId}
    serverPreference={serverPreference}
  >
    <ThemeControl />
  </AuthenticatedThemeProvider>
);

describe("AuthenticatedThemeProvider", () => {
  beforeEach(() => {
    setTheme.mockReset();
    vi.mocked(useTheme).mockReturnValue({
      setTheme,
    } as unknown as ReturnType<typeof useTheme>);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reapplies server preference for preference and account changes without PATCH", () => {
    const { rerender } = render(
      <AuthenticatedThemeProvider userId="user-a" serverPreference="light">
        <p>Private workspace</p>
      </AuthenticatedThemeProvider>,
    );
    expect(setTheme).toHaveBeenLastCalledWith("light");

    rerender(
      <AuthenticatedThemeProvider userId="user-b" serverPreference="light">
        <p>Private workspace</p>
      </AuthenticatedThemeProvider>,
    );
    expect(setTheme).toHaveBeenCalledTimes(2);

    rerender(
      <AuthenticatedThemeProvider userId="user-b" serverPreference="dark">
        <p>Private workspace</p>
      </AuthenticatedThemeProvider>,
    );
    expect(setTheme).toHaveBeenCalledTimes(3);
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isolates an old user's failed request and queued intent after account switch", async () => {
    const queue = queuedFetch();
    vi.stubGlobal("fetch", queue.fetchMock);
    const user = userEvent.setup();
    const { rerender } = render(workspace("user-a", "light"));

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(queue.requests).toHaveLength(1);

    rerender(workspace("user-b", "dark"));
    expect(screen.getByRole("radio", { name: "夜间" })).toBeChecked();
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    const callsAfterSwitch = setTheme.mock.calls.length;

    await settle(queue.requests[0]!, 500);

    expect(queue.requests).toHaveLength(1);
    expect(queue.maxActiveRequests).toBe(1);
    expect(setTheme).toHaveBeenCalledTimes(callsAfterSwitch);
    expect(screen.getByRole("radio", { name: "夜间" })).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not apply or continue work after the provider truly unmounts", async () => {
    const queue = queuedFetch();
    vi.stubGlobal("fetch", queue.fetchMock);
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { unmount } = render(workspace("user-a", "light"));

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(queue.requests).toHaveLength(1);
    const callsBeforeUnmount = setTheme.mock.calls.length;

    unmount();
    await settle(queue.requests[0]!, 500);

    expect(queue.requests).toHaveLength(1);
    expect(setTheme).toHaveBeenCalledTimes(callsBeforeUnmount);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
