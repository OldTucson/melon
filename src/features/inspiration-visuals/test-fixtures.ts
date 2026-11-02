export const visualJobFixture = {
  id: "00000000-0000-4000-8000-000000000101",
  kind: "research_visuals" as const,
  directionIndex: null,
  status: "completed" as const,
  errorCode: null,
  warnings: [],
  createdAt: "2026-10-29T01:00:00.000Z",
  completedAt: "2026-10-29T01:01:00.000Z",
};

export const webEvidenceAssetFixture = {
  id: "00000000-0000-4000-8000-000000000102",
  kind: "web_evidence" as const,
  role: "evidence" as const,
  sourceIndexes: [1],
  brand: null,
  productName: null,
  priceText: null,
  ordinal: 0,
  title: "轻盈通勤叠穿",
  altText: "米白色轻盈通勤女装叠穿参考",
  imageUrl:
    "/api/inspiration-visual-assets/00000000-0000-4000-8000-000000000102",
  sourcePageUrl: "https://example.test/fashion/layering?season=autumn",
  sourceSiteName: "示例时尚站",
  sourceQuery: "都市轻通勤 女装 叠穿",
  width: 1200,
  height: 1600,
};

export const webHeroAssetFixture = {
  ...webEvidenceAssetFixture,
  id: "00000000-0000-4000-8000-000000000107",
  role: "hero" as const,
  title: "轻通勤灵感主视觉",
  imageUrl:
    "/api/inspiration-visual-assets/00000000-0000-4000-8000-000000000107",
};

export const webProductAssetFixture = {
  ...webEvidenceAssetFixture,
  id: "00000000-0000-4000-8000-000000000108",
  role: "product" as const,
  title: "棉麻通勤衬衫",
  imageUrl:
    "/api/inspiration-visual-assets/00000000-0000-4000-8000-000000000108",
  brand: "Melon",
  productName: "棉麻通勤衬衫",
  priceText: "¥299",
};

export const libraryMatchAssetFixture = {
  id: "00000000-0000-4000-8000-000000000103",
  kind: "library_match" as const,
  ordinal: 0,
  directionIndex: null,
  title: "雨后花园",
  altText: "绿色植物图案",
  imageUrl: "/api/assets/00000000-0000-4000-8000-000000000104/view",
  libraryHref: "/library?selected=00000000-0000-4000-8000-000000000105",
  patternId: "00000000-0000-4000-8000-000000000105",
  palette: ["#66805E", "#D7D1BD"],
};

export const generatedConceptAssetFixture = {
  id: "00000000-0000-4000-8000-000000000106",
  kind: "generated_concept" as const,
  ordinal: 0,
  directionIndex: 0,
  title: "柔和通勤概念图",
  altText: "AI 生成的柔和通勤女装概念图",
  imageUrl:
    "/api/inspiration-visual-assets/00000000-0000-4000-8000-000000000106",
  width: 1536,
  height: 2048,
  savedPatternId: null,
  libraryHref: null,
};

export const visualBoardFixture = {
  refreshAvailable: true,
  conceptGenerationAvailable: false,
  conceptSets: [],
  activeJob: visualJobFixture,
  refreshJob: null,
  webEvidence: [webEvidenceAssetFixture],
  libraryMatches: [libraryMatchAssetFixture],
  conceptJobs: [],
  concepts: [generatedConceptAssetFixture],
};
