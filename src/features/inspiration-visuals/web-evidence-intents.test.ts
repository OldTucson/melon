import { describe, expect, it } from "vitest";

import type {
  InspirationAnalysisResult,
  InspirationSource,
  TrendFacet,
} from "@/features/inspiration/contracts";
import { inspirationResultFixture } from "@/features/inspiration/test-fixtures";

import {
  classifyWebEvidenceCandidates,
  planWebEvidenceIntents,
  type WebEvidenceCandidate,
  type WebEvidenceIntent,
} from "./web-evidence-intents";

const sources: InspirationSource[] = [
  { index: 7, title: "Signal", url: "https://journal.test/trend?season=fall", siteName: "Journal" },
  { index: 2, title: "Shirt", url: "https://shop.test/item?sku=shirt", siteName: "Shop" },
  { index: 4, title: "Dress", url: "https://shop.test/item?sku=dress", siteName: "Shop" },
];

const facet = (name: string, strength: TrendFacet["strength"], sourceIndexes = [7]): TrendFacet => ({
  name, strength, sourceIndexes, rationale: "Validated market evidence",
});

const report = (): InspirationAnalysisResult => ({
  ...structuredClone(inspirationResultFixture),
  headline: "Editorial headline",
  marketSignals: [
    facet("Early signal", "emerging"),
    facet("Strong signal", "high", [2, 7, 99, 7]),
    facet("Second signal", "medium"),
  ],
  dimensions: {
    silhouettes: [facet("Strong signal", "high"), facet("Relaxed shape", "medium")],
    productTypes: [facet("Shirt", "medium")],
    styles: [], categories: [], colors: [], materials: [],
  },
  referenceLooks: Array.from({ length: 6 }, (_, index) => ({
    name: `Validated product ${index + 1}`,
    sourceKind: "product" as const,
    whyRelevant: "A sourced garment",
    sourceIndexes: [2],
  })),
});

const productIntent: WebEvidenceIntent = {
  key: "product-1", role: "product", query: "linen shirt",
  sourceIndexes: [2], sourceHosts: ["shop.test"],
  productName: "Validated linen shirt", brand: null,
};
const evidenceIntent: WebEvidenceIntent = {
  key: "evidence-1", role: "evidence", query: "linen trend",
  sourceIndexes: [7], sourceHosts: ["journal.test"],
  productName: null, brand: null,
};
const candidate = (overrides: Partial<WebEvidenceCandidate> = {}): WebEvidenceCandidate => ({
  query: "linen shirt", title: "Provider invented product ¥999",
  imageUrl: "https://images.test/shirt.jpg",
  sourcePageUrl: "https://shop.test/item?sku=shirt",
  ...overrides,
});

describe("web evidence intent planning", () => {
  it("builds the hero from the strongest sourced signal and filters indexes into report order", () => {
    const result = report();
    result.marketSignals.unshift(facet("Unsupported strongest", "high", [99]));
    const planned = planWebEvidenceIntents({ prompt: "Fashion brief", result, sources });

    expect(planned[0]).toEqual({
      key: "hero-1", role: "hero", query: "Editorial headline Strong signal",
      sourceIndexes: [7, 2], sourceHosts: ["journal.test", "shop.test"],
      productName: null, brand: null,
    });
    expect(planned.filter(({ role }) => role === "hero")).toHaveLength(1);
  });

  it("plans three unique sourced facets and four validated products in stable order, at most eight", () => {
    const input = { prompt: "Fashion brief", result: report(), sources };
    const planned = planWebEvidenceIntents(input);

    expect(planned.map(({ role }) => role)).toEqual([
      "hero", "evidence", "evidence", "evidence", "product", "product", "product", "product",
    ]);
    expect(planned.filter(({ role }) => role === "evidence").map(({ query }) => query)).toEqual([
      "Fashion brief Early signal", "Fashion brief Second signal", "Fashion brief Relaxed shape",
    ]);
    expect(planned.filter(({ role }) => role === "product").map(({ productName }) => productName)).toEqual([
      "Validated product 1", "Validated product 2", "Validated product 3", "Validated product 4",
    ]);
    expect(planWebEvidenceIntents(input)).toEqual(planned);
  });

  it("omits unsupported facets and non-product, invalid-source, or duplicate reference looks", () => {
    const result = report();
    result.marketSignals = [];
    result.dimensions = { silhouettes: [], productTypes: [], styles: [], categories: [], colors: [], materials: [] };
    result.referenceLooks = [
      { ...result.referenceLooks[0]!, sourceKind: "ranking" },
      { ...result.referenceLooks[1]!, sourceIndexes: [99] },
      result.referenceLooks[2]!,
      { ...result.referenceLooks[2]!, name: "  VALIDATED PRODUCT 3  " },
    ];

    expect(planWebEvidenceIntents({ prompt: "Fashion brief", result, sources }).map(({ role, productName }) => ({ role, productName }))).toEqual([
      { role: "product", productName: "Validated product 3" },
    ]);
    expect(planWebEvidenceIntents({ prompt: "Fashion brief", result: report(), sources: [] })).toEqual([]);
  });

  it("uses stable first occurrence for tied hero signals and bounds long prompt queries", () => {
    const result = report();
    result.marketSignals = [facet("First high", "high"), facet("Second high", "high")];
    const planned = planWebEvidenceIntents({ prompt: "x".repeat(1000), result, sources });

    expect(planned[0]?.query).toBe("Editorial headline First high");
    expect(planned.every(({ query }) => query.length <= 300)).toBe(true);
    expect(planned.find(({ role }) => role === "evidence")?.query).toContain("Second high");
  });
});

