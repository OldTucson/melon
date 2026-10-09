import { cleanup, render } from "@testing-library/react";
import { useTheme } from "next-themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticatedThemeSync } from "@/features/theme/authenticated-theme-sync";

vi.mock("next-themes", () => ({
  useTheme: vi.fn(),
}));

const setTheme = vi.fn();

describe("AuthenticatedThemeSync", () => {
  beforeEach(() => {
    setTheme.mockReset();
    vi.mocked(useTheme).mockReturnValue({
      setTheme,
    } as unknown as ReturnType<typeof useTheme>);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("applies server preference for preference and account changes without persistence", () => {
    const { rerender } = render(
      <AuthenticatedThemeSync userId="user-a" preference="light" />,
    );
    expect(setTheme).toHaveBeenLastCalledWith("light");

    rerender(<AuthenticatedThemeSync userId="user-b" preference="light" />);
    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(setTheme).toHaveBeenLastCalledWith("light");

    rerender(<AuthenticatedThemeSync userId="user-b" preference="dark" />);
    expect(setTheme).toHaveBeenCalledTimes(3);
    expect(setTheme).toHaveBeenLastCalledWith("dark");
    expect(fetch).not.toHaveBeenCalled();
  });
});
