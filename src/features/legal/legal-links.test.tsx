import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LegalLinks } from "./legal-links";

describe("LegalLinks", () => {
  afterEach(cleanup);

  it("always exposes policies and supplied operator contact details", () => {
    render(
      <LegalLinks
        config={{
          operatorName: "Melon Studio",
          contactEmail: "privacy@example.test",
        }}
      />,
    );

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
  });

  it("links configured filing identifiers to their authoritative targets", () => {
    const publicSecurityUrl =
      "https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=00000000000000";
    render(
      <LegalLinks
        config={{
          icpFilingNumber: "浙ICP备00000000号-1",
          publicSecurityFiling: {
            number: "浙公网安备 00000000000000号",
            url: publicSecurityUrl,
          },
        }}
      />,
    );

    expect(
      screen.getByRole("link", { name: "浙ICP备00000000号-1" }),
    ).toHaveAttribute("href", "https://beian.miit.gov.cn/");
    expect(
      screen.getByRole("link", {
        name: "浙公网安备 00000000000000号",
      }),
    ).toHaveAttribute("href", publicSecurityUrl);
    for (const link of screen.getAllByRole("link")) {
      if (link.getAttribute("href")?.startsWith("https://")) {
        expect(link).toHaveAttribute("rel", "noreferrer");
      }
    }
  });

  it("does not render empty metadata or filing anchors", () => {
    const { container } = render(<LegalLinks config={{}} />);

    expect(screen.queryByText(/运营者/)).not.toBeInTheDocument();
    expect(screen.queryByText(/联系邮箱/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('a[href=""]')).toHaveLength(0);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});
