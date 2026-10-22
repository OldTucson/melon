import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaletteSwatches } from "./palette-swatches";

const colors = [
  { hex: "#285947", coverage: 0.5 },
  { hex: "#CC9C3F", coverage: 0.3 },
  { hex: "#8F4038", coverage: 0.2 },
] as const;

afterEach(cleanup);

describe("PaletteSwatches", () => {
  it("renders ready colors as native buttons in coverage order", () => {
    render(
      <PaletteSwatches
        colors={colors}
        interactive
        selectedColors={new Set(["#CC9C3F"])}
        size="compact"
        status="ready"
        onToggle={vi.fn()}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "按颜色 #285947 搜索",
      "按颜色 #CC9C3F 搜索",
      "按颜色 #8F4038 搜索",
    ]);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "false");
    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
  });

  it("renders five stable placeholders while extraction is pending", () => {
    const { container } = render(
      <PaletteSwatches
        colors={[]}
        interactive={false}
        size="compact"
        status="pending"
      />,
    );

    expect(container.querySelectorAll("[data-palette-placeholder]")).toHaveLength(
      5,
    );
    expect(screen.getByLabelText("正在提取主色")).toBeVisible();
  });

  it("renders five disabled failed segments with a title explanation", () => {
    render(
      <PaletteSwatches
        colors={[]}
        interactive
        size="compact"
        status="failed"
      />,
    );

    const failed = screen.getAllByRole("button", { name: "主色提取失败" });
    expect(failed).toHaveLength(5);
    for (const segment of failed) {
      expect(segment).toBeDisabled();
      expect(segment).toHaveAttribute("title", "主色提取失败");
    }
  });

  it("shows HEX and rounded coverage in detail mode", () => {
    render(
      <PaletteSwatches
        colors={colors}
        interactive={false}
        size="detail"
        status="ready"
      />,
    );

    expect(screen.getByText("#285947")).toBeVisible();
    expect(screen.getByText("50%")).toBeVisible();
    expect(screen.getByLabelText("#285947，覆盖率 50%")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("toggles by pointer and keyboard without bubbling activation", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const parentClick = vi.fn();
    const parentPointerDown = vi.fn();
    const parentKeyDown = vi.fn();
    render(
      <div
        onClick={parentClick}
        onKeyDown={parentKeyDown}
        onPointerDown={parentPointerDown}
      >
        <PaletteSwatches
          colors={colors}
          interactive
          size="compact"
          status="ready"
          onToggle={onToggle}
        />
      </div>,
    );
    const button = screen.getByRole("button", {
      name: "按颜色 #285947 搜索",
    });

    fireEvent.pointerDown(button);
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");

    expect(onToggle).toHaveBeenNthCalledWith(1, "#285947");
    expect(onToggle).toHaveBeenNthCalledWith(2, "#285947");
    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });
});
