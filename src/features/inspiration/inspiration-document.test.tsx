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
import type { WebEvidenceAssetDto } from "@/features/inspiration-visuals/contracts";
import { composeInspirationDocument } from "@/features/inspiration-visuals/document-composer";
import {
  generatedConceptAssetFixture,
  libraryMatchAssetFixture,
  visualBoardFixture,
  webEvidenceAssetFixture,
  webHeroAssetFixture,
  webProductAssetFixture,
} from "@/features/inspiration-visuals/test-fixtures";
import { EvidenceImage } from "./inspiration-evidence-dialog";
import { InspirationDocument } from "./inspiration-document";
import { InspirationVisualStatus } from "./inspiration-visual-status";
import {
  inspirationResultFixture as result,
  inspirationSourceFixture as source,
} from "./test-fixtures";

const evidence = (index: number) => ({
  ...webEvidenceAssetFixture,
  id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
  title: `证据 ${index}`,
  altText: `证据图片 ${index}`,
  ordinal: index,
  imageUrl: `/api/inspiration-visual-assets/00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
});
const compose = (
  webEvidence: WebEvidenceAssetDto[] = [
    webHeroAssetFixture,
    webEvidenceAssetFixture,
    webProductAssetFixture,
  ],
) => composeInspirationDocument({ result, sources: [source], webEvidence });
afterEach(cleanup);

describe("continuous inspiration document", () => {
  it("keeps header, hero, conclusion, signals, all six dimensions, products, directions and sources in reading order", () => {
    render(
      <InspirationDocument
        document={compose()}
        title="研究标题"
        prompt="研究需求"
      />,
    );
    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual([
      "研究标题",
      "都市轻通勤的柔和层次",
      "市场信号",
      "轻通勤",
      "款式",
      "类型",
      "风格",
      "品类",
      "色款",
      "材质",
      "商品参考",
      "设计灵感 · 设计推演",
      "柔和通勤",
      "轻盈叠穿",
      "简约日常",
      "研究来源",
    ]);
    const hero = screen.getByRole("region", { name: "主视觉" });
    expect(
      screen
        .getByRole("heading", { name: "研究标题" })
        .compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      hero.compareDocumentPosition(
        screen.getByRole("heading", { name: result.headline }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it.each([1, 4, 8])(
    "renders %i web images once each with stable attribution and authenticated paths",
    (count) => {
      const assets = Array.from({ length: count }, (_, index) =>
        evidence(index),
      );
      render(
        <InspirationDocument
          document={compose(assets)}
          title="研究"
          prompt="需求"
        />,
      );
      expect(screen.getAllByRole("img")).toHaveLength(count);
      expect(
        screen.getAllByRole("link", { name: "打开原始页面" }),
      ).toHaveLength(count);
      for (const asset of assets) {
        const image = screen.getByRole("img", { name: asset.altText });
        expect(image).toHaveAttribute("src", asset.imageUrl);
        expect(image).toHaveAttribute("width", "1200");
        expect(image).toHaveAttribute("height", "1600");
        expect(image).toHaveAttribute("loading", "lazy");
        expect(image).toHaveAttribute("decoding", "async");
        expect(image.closest("figure")).toHaveTextContent(asset.title);
        expect(image.closest("figure")).toHaveTextContent(asset.sourceSiteName);
      }
    },
  );

  it("keeps hero, evidence and products in their own sections and omits null prices", () => {
    const product = { ...webProductAssetFixture, priceText: null, brand: null };
    render(
      <InspirationDocument
        document={compose([
          webHeroAssetFixture,
          webEvidenceAssetFixture,
          product,
        ])}
        title="研究"
        prompt="需求"
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "主视觉" })).getAllByRole(
        "img",
      ),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "市场信号" })).getAllByRole(
        "img",
      ),
    ).toHaveLength(1);
    const products = screen.getByRole("region", { name: "商品参考" });
    expect(within(products).getAllByRole("img")).toHaveLength(1);
    expect(
      within(products).getByRole("link", { name: "示例时尚站 · 查看商品" }),
    ).toBeVisible();
    expect(products).not.toHaveTextContent("¥");
    expect(products).not.toHaveTextContent("null");
  });

  it("renders known product prices and hardens every external link", () => {
    render(
      <InspirationDocument document={compose()} title="研究" prompt="需求" />,
    );
    expect(screen.getByText("¥299")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Melon · 查看商品" }),
    ).toBeVisible();
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("preserves title, source and original link when an image fails without changing the media ratio", () => {
    render(
      <InspirationDocument
        document={compose([webHeroAssetFixture])}
        title="研究"
        prompt="需求"
      />,
    );
    const image = screen.getByRole("img");
    const media = image.parentElement!;
    const ratio = media.style.aspectRatio;
    expect(ratio).toBe("1200 / 1600");
    fireEvent.error(image);
    expect(media.style.aspectRatio).toBe(ratio);
    expect(screen.getByText("图片暂时无法显示")).toBeVisible();
    expect(screen.getByText(webHeroAssetFixture.title)).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "主视觉" })).getByText(
        "示例时尚站",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "打开原始页面" })).toHaveAttribute(
      "href",
      webHeroAssetFixture.sourcePageUrl,
    );
  });

  it("opens a named evidence dialog by keyboard, traps focus, closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(
      <InspirationDocument
        document={compose([webHeroAssetFixture])}
        title="研究"
        prompt="需求"
      />,
    );
    const trigger = screen.getByRole("button", {
      name: `预览：${webHeroAssetFixture.title}`,
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", {
      name: webHeroAssetFixture.title,
    });
    expect(within(dialog).getByText("示例时尚站")).toBeVisible();
    expect(
      within(dialog).getByRole("link", { name: "打开原始页面" }),
    ).toHaveAttribute("href", webHeroAssetFixture.sourcePageUrl);
    const close = within(dialog).getByRole("button", { name: "关闭预览" });
    close.focus();
    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("link", { name: "打开原始页面" }),
    ).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps signal text before its visual evidence in DOM reading order", () => {
    render(
      <InspirationDocument
        document={compose([webEvidenceAssetFixture])}
        title="研究"
        prompt="需求"
      />,
    );
    const text = screen.getByRole("heading", { name: "轻通勤" });
    expect(
      text.compareDocumentPosition(screen.getByRole("img")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("uses human-readable source labels instead of structured metadata", () => {
    const document = composeInspirationDocument({
      result,
      sources: [
        { ...source, title: '{"title":"raw metadata"}', siteName: "来源站点" },
      ],
    });
    render(
      <InspirationDocument document={document} title="研究" prompt="需求" />,
    );
    expect(screen.queryByText(/raw metadata/)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "研究来源" })).getByRole(
        "link",
        { name: "[1] 来源站点" },
      ),
    ).toBeVisible();
  });

  it("keeps private library matches within their direction or private supplement", () => {
    const document = composeInspirationDocument({
      result,
      sources: [source],
      libraryMatches: [
        { ...libraryMatchAssetFixture, directionIndex: 0 },
        {
          ...libraryMatchAssetFixture,
          id: evidence(8).id,
          title: "未分配素材",
        },
      ],
      concepts: [generatedConceptAssetFixture],
    });
    render(
      <InspirationDocument document={document} title="研究" prompt="需求" />,
    );
    const direction = screen.getByRole("region", { name: "柔和通勤" });
    expect(
      within(direction).getByRole("link", { name: /雨后花园/ }),
    ).toHaveAttribute("href", libraryMatchAssetFixture.libraryHref);
    expect(
      within(screen.getByRole("region", { name: "私有素材补充" })).getByText(
        "未分配素材",
      ),
    ).toBeVisible();
    expect(screen.getAllByText("雨后花园")).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "研究来源" }),
    ).not.toHaveTextContent("雨后花园");
  });

  it("keeps text and a local refresh action with zero images", async () => {
    const refresh = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <InspirationVisualStatus
          board={{
            ...visualBoardFixture,
            activeJob: null,
            webEvidence: [],
            libraryMatches: [],
            concepts: [],
          }}
          onRefresh={refresh}
        />
        <InspirationDocument
          document={compose([])}
          title="研究"
          prompt="需求"
        />
      </>,
    );
    expect(screen.getByText(result.summary)).toBeVisible();
    expect(screen.getByText("棉麻混纺", { selector: "strong" })).toBeVisible();
    expect(
      screen.getByText(result.inspirationPrompts[0]!.direction),
    ).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "补充视觉素材" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("image errors before hydration", () => {
  it("recovers an already failed image at mount and tries a replacement URL", () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    const width = vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    try {
      const { rerender } = render(<EvidenceImage asset={webHeroAssetFixture} eager />);
      expect(screen.getByText("图片暂时无法显示")).toBeVisible();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      complete.mockReturnValue(false);
      rerender(<EvidenceImage asset={{ ...webHeroAssetFixture, imageUrl: "/api/inspiration-visual-assets/replacement" }} eager />);
      expect(screen.queryByText("图片暂时无法显示")).not.toBeInTheDocument();
      expect(screen.getByRole("img")).toHaveAttribute("src", "/api/inspiration-visual-assets/replacement");
    } finally {
      complete.mockRestore();
      width.mockRestore();
    }
  });
});
