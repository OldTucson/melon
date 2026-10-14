import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RevenueTrend } from "./revenue-trend";

afterEach(() => cleanup());

describe("revenue trend", () => {
  it("renders a visual chart with a keyboard-readable table of identical values", () => {
    render(
      <RevenueTrend
        rows={[
          { bucket: "2026-01-01", revenueFen: "128000", count: 2 },
          { bucket: "2026-02-01", revenueFen: "0", count: 1 },
        ]}
      />,
    );

    expect(
      screen.getByRole("figure", { name: "收入趋势" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("revenue-line-chart")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "收入趋势数据" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveAttribute("tabindex", "0");
    expect(rows[1]).toHaveTextContent("2026-01-01");
    expect(rows[1]).toHaveTextContent("¥1,280.00");
    expect(rows[1]).toHaveTextContent("2");
    expect(rows[2]).toHaveTextContent("¥0.00");
  });

  it("does not fabricate a line or table rows when there is no trend data", () => {
    render(<RevenueTrend rows={[]} />);

    expect(screen.getByText("所选期间暂无授权收入")).toBeInTheDocument();
    expect(screen.queryByTestId("revenue-line-chart")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("table", { name: "收入趋势数据" }),
    ).not.toBeInTheDocument();
  });

  it("keeps exact large integer values in the table when chart conversion is unsafe", () => {
    render(
      <RevenueTrend
        rows={[
          {
            bucket: "2026-01-01",
            revenueFen: "900719925474099200",
            count: 1,
          },
        ]}
      />,
    );

    expect(screen.getByText("¥9,007,199,254,740,992.00")).toBeInTheDocument();
    expect(screen.queryByTestId("revenue-line-chart")).not.toBeInTheDocument();
    expect(screen.getByText("图形数值超出安全显示范围")).toBeInTheDocument();
  });
});
