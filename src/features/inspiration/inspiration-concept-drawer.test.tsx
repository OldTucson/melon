import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspirationResultFixture } from "./test-fixtures";
import {
  webEvidenceAssetFixture,
  webHeroAssetFixture,
  webProductAssetFixture,
  visualJobFixture,
} from "@/features/inspiration-visuals/test-fixtures";
import { InspirationConceptDrawer } from "./inspiration-concept-drawer";

const props = {
  direction: inspirationResultFixture.inspirationPrompts[0]!,
  directionIndex: 0,
  activeVisualJobId: visualJobFixture.id,
  assets: [
    webHeroAssetFixture,
    webEvidenceAssetFixture,
    webProductAssetFixture,
  ],
  available: true,
  onGenerate: vi.fn(),
};
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "生成整套成图" }));
  return screen.getByRole("dialog", { name: "生成整套成图" });
};

describe("concept confirmation drawer", () => {
  it("hides paid actions when unavailable and disables creation for direction limits", () => {
    const { rerender } = render(
      <InspirationConceptDrawer {...props} available={false} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(
      <InspirationConceptDrawer
        {...props}
        disabledReason="当前方向已有方案正在生成"
      />,
    );
    expect(screen.getByRole("button", { name: "生成整套成图" })).toBeDisabled();
    expect(screen.getByText("当前方向已有方案正在生成")).toBeVisible();
    rerender(
      <InspirationConceptDrawer
        {...props}
        disabledReason="已保留 3 个方案，请先删除一个"
      />,
    );
    expect(screen.getByRole("button", { name: "生成整套成图" })).toBeDisabled();
  });

  it("shows direction and three ranked external references; deselection survives rerenders and submits IDs", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InspirationConceptDrawer
        {...props}
        assets={[
          ...props.assets,
          {
            ...webEvidenceAssetFixture,
            id: "00000000-0000-4000-8000-000000000199",
            sourceIndexes: [],
            title: "其他参考",
          },
        ]}
      />,
    );
    const dialog = await open(user);
    expect(within(dialog).getByText(props.direction.direction)).toBeVisible();
    expect(
      within(dialog).getByText("将生成 3 张 AI 图片，预计费用以百炼账单为准"),
    ).toBeVisible();
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    boxes.forEach((box) => expect(box).toBeChecked());
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: `参考：${webEvidenceAssetFixture.title}`,
      }),
    );
    rerender(
      <InspirationConceptDrawer {...props} assets={[...props.assets]} />,
    );
    expect(
      within(dialog).getByRole("checkbox", {
        name: `参考：${webEvidenceAssetFixture.title}`,
      }),
    ).not.toBeChecked();
    expect(within(dialog).getByText("已选 2 / 3")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "生成整套成图" }),
    );
    expect(props.onGenerate).toHaveBeenCalledWith({
      operationId: expect.any(String),
      directionIndex: 0,
      visualJobId: visualJobFixture.id,
      referenceAssetIds: [webProductAssetFixture.id, webHeroAssetFixture.id],
    });
  });

  it("allows zero references without attaching a visual job", async () => {
    const user = userEvent.setup();
    render(<InspirationConceptDrawer {...props} />);
    const dialog = await open(user);
    for (const box of within(dialog).getAllByRole("checkbox"))
      await user.click(box);
    expect(within(dialog).getByText("已选 0 / 3")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "生成整套成图" }),
    );
    expect(props.onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ visualJobId: null, referenceAssetIds: [] }),
    );
  });

  it("does not offer references without a completed visual job and resets selections on job changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InspirationConceptDrawer {...props} activeVisualJobId={null} />,
    );
    const dialog = await open(user);
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    rerender(<InspirationConceptDrawer {...props} />);
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3);
  });

  it("supports keyboard checkboxes, traps focus, escapes and returns focus; reopening resets defaults", async () => {
    const user = userEvent.setup();
    render(<InspirationConceptDrawer {...props} />);
    const trigger = screen.getByRole("button", { name: "生成整套成图" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog");
    const checkbox = within(dialog).getAllByRole("checkbox")[0]!;
    checkbox.focus();
    await user.keyboard(" ");
    expect(checkbox).not.toBeChecked();
    const close = within(dialog).getByRole("button", { name: "关闭生成面板" });
    close.focus();
    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("button", { name: "生成整套成图" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard("{Enter}");
    screen.getAllByRole("checkbox").forEach((box) => expect(box).toBeChecked());
  });
});
