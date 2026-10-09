import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  requireUser: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  usePathname: () => "/library",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ setTheme: mocks.setTheme }),
}));

const sessionUser = {
  id: "20b64d24-5e18-4127-b69a-5eb76a67960a",
  email: "owner@example.test",
  displayName: "Library Owner",
  role: "user" as const,
  mustChangePassword: false,
  themePreference: "system" as const,
  sessionVersion: 0,
};

describe("workspace layout", () => {
  beforeEach(() => {
    mocks.redirect.mockReset();
    mocks.requireUser.mockReset();
    mocks.setTheme.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("redirects users who must replace their password", async () => {
    mocks.requireUser.mockResolvedValue({
      ...sessionUser,
      mustChangePassword: true,
    });
    const { default: WorkspaceLayout } = await import("./layout");

    await WorkspaceLayout({ children: <p>Private workspace</p> });

    expect(mocks.redirect).toHaveBeenCalledWith("/change-password");
  });

  it("renders workspace content for a current user", async () => {
    mocks.requireUser.mockResolvedValue(sessionUser);
    const { default: WorkspaceLayout } = await import("./layout");

    render(await WorkspaceLayout({ children: <p>Private workspace</p> }));

    expect(mocks.requireUser).toHaveBeenCalledTimes(1);
    expect(mocks.setTheme).toHaveBeenCalledWith(sessionUser.themePreference);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tags"));
    expect(screen.getByText("Private workspace")).toBeInTheDocument();
  });
});
