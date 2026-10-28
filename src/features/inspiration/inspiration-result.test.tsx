import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InspirationResult } from "./inspiration-result";
import {
  inspirationDetailFixture,
  inspirationResultFixture,
} from "./test-fixtures";

afterEach(cleanup);

describe("inspiration results", () => {
  it("resolves references by source index and labels color swatches and design inference", () => {
    render(
      <InspirationResult
        result={inspirationResultFixture}
        sources={inspirationDetailFixture.sources!}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).toBeVisible();
    const reference = within(
      screen.getByRole("region", { name: "参考款" }),
    ).getByRole("link", { name: /棉麻衬衫叠穿/ });
    expect(reference).toHaveAttribute(
      "href",
      "https://example.test/fashion/commuting",
    );
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByRole("img", { name: "柔和米白 #EEE8DA" })).toHaveStyle({
      backgroundColor: "#EEE8DA",
    });
    expect(
      screen.getByRole("heading", { name: "设计灵感 · 设计推演" }),
    ).toBeVisible();
  });

  it("uses source identifiers rather than array positions and omits unsupported facts", () => {
    render(
      <InspirationResult
        sources={[
          {
            index: 7,
            title: "真实参考来源",
            url: "https://example.test/product/7",
            siteName: null,
          },
        ]}
        result={{
          ...inspirationResultFixture,
          referenceLooks: [
            {
              name: "短款垂感衬衫",
              sourceKind: "product",
              whyRelevant: "垂感结构参考",
              sourceIndexes: [7, 99],
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "短款垂感衬衫" })).toHaveAttribute(
      "href",
      "https://example.test/product/7",
    );
    expect(screen.queryByText("宽松直线廓形")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "款式" })).getByText(
        "暂无有来源支持的趋势",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/\[99\]/)).not.toBeInTheDocument();
  });

  it("replaces structured provider titles with a readable source label", () => {
    render(
      <InspirationResult
        sources={[
          {
            index: 7,
            title: '{"code":0,"strategy_result":{"pages":[]}}',
            url: "https://mp.weixin.qq.com/s/example",
            siteName: "腾讯网",
          },
          {
            index: 8,
            title: '[{"type":"computer_initialize_state"}]',
            url: "https://fashion.example.test/trend",
            siteName: null,
          },
        ]}
        result={inspirationResultFixture}
      />,
    );

    const sources = within(screen.getByRole("region", { name: "研究来源" }));
    expect(sources.getByRole("link", { name: /\[7\] 腾讯网/ })).toHaveAttribute(
      "href",
      "https://mp.weixin.qq.com/s/example",
    );
    expect(
      sources.getByRole("link", { name: /\[8\] fashion\.example\.test/ }),
    ).toHaveAttribute("href", "https://fashion.example.test/trend");
    expect(screen.queryByText(/strategy_result/)).not.toBeInTheDocument();
    expect(screen.queryByText(/computer_initialize_state/)).not.toBeInTheDocument();
  });

  it("shows honest empty dimensions and never invents a missing source URL", () => {
    render(
      <InspirationResult
        sources={[]}
        result={{
          ...inspirationResultFixture,
          marketSignals: [],
          referenceLooks: [],
          dimensions: {
            silhouettes: [],
            productTypes: [],
            styles: [],
            categories: [],
            colors: [],
            materials: [],
          },
        }}
      />,
    );
    for (const label of ["款式", "类型", "风格", "品类", "色款", "材质"]) {
      expect(
        within(screen.getByRole("region", { name: label })).getByText(
          "暂无有来源支持的趋势",
        ),
      ).toBeVisible();
    }
    expect(screen.getByText("暂无有来源支持的市场信号")).toBeVisible();
    expect(screen.getByText("暂无有来源支持的参考款")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
