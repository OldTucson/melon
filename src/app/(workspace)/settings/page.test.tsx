import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { useTheme } from "next-themes";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthenticatedThemeProvider } from "@/features/theme/authenticated-theme-provider";
import { QueryOwnerProvider } from "@/lib/query/provider";

const requireUser = vi.hoisted(() => vi.fn());

vi.mock("@/features/auth/session", () => ({ requireUser }));
vi.mock("next-themes", () => ({ useTheme: vi.fn() }));

describe("settings page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the current user and renders their server-backed theme", async () => {
    const setTheme = vi.fn();
    vi.mocked(useTheme).mockReturnValue({
      setTheme,
    } as unknown as ReturnType<typeof useTheme>);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          Response.json(
            String(input) === "/api/settings/image-search"
              ? {
                  indexVersion: "visual-search-v1",
                  eligible: 4,
                  ready: 2,
                  pending: 1,
                  indexing: 0,
                  failed: 1,
                  worker: "online",
                }
              : [],
          ),
        ),
      ),
    );
    const user = {
      id: "20b64d24-5e18-4127-b69a-5eb76a67960a",
      email: "owner@example.test",
      displayName: "Library Owner",
      role: "user",
      mustChangePassword: false,
      themePreference: "dark" as const,
      sessionVersion: 0,
    };
    requireUser.mockResolvedValue(user);
    const { default: SettingsPage } = await import("./page");

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <AuthenticatedThemeProvider
        userId={user.id}
        serverPreference={user.themePreference}
      >
        <QueryClientProvider client={client}>
          <QueryOwnerProvider ownerId={user.id}>
            <Tooltip.Provider>{await SettingsPage()}</Tooltip.Provider>
          </QueryOwnerProvider>
        </QueryClientProvider>
      </AuthenticatedThemeProvider>,
    );

    expect(requireUser).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "图像搜索索引" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "夜间" })).toBeChecked();
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(fetch).toHaveBeenCalledWith(
      "/api/authorization-fields?includeArchived=true",
    );
  });
});
