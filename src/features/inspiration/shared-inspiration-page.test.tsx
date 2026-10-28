import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { InspirationSharedDto } from "./contracts";
import { SharedInspirationPage } from "./shared-inspiration-page";
import {
  inspirationResultFixture,
  inspirationSourceFixture,
} from "./test-fixtures";

const analysis: InspirationSharedDto = {
  title: "都市轻通勤女装研究",
  prompt: "分析近 30 天都市轻通勤女装",
  completedAt: "2026-10-28T02:00:00.000Z",
  sources: [inspirationSourceFixture],
  result: {
    ...inspirationResultFixture,
    confidenceNote: "公开信息覆盖有限，请结合实际调研。",
  },
};

afterEach(cleanup);

describe("public inspiration report", () => {
  it("renders the approved report fields and a fixed market disclaimer without workspace providers", () => {
    render(<SharedInspirationPage analysis={analysis} />);

    expect(screen.getByRole("main")).toBeVisible();
    expect(
      screen.getByRole("heading", { level: 1, name: "都市轻通勤女装研究" }),
    ).toBeVisible();
    expect(screen.getByText("分析近 30 天都市轻通勤女装")).toBeVisible();
    expect(screen.getByText("2026-10-28")).toHaveAttribute(
      "datetime",
      "2026-10-28T02:00:00.000Z",
    );
    expect(
      screen.getByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).toBeVisible();
    for (const name of [
      "款式",
      "类型",
      "风格",
      "品类",
      "色款",
      "材质",
      "市场信号",
      "参考款",
      "设计灵感",
      "研究来源",
    ]) {
      expect(screen.getByRole("region", { name })).toBeVisible();
    }
    expect(
      screen.getByText("基于公开网络热销信号，不代表电商平台官方销量"),
    ).toBeVisible();
    expect(
      screen.getByText("公开信息覆盖有限，请结合实际调研。"),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "研究来源" })).getByRole(
        "link",
        { name: /都市轻通勤女装趋势/ },
      ),
    ).toHaveAttribute("href", "https://example.test/fashion/commuting");
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("selects only public DTO fields instead of rendering private record properties", () => {
    const privateFields = {
      ownerId: "private-owner-identifier",
      email: "private-owner@example.test",
      id: "private-analysis-identifier",
      searchRequestId: "private-search-request",
      structureRequestId: "private-structure-request",
      operationId: "private-operation-identifier",
      errorCode: "private-internal-failure",
      searchModel: "private-search-model",
      structureModel: "private-structure-model",
    };
    const { container } = render(
      <SharedInspirationPage analysis={{ ...analysis, ...privateFields }} />,
    );
    for (const value of Object.values(privateFields)) {
      expect(container.innerHTML).not.toContain(value);
    }
    expect(container.querySelector("form")).toBeNull();
  });

  it("treats prompts and result text as untrusted plain text", () => {
    const text = '<script>alert("inspiration")</script>';
    const { container } = render(
      <SharedInspirationPage
        analysis={{
          ...analysis,
          prompt: text,
          result: {
            ...analysis.result,
            summary: '<img src=x onerror="alert(1)">',
          },
        }}
      />,
    );
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeVisible();
    expect(container.querySelector("script, img")).toBeNull();
  });
});