describe("web evidence candidate classification", () => {
  it.each([
    ["different product with meaningful query", "https://shop.test/item?sku=dress", "linen shirt", [4]],
    ["different product path", "https://shop.test/product/dress", "linen shirt", [2]],
    ["editorial page on the same host", "https://shop.test/blog/summer", "linen shirt", [2]],
    ["host-only evidence", "https://shop.test/", "unknown query", [2, 4]],
    ["query-only evidence", "https://elsewhere.test/item", "linen shirt", [2]],
  ])("downgrades %s instead of attaching the referenced shirt name", (_name, sourcePageUrl, query, sourceIndexes) => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [{ ...productIntent, brand: "Validated brand" }], sources,
      candidates: [candidate({ sourcePageUrl, query, priceText: "¥999" })],
    });
    expect(classified).toMatchObject({
      role: "evidence", productName: null, brand: null, priceText: null, sourceIndexes,
    });
  });

  it("binds an HTTP product reference to its exact HTTPS page without conflating query identities", () => {
    const classified = classifyWebEvidenceCandidates({
      intents: [productIntent],
      sources: sources.map((source) => ({ ...source, url: source.url.replace("https:", "http:") })),
      candidates: [candidate({ query: "unknown" }), candidate({ sourcePageUrl: "https://shop.test/item?sku=dress" })],
    });
    expect(classified).toMatchObject([
      { role: "product", productName: "Validated linen shirt", sourceIndexes: [2] },
      { role: "evidence", productName: null, brand: null, priceText: null, sourceIndexes: [4] },
    ]);
  });

  it("bounds classified text before import so provider titles cannot break browser projections", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [{ ...productIntent, query: "q".repeat(350), productName: "  " + "p".repeat(350) + "  ", brand: "  " + "b".repeat(150) + "  " }],
      sources: sources.map((source) => ({ ...source, siteName: "s".repeat(150) })),
      candidates: [candidate({ query: "q".repeat(350), title: "  " + "t".repeat(500) + "  ", priceText: "  $25  " })],
    });
    expect(classified).toMatchObject({
      title: "t".repeat(300), sourceQuery: "q".repeat(300), sourceSiteName: "s".repeat(120),
      productName: "p".repeat(300), brand: "b".repeat(120), priceText: "$25",
    });
    // The importer copies title to altText, so its 500-character limit also holds.
    expect(classified!.title.length).toBeLessThanOrEqual(500);
  });

  it("bounds unmapped query and hostname fallbacks and trims display text", () => {
    const hostname = `${"a".repeat(60)}.${"b".repeat(60)}.test`;
    const [classified] = classifyWebEvidenceCandidates({
      intents: [], sources: [],
      candidates: [candidate({ sourcePageUrl: `https://${hostname}/page`, query: "q".repeat(350), title: "  Image title  " })],
    });
    expect(classified).toMatchObject({ title: "Image title", sourceQuery: "q".repeat(300), sourceSiteName: `${"a".repeat(60)}.${"b".repeat(59)}` });
  });

  it("keeps a valid duplicate as a fallback after rejecting a blank title", () => {
    const classified = classifyWebEvidenceCandidates({
      intents: [], sources: [], candidates: [candidate({ title: "   " }), candidate({ title: "Valid fallback" })],
    });
    expect(classified.map(({ title }) => title)).toEqual(["Valid fallback"]);
  });

  it("drops blank display titles before fetching or storing images", () => {
    expect(classifyWebEvidenceCandidates({ intents: [], sources: [], candidates: [candidate({ title: "   " })] })).toEqual([]);
  });

  it.each([
    { sourcePageUrl: "http://shop.test/item?sku=shirt" },
    { imageUrl: "http://images.test/shirt.jpg" },
    { sourcePageUrl: "https://user@shop.test/item?sku=shirt" },
    { sourcePageUrl: "https://user:password@shop.test/item?sku=shirt" },
    { imageUrl: "https://user@images.test/shirt.jpg" },
    { imageUrl: "https://user:password@images.test/shirt.jpg" },
  ])("rejects non-HTTPS or credential-bearing candidate URLs: %j", (overrides) => {
    expect(classifyWebEvidenceCandidates({
      intents: [productIntent], sources,
      candidates: [candidate(overrides)],
    })).toEqual([]);
  });

  it("supports HTTP report sources without rewriting them or weakening candidate HTTPS", () => {
    const httpSources = sources.map((source) => ({
      ...source, url: source.url.replace("https:", "http:"),
    }));
    const before = structuredClone(httpSources);
    const intents = planWebEvidenceIntents({ prompt: "Fashion brief", result: report(), sources: httpSources });
    const classified = classifyWebEvidenceCandidates({
      intents: [productIntent], sources: httpSources,
      candidates: [
        candidate({ sourcePageUrl: "https://shop.test/item?sku=shirt#photo", imageUrl: "https://images.test/shirt.jpg#preview" }),
        candidate({ sourcePageUrl: "http://shop.test/item?sku=shirt" }),
      ],
    });

    expect(intents[0]?.sourceIndexes).toEqual([7, 2]);
    expect(classified).toHaveLength(1);
    expect(classified[0]).toMatchObject({
      role: "product", sourceIndexes: [2],
      sourcePageUrl: "https://shop.test/item?sku=shirt",
      imageUrl: "https://images.test/shirt.jpg",
    });
    expect(httpSources).toEqual(before);
  });

  it("matches normalized intent queries and uses the validated product name rather than provider title", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [productIntent], sources,
      candidates: [candidate({ query: "  LINEN   SHIRT  ", priceText: " ¥299 " })],
    });

    expect(classified).toMatchObject({
      role: "product", productName: "Validated linen shirt", brand: null,
      priceText: "¥299", sourceIndexes: [2], sourceSiteName: "Shop", sourceQuery: "linen shirt",
    });
  });

  it("lets exact canonical source matches override a merely similar query's source mapping", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [evidenceIntent], sources,
      candidates: [candidate({ query: "linen trend photograph", sourcePageUrl: "https://SHOP.test/item?sku=dress#photo" })],
    });

    expect(classified).toMatchObject({
      role: "evidence", sourceIndexes: [4],
      sourcePageUrl: "https://shop.test/item?sku=dress",
    });
  });

  it("maps a query with no exact source match only to valid indexes, in source report order", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [{ ...evidenceIntent, sourceIndexes: [2, 99, 7, 2] }], sources,
      candidates: [candidate({ query: "linen trend", sourcePageUrl: "https://elsewhere.test/editorial" })],
    });

    expect(classified?.sourceIndexes).toEqual([7, 2]);
  });

  it.each(["https://elsewhere.test/item", "https://shop.test.evil.test/item", "https://sub.shop.test/item"])(
    "downgrades a product query on an unmapped host: %s", (sourcePageUrl) => {
      const [classified] = classifyWebEvidenceCandidates({
        intents: [productIntent], sources,
        candidates: [candidate({ sourcePageUrl, priceText: "¥299" })],
      });

      expect(classified).toMatchObject({ role: "evidence", productName: null, brand: null, priceText: null });
    },
  );

  it("does not trust sourceHosts on an intent without corresponding source indexes", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [{ ...productIntent, sourceIndexes: [99] }], sources,
      candidates: [candidate({ sourcePageUrl: "https://shop.test/other" })],
    });

    expect(classified).toMatchObject({ role: "evidence", productName: null });
  });

  it("does not promote an evidence intent from a product-looking title or shared source host", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [evidenceIntent, productIntent], sources,
      candidates: [candidate({ query: "linen trend", priceText: "¥999" })],
    });

    expect(classified).toMatchObject({ role: "evidence", productName: null, brand: null, priceText: null });
  });

  it("uses canonical page and then normalized host/path evidence when there is no intent query match", () => {
    const classified = classifyWebEvidenceCandidates({
      intents: [evidenceIntent], sources,
      candidates: [
        candidate({ query: "unknown", sourcePageUrl: "https://journal.test/trend/?season=winter" }),
        candidate({ query: "unrelated", sourcePageUrl: "https://unmapped.test/page", imageUrl: "https://images.test/other.jpg" }),
      ],
    });

    expect(classified.map(({ role, sourceIndexes }) => ({ role, sourceIndexes }))).toEqual([
      { role: "evidence", sourceIndexes: [7] },
      { role: "evidence", sourceIndexes: [] },
    ]);
  });

  it("deduplicates canonical image/source pairs while preserving meaningful source query parameters", () => {
    const classified = classifyWebEvidenceCandidates({
      intents: [productIntent], sources,
      candidates: [
        candidate(),
        candidate({ imageUrl: "https://images.test/shirt.jpg#crop", sourcePageUrl: "https://SHOP.test/item?sku=shirt#photo" }),
        candidate({ sourcePageUrl: "https://shop.test/item?sku=dress" }),
      ],
    });

    expect(classified.map(({ role }) => role)).toEqual(["product", "evidence"]);
    expect(classified.map(({ sourcePageUrl }) => sourcePageUrl)).toEqual([
      "https://shop.test/item?sku=shirt", "https://shop.test/item?sku=dress",
    ]);
  });

  it("preserves signed image query encoding and parameter order while dropping fragments", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [productIntent], sources,
      candidates: [candidate({ imageUrl: "https://images.test/shirt.jpg?token=a%20b&expires=5#preview" })],
    });
    expect(classified?.imageUrl).toBe("https://images.test/shirt.jpg?token=a%20b&expires=5");
  });

  it("compares source query parameters canonically without changing the original link", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [evidenceIntent],
      sources: [...sources, { ...sources[1]!, index: 8, url: "https://shop.test/item?season=fall&sku=shirt" }],
      candidates: [candidate({ query: "linen trend", sourcePageUrl: "https://shop.test/item?sku=shirt&season=fall" })],
    });
    expect(classified).toMatchObject({ sourceIndexes: [8], sourcePageUrl: "https://shop.test/item?sku=shirt&season=fall" });
  });

  it.each([undefined, null, "", " ", "x".repeat(121), "¥9\u0000"])(
    "does not infer a price from the title when structured price is absent or invalid: %s", (priceText) => {
      const [classified] = classifyWebEvidenceCandidates({
        intents: [productIntent], sources,
        candidates: [candidate({ priceText })],
      });
      expect(classified?.priceText).toBeNull();
    },
  );

  it("accepts the structured price length boundary without parsing it", () => {
    const [classified] = classifyWebEvidenceCandidates({
      intents: [productIntent], sources,
      candidates: [candidate({ priceText: "x".repeat(120) })],
    });
    expect(classified?.priceText).toBe("x".repeat(120));
  });

  it("preserves intent and provider order plus candidate alternatives for import failures", () => {
    const hero: WebEvidenceIntent = { ...evidenceIntent, key: "hero-1", role: "hero", query: "hero query" };
    const classified = classifyWebEvidenceCandidates({
      intents: [hero, evidenceIntent, productIntent], sources,
      candidates: [
        candidate({ imageUrl: "https://images.test/product.jpg" }),
        candidate({ query: "linen trend", imageUrl: "https://images.test/evidence.jpg" }),
        ...Array.from({ length: 9 }, (_, index) => candidate({ query: "hero query", imageUrl: `https://images.test/hero-${index}.jpg` })),
      ],
    });

    expect(classified).toHaveLength(11);
    expect(classified.map(({ imageUrl }) => imageUrl)).toEqual([
      ...Array.from({ length: 9 }, (_, index) => `https://images.test/hero-${index}.jpg`),
      "https://images.test/evidence.jpg", "https://images.test/product.jpg",
    ]);
  });
});
