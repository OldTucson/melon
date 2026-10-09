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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

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

  it("rolls back to the most recently confirmed server preference", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ themePreference: "dark" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unable to save theme" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="light" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));

    await waitFor(() => {
      expect(setTheme).toHaveBeenLastCalledWith("dark");
    });
    expect(screen.getByRole("radio", { name: "夜间" })).toBeChecked();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale failure after the latest preference is confirmed", async () => {
    const requestA = deferred<Response>();
    const requestB = deferred<Response>();
    vi.mocked(fetch)
      .mockReset()
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="light" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      requestB.resolve(response("system"));
      await requestB.promise;
    });
    await act(async () => {
      requestA.resolve(failureResponse());
      await requestA.promise;
    });

    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();
    expect(setTheme).toHaveBeenLastCalledWith("system");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rolls the latest failure back to a newly confirmed earlier request", async () => {
    const requestA = deferred<Response>();
    const requestB = deferred<Response>();
    vi.mocked(fetch)
      .mockReset()
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);
    const user = userEvent.setup();
    render(<ThemeControl serverPreference="light" />);

    await user.click(screen.getByRole("radio", { name: "夜间" }));
    await user.click(screen.getByRole("radio", { name: "跟随系统" }));

    await act(async () => {
      requestA.resolve(response("dark"));
      await requestA.promise;
    });
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();

    await act(async () => {
      requestB.resolve(failureResponse());
      await requestB.promise;
    });

    expect(screen.getByRole("radio", { name: "夜间" })).toBeChecked();
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    expect(
      screen.getByRole("alert", { name: "主题保存失败" }),
    ).toBeInTheDocument();
  });

  it("synchronizes when the authenticated server preference changes", () => {
    const { rerender } = render(<ThemeControl serverPreference="system" />);

    rerender(<ThemeControl serverPreference="dark" />);

    expect(setTheme).toHaveBeenLastCalledWith("dark");
    expect(fetch).not.toHaveBeenCalled();
  });
});
