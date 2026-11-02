import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConceptSetDto } from "@/features/inspiration-concepts/contracts";
import {
  conceptAssetFixture,
  conceptSetFixture,
} from "@/features/inspiration-concepts/test-fixtures";
import { InspirationConceptSection } from "./inspiration-concept-section";

const actions = {
  available: true,
  onRetry: vi.fn(),
  onRegenerate: vi.fn(),
  onDelete: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("direction concept results", () => {
  it("keeps exactly three dimension-aware slots with failed and waiting states beside a successful image", () => {
    render(
      <InspirationConceptSection sets={[conceptSetFixture]} {...actions} />,
    );
    for (const label of ["设计草图", "服装效果图", "服装款式图"])
      expect(screen.getByText(label)).toBeVisible();
    const figures = screen.getAllByRole("figure");
    expect(figures).toHaveLength(3);
    expect(
      figures.map(
        (node) =>
          (node.querySelector("[data-concept-media]") as HTMLElement).style
            .aspectRatio,
      ),
    ).toEqual(["3 / 4", "3 / 4", "4 / 3"]);
    expect(
      screen.getByRole("img", { name: conceptAssetFixture.altText }),
    ).toHaveAttribute("src", conceptAssetFixture.imageUrl);
    expect(screen.getByText("AI 生成")).toBeVisible();
    expect(screen.getByText("生成失败")).toBeVisible();
    expect(screen.getByText("等待草图完成")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "重试服装效果图" }),
    ).toBeEnabled();
  });

  it("orders version tabs descending and supports keyboard switching", async () => {
    const user = userEvent.setup();
    render(
      <InspirationConceptSection
        {...actions}
        sets={[
          conceptSetFixture,
          {
            ...conceptSetFixture,
            id: "00000000-0000-4000-8000-000000000013",
            version: 3,
          },
        ]}
      />,
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "方案 03",
      "方案 01",
    ]);
    const latest = screen.getByRole("tab", { name: "方案 03" });
    expect(latest).toHaveAttribute("aria-selected", "true");
    latest.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "方案 01" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("retries derivatives independently while preserving the image and fixed layout during generation", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InspirationConceptSection sets={[conceptSetFixture]} {...actions} />,
    );
    await user.click(screen.getByRole("button", { name: "重试服装效果图" }));
    expect(actions.onRetry).toHaveBeenCalledWith(
      conceptSetFixture.id,
      "effect",
    );
    const set: ConceptSetDto = {
      ...conceptSetFixture,
      status: "generating",
      slots: [
        conceptSetFixture.slots[0],
        {
          kind: "effect",
          asset: {
            ...conceptAssetFixture,
            kind: "effect",
            id: "00000000-0000-4000-8000-000000000014",
            altText: "当前效果图",
          },
          task: { status: "generating", errorCode: null },
        },
        {
          kind: "flat",
          asset: null,
          task: { status: "queued", errorCode: null },
        },
      ],
    };
    rerender(<InspirationConceptSection sets={[set]} {...actions} />);
    expect(screen.getByRole("img", { name: "当前效果图" })).toBeVisible();
    expect(
      screen.getByRole("img", { name: conceptAssetFixture.altText }),
    ).toBeVisible();
    expect(screen.getByText("正在重新生成")).toBeVisible();
    expect(screen.getByText("排队中")).toBeVisible();
    expect(screen.getAllByRole("figure")).toHaveLength(3);
  });

  it("requires explicit confirmation that sketch regeneration creates a new version", async () => {
    const user = userEvent.setup();
    render(
      <InspirationConceptSection sets={[conceptSetFixture]} {...actions} />,
    );
    await user.click(screen.getByRole("button", { name: "方案操作" }));
    await user.click(
      screen.getByRole("menuitem", { name: "重新生成草图（新方案）" }),
    );
    const dialog = screen.getByRole("dialog", { name: "重新生成草图？" });
    expect(dialog).toHaveTextContent("将创建新方案");
    expect(dialog).toHaveTextContent("当前方案将保留");
    expect(actions.onRegenerate).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "确认生成新方案" }),
    );
    expect(actions.onRegenerate).toHaveBeenCalledWith(conceptSetFixture.id);
  });

  it("hides paid controls when disabled but keeps history, preview and delete", async () => {
    const user = userEvent.setup();
    render(
      <InspirationConceptSection
        sets={[conceptSetFixture]}
        {...actions}
        available={false}
      />,
    );
    expect(screen.getByRole("img")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /重试/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "方案操作" }));
    expect(
      screen.queryByRole("menuitem", { name: /重新生成/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "删除方案" }));
    expect(actions.onDelete).toHaveBeenCalledWith(conceptSetFixture.id);
  });

  it("closes an open regeneration confirmation when availability changes and never submits its stale button", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InspirationConceptSection sets={[conceptSetFixture]} {...actions} />,
    );
    const trigger = screen.getByRole("button", { name: "方案操作" });
    await user.click(trigger);
    await user.click(
      screen.getByRole("menuitem", { name: "重新生成草图（新方案）" }),
    );
    const confirm = screen.getByRole("button", { name: "确认生成新方案" });
    expect(confirm).toBeEnabled();
    rerender(
      <InspirationConceptSection
        sets={[conceptSetFixture]}
        {...actions}
        available={false}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(confirm);
    expect(actions.onRegenerate).not.toHaveBeenCalled();
    rerender(
      <InspirationConceptSection sets={[conceptSetFixture]} {...actions} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("previews with download, media failure fallback, trapped focus and Escape return", async () => {
    const user = userEvent.setup();
    render(
      <InspirationConceptSection sets={[conceptSetFixture]} {...actions} />,
    );
    const trigger = screen.getByRole("button", {
      name: `预览：${conceptAssetFixture.title}`,
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", {
      name: conceptAssetFixture.title,
    });
    expect(
      within(dialog).getByRole("link", { name: "下载图片" }),
    ).toHaveAttribute(
      "href",
      `/api/inspiration-concept-assets/${conceptAssetFixture.id}/download`,
    );
    expect(within(dialog).getByText("AI 生成")).toBeVisible();
    fireEvent.error(within(dialog).getByRole("img"));
    expect(within(dialog).getByText("图片暂时无法显示")).toBeVisible();
    const close = within(dialog).getByRole("button", { name: "关闭预览" });
    close.focus();
    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("link", { name: "下载图片" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("renders only completed public outputs with share-local downloads and no private actions", async () => {
    const user = userEvent.setup();
    const url = `/share/inspiration/00000000-0000-4000-8000-000000000009/assets/${conceptAssetFixture.id}`;
    render(
      <InspirationConceptSection
        mode="public"
        sets={[
          {
            id: conceptSetFixture.id,
            directionIndex: 0,
            version: 1,
            outputs: [{ ...conceptAssetFixture, imageUrl: url }],
            createdAt: conceptSetFixture.createdAt,
          },
        ]}
      />,
    );
    expect(screen.getAllByRole("figure")).toHaveLength(1);
    expect(screen.getByText("AI 生成")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "方案操作" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("等待草图完成")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: `预览：${conceptAssetFixture.title}`,
      }),
    );
    expect(screen.getByRole("link", { name: "下载图片" })).toHaveAttribute(
      "href",
      url,
    );
  });
});
