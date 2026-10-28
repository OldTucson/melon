import type {
  InspirationAnalysisResult,
  InspirationDetailDto,
  InspirationSource,
  InspirationSummaryDto,
  TrendFacet,
} from "./contracts";

export const inspirationSourceFixture: InspirationSource = {
  index: 1,
  title: "都市轻通勤女装趋势",
  url: "https://example.test/fashion/commuting",
  siteName: "示例时尚站",
};

const facet: TrendFacet = {
  name: "轻通勤",
  rationale: "公开商品与趋势内容重复出现轻便通勤设计。",
  strength: "high",
  sourceIndexes: [1],
};

export const inspirationResultFixture: InspirationAnalysisResult = {
  schemaVersion: "inspiration-analysis-v1",
  headline: "都市轻通勤的柔和层次",
  summary: "公开网络信号指向轻盈面料与宽松层次的通勤女装。",
  confidenceNote: "基于公开网络热销信号，不代表电商平台官方销量。",
  marketSignals: [{ ...facet }],
  dimensions: {
    silhouettes: [{ ...facet, name: "宽松直线廓形" }],
    productTypes: [{ ...facet, name: "轻薄叠穿" }],
    styles: [{ ...facet, name: "都市简约" }],
    categories: [{ ...facet, name: "衬衫" }],
    colors: [{ ...facet, name: "柔和米白", colorHint: "#EEE8DA" }],
    materials: [{ ...facet, name: "棉麻混纺" }],
  },
  referenceLooks: [{
    name: "棉麻衬衫叠穿",
    sourceKind: "product",
    whyRelevant: "展示轻盈面料和宽松轮廓的日常通勤组合。",
    sourceIndexes: [1],
  }],
  inspirationPrompts: [
    { title: "柔和通勤", direction: "设计推演：以柔和色调表达都市轻通勤。", silhouette: "宽松直线", palette: ["米白", "浅灰"], materials: ["棉麻混纺"], details: ["隐藏门襟"], sourceIndexes: [1] },
    { title: "轻盈叠穿", direction: "设计推演：探索轻薄层次的组合方式。", silhouette: "短外搭配长内衬", palette: ["米白", "浅蓝"], materials: ["薄棉"], details: ["可调袖口"], sourceIndexes: [1] },
    { title: "简约日常", direction: "设计推演：将都市简约转化为日常单品。", silhouette: "直筒衬衫", palette: ["米白"], materials: ["棉麻混纺"], details: ["侧开衩"], sourceIndexes: [] },
  ],
};

export const inspirationSummaryFixture: InspirationSummaryDto = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "都市轻通勤女装研究",
  prompt: "分析近 30 天都市轻通勤女装",
  status: "completed",
  version: 1,
  createdAt: "2026-10-28T01:00:00.000Z",
  updatedAt: "2026-10-28T02:00:00.000Z",
  completedAt: "2026-10-28T02:00:00.000Z",
  errorCode: null,
  shareUrl: null,
};

export const inspirationDetailFixture: InspirationDetailDto = {
  ...inspirationSummaryFixture,
  sources: [inspirationSourceFixture],
  result: inspirationResultFixture,
};
