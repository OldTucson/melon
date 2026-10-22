import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaletteQueryBar } from "./palette-query-bar";

afterEach(cleanup);

function renderBar(
  overrides: Partial<React.ComponentProps<typeof PaletteQueryBar>> = {},
) {
  const props: React.ComponentProps<typeof PaletteQueryBar> = {
    busy: false,
    colors: ["#285947", "#CC9C3F"],
    error: null,
    limitMessage: null,
    onClear: vi.fn(),
    onRemove: vi.fn(),
    resultCount: 7,
    ...overrides,
  };
  render(
    <Tooltip.Provider>
      <PaletteQueryBar {...props} />
    </Tooltip.Provider>,
  );
  return props;
}

describe("PaletteQueryBar", () => {
  it("shows selected color swatches, result status, removal, and clear controls", async () => {
    const user = userEvent.setup();
    const props = renderBar({ limitMessage: "最多选择 5 个颜色" });

    expect(screen.getByRole("heading", { name: "配色搜索" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("7 个结果");
    expect(screen.getByText("最多选择 5 个颜色")).toHaveAttribute(
      "aria-live",
      "polite",
    );

    await user.click(screen.getByRole("button", { name: "移除颜色 #285947" }));
    expect(props.onRemove).toHaveBeenCalledWith("#285947");
    await user.click(screen.getByRole("button", { name: "清除配色" }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("announces progress and an inline rerun error", () => {
    renderBar({
      busy: true,
      error: "配色搜索失败，请检查网络后重试",
    });

    expect(screen.getByRole("status")).toHaveTextContent("正在更新结果");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "配色搜索失败，请检查网络后重试",
    );
  });
});
