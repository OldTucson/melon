import type { ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { composePublicInspirationDocument } from "@/features/inspiration-visuals/document-composer";
import type { InspirationSharedDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import { generatedConceptAssetFixture, libraryMatchAssetFixture, webEvidenceAssetFixture, webHeroAssetFixture, webProductAssetFixture } from "@/features/inspiration-visuals/test-fixtures";
import { InspirationDocument } from "./inspiration-document";
import { SharedInspirationPage } from "./shared-inspiration-page";
import { inspirationResultFixture, inspirationSourceFixture } from "./test-fixtures";
import { conceptAssetFixture, conceptSetFixture } from "@/features/inspiration-concepts/test-fixtures";

const shareId = "00000000-0000-4000-8000-000000000009";
const analysis: InspirationSharedDocumentDto = {
  title: "都市轻通勤女装研究",
  prompt: "分析近 30 天都市轻通勤女装",
  completedAt: "2026-10-28T02:00:00.000Z",
  document: composePublicInspirationDocument({
    shareId, sources: [inspirationSourceFixture],
    result: { ...inspirationResultFixture, confidenceNote: "公开信息覆盖有限，请结合实际调研。" },
    webEvidence: [webHeroAssetFixture, webEvidenceAssetFixture, webProductAssetFixture],
  }),
};
afterEach(cleanup);

describe("public inspiration report", () => {
  it("renders completed set outputs in their direction using only shared resources and AI labels", () => {
    const document = composePublicInspirationDocument({ shareId, sources: [inspirationSourceFixture], result: inspirationResultFixture,
      conceptSets: [{ id: conceptSetFixture.id, directionIndex: 0, version: 2, createdAt: conceptSetFixture.createdAt, outputs: [conceptAssetFixture] }] });
    const { container } = render(<SharedInspirationPage analysis={{ ...analysis, document }} />);
    const direction = screen.getByRole("region", { name: "柔和通勤" });
    expect(within(direction).getByRole("img")).toHaveAttribute("src", `/share/inspiration/${shareId}/assets/${conceptAssetFixture.id}`);
    expect(within(direction).getByText("AI 生成")).toBeVisible();
    expect(within(direction).getAllByRole("figure")).toHaveLength(1);
    expect(container.querySelector('img[src^="/api/"], form')).toBeNull();
    for (const name of [/生成整套/, /重试/, /方案操作/, /删除/]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/errorCode|provider|oss|operationId|等待草图/);
  });

  it("renders the continuous editorial document and attributed share-local hero, evidence and products", () => {
    render(<SharedInspirationPage analysis={analysis} />);
    expect(screen.getByRole("main")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: analysis.title })).toBeVisible();
    expect(screen.getByText(analysis.prompt)).toBeVisible();
    expect(screen.getByText("2026-10-28")).toHaveAttribute("datetime", analysis.completedAt);
    for (const name of ["款式", "类型", "风格", "品类", "色款", "材质", "市场信号", "商品参考", "设计灵感", "研究来源"]) {
      expect(screen.getByRole("region", { name })).toBeVisible();
    }
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    for (const [section, asset] of [["主视觉", webHeroAssetFixture], ["市场信号", webEvidenceAssetFixture], ["商品参考", webProductAssetFixture]] as const) {
      expect(within(screen.getByRole("region", { name: section })).getByRole("img")).toHaveAttribute("src", `/share/inspiration/${shareId}/assets/${asset.id}`);
    }
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(screen.getByText("基于公开网络热销信号，不代表电商平台官方销量")).toBeVisible();
    expect(screen.getByText("公开信息覆盖有限，请结合实际调研。")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "研究来源" })).getByRole("link", { name: /都市轻通勤女装趋势/ })).toHaveAttribute("href", "https://example.test/fashion/commuting");
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAccessibleName(/^预览：/);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("never renders private matches, saved-library links, owner metadata or visual job controls", () => {
    const privateFields = { ownerId: "private-owner", email: "private-owner@example.test", errorCode: "private-failure", warnings: ["private-warning"], refreshJob: { status: "pending", id: "private-job" } };
    const document = {
      ...analysis.document,
      unassignedLibraryMatches: [libraryMatchAssetFixture],
      directions: analysis.document.directions.map((entry, index) => ({ ...entry,
        libraryMatches: [{ ...libraryMatchAssetFixture, directionIndex: index }],
      })),
    };
    // A structurally over-wide record must not turn public rendering into the private workspace.
    const { container } = render(<SharedInspirationPage analysis={{ ...analysis, ...privateFields, document } as unknown as InspirationSharedDocumentDto} />);
    for (const text of ["private-owner", "private-failure", "private-warning", "private-job", "雨后花园", "仅自己可见", "补充视觉素材", "刷新视觉素材", "正在补充", "查看已保存素材"]) expect(container.innerHTML).not.toContain(text);
    expect(container.querySelector('a[href^="/library"], img[src^="/api/"], form')).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAccessibleName(/^预览：/);
  });

  it("renders public concepts without reading any private saved-pattern fields or header actions", () => {
    const document = composePublicInspirationDocument({ shareId, sources: [inspirationSourceFixture], result: inspirationResultFixture, concepts: [generatedConceptAssetFixture] });
    const concept = document.directions[0]!.concepts[0]!;
    Object.defineProperties(concept, {
      savedPatternId: { get() { throw new Error("private field read"); } },
      libraryHref: { get() { throw new Error("private field read"); } },
    });
    const props = { mode: "public", document, title: "公开研究", prompt: "需求", headerActions: <button>刷新视觉素材</button> } as unknown as ComponentProps<typeof InspirationDocument>;
    render(<InspirationDocument {...props} />);
    expect(screen.getByRole("img", { name: concept.altText })).toHaveAttribute("src", `/share/inspiration/${shareId}/assets/${concept.id}`);
    expect(screen.queryByText("查看已保存素材")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps text-only reports readable and treats prompts and result text as plain text", () => {
    const text = '<script>alert("inspiration")</script>';
    const document = composePublicInspirationDocument({ shareId, sources: [inspirationSourceFixture], result: { ...inspirationResultFixture, summary: '<img src=x onerror="alert(1)">' } });
    const { container } = render(<SharedInspirationPage analysis={{ ...analysis, prompt: text, document }} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeVisible();
    expect(container.querySelector("script, img, button, form")).toBeNull();
  });
});
