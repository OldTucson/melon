import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getServerEnv = vi.hoisted(() => vi.fn());

vi.mock("@/lib/env/server", () => ({ getServerEnv }));

describe("privacy policy page", () => {
  afterEach(cleanup);

  it("describes the product's actual data handling without exposing secrets", async () => {
    getServerEnv.mockReturnValue({
      SITE_OPERATOR_NAME: "Melon Studio",
      SITE_CONTACT_EMAIL: "privacy@example.test",
      SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
      AUTH_SECRET: "do-not-render-this-secret",
      DATABASE_URL: "postgres://private-database",
    });
    const { default: PrivacyPage } = await import("./page");

    const { container } = render(await PrivacyPage());

    expect(
      screen.getByRole("heading", { name: "隐私政策", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute(
      "href",
      "/login",
    );
    for (const heading of [
      "信息处理者",
      "处理的信息",
      "处理目的",
      "存储与安全",
      "保存期限",
      "用户权利",
      "政策更新",
      "联系我们",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByText(/账户邮箱/)).toBeInTheDocument();
    expect(screen.getByText(/上传的图案与预览文件/)).toBeInTheDocument();
    expect(screen.getByText(/授权记录/)).toBeInTheDocument();
    expect(screen.getByText(/仅用于处理当前一次搜索请求/)).toBeInTheDocument();
    expect(screen.getByText(/不会作为素材加入图库/)).toBeInTheDocument();
    expect(screen.getByText(/对象存储（OSS）/)).toBeInTheDocument();
    expect(screen.getAllByText(/安全日志/).length).toBeGreaterThan(0);
    expect(screen.getByText(/30 天/)).toBeInTheDocument();
    expect(screen.getByText(/访问、更正/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "privacy@example.test" }),
    ).toHaveAttribute("href", "mailto:privacy@example.test");

    expect(container).not.toHaveTextContent("do-not-render-this-secret");
    expect(container).not.toHaveTextContent("postgres://private-database");
    expect(container).not.toHaveTextContent("备案已完成");
  });
});
