import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  loadSessionUser: vi.fn(),
  getServerEnv: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/features/auth/session", () => ({
  loadSessionUser: mocks.loadSessionUser,
}));
vi.mock("@/lib/env/server", () => ({ getServerEnv: mocks.getServerEnv }));
vi.mock("./login-form", () => ({
  LoginForm: () => <form aria-label="登录" />,
}));

describe("login page", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue(null);
    mocks.getServerEnv.mockReturnValue({
      SITE_OPERATOR_NAME: "Melon Studio",
      SITE_CONTACT_EMAIL: "privacy@example.test",
      SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows policies and contact details without empty filing elements", async () => {
    const { default: LoginPage } = await import("./page");
    const { container } = render(await LoginPage());

    expect(screen.getByRole("form", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: "服务协议" })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(screen.getByText("Melon Studio")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "privacy@example.test" }),
    ).toHaveAttribute("href", "mailto:privacy@example.test");
    expect(screen.queryByText(/ICP备/)).not.toBeInTheDocument();
    expect(screen.queryByText(/公网安备/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('a[href=""]')).toHaveLength(0);
  });

  it("shows both filing links when configured", async () => {
    const publicSecurityUrl =
      "https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=00000000000000";
    mocks.getServerEnv.mockReturnValue({
      SITE_OPERATOR_NAME: "Melon Studio",
      SITE_CONTACT_EMAIL: "privacy@example.test",
      SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
      ICP_FILING_NUMBER: "浙ICP备00000000号-1",
      PUBLIC_SECURITY_FILING_NUMBER: "浙公网安备 00000000000000号",
      PUBLIC_SECURITY_FILING_URL: publicSecurityUrl,
    });
    const { default: LoginPage } = await import("./page");
    render(await LoginPage());

    expect(
      screen.getByRole("link", { name: "浙ICP备00000000号-1" }),
    ).toHaveAttribute("href", "https://beian.miit.gov.cn/");
    expect(
      screen.getByRole("link", {
        name: "浙公网安备 00000000000000号",
      }),
    ).toHaveAttribute("href", publicSecurityUrl);
  });
});
