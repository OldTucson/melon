import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getServerEnv = vi.hoisted(() => vi.fn());

vi.mock("@/lib/env/server", () => ({ getServerEnv }));

describe("private service terms page", () => {
  afterEach(cleanup);

  it("describes the invitation-only service without inventing commercial terms", async () => {
    getServerEnv.mockReturnValue({
      SITE_OPERATOR_NAME: "Melon Studio",
      SITE_CONTACT_EMAIL: "support@example.test",
      SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
    });
    const { default: TermsPage } = await import("./page");

    const { container } = render(await TermsPage());

    expect(
      screen.getByRole("heading", { name: "服务协议", level: 1 }),
    ).toBeInTheDocument();
    for (const heading of [
      "私有邀请",
      "账户保护",
      "内容权利与必要授权",
      "禁止内容与行为",
      "服务可用性",
      "删除与保存",
      "暂停与终止",
      "协议变更",
      "联系我们",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByText(/仅向受邀成员开放/)).toBeInTheDocument();
    expect(screen.getByText(/保留其上传内容的所有权/)).toBeInTheDocument();
    expect(
      screen.getByText(/预览、存储、搜索、下载与删除/),
    ).toBeInTheDocument();
    expect(screen.getByText(/违法、侵权/)).toBeInTheDocument();
    expect(screen.getByText(/30 天/)).toBeInTheDocument();

    expect(container).not.toHaveTextContent("任何人均可注册");
    expect(container).not.toHaveTextContent("付费会员");
    expect(container).not.toHaveTextContent("交易市场");
    expect(container).not.toHaveTextContent(/ICP备|公网安备/);
    expect(container).not.toHaveTextContent("某某网络科技有限公司");
  });
});
