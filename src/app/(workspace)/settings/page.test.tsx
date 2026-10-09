import { cleanup, render, screen } from "@testing-library/react";
import { useTheme } from "next-themes";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());

vi.mock("@/features/auth/session", () => ({ requireUser }));
vi.mock("next-themes", () => ({ useTheme: vi.fn() }));

describe("settings page", () => {
  afterEach(cleanup);

  it("loads the current user and renders their server-backed theme", async () => {
    const setTheme = vi.fn();
    vi.mocked(useTheme).mockReturnValue({
      setTheme,
    } as unknown as ReturnType<typeof useTheme>);
    requireUser.mockResolvedValue({
      id: "20b64d24-5e18-4127-b69a-5eb76a67960a",
      email: "owner@example.test",
      displayName: "Library Owner",
      role: "user",
      mustChangePassword: false,
      themePreference: "dark",
      sessionVersion: 0,
    });
    const { default: SettingsPage } = await import("./page");

    render(await SettingsPage());

    expect(requireUser).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "夜间" })).toBeChecked();
    expect(setTheme).toHaveBeenCalledWith("dark");
  });
});
