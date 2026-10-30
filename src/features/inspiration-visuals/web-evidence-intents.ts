import type {
  InspirationAnalysisResult,
  InspirationSource,
  TrendFacet,
} from "@/features/inspiration/contracts";

import type { InspirationDocumentRole } from "./contracts";

export type WebEvidenceIntent = {
  key: string;
  role: InspirationDocumentRole;
  query: string;
  sourceIndexes: number[];
  sourceHosts: string[];
  productName: string | null;
  brand: string | null;
};

/** Validated, provider-independent image result. No HTML or transport envelopes. */
export type WebEvidenceCandidate = {
  query: string;
  title: string;
  imageUrl: string;
  sourcePageUrl: string;
  sourceSiteName?: string | null;
  priceText?: string | null;
};

export type ClassifiedWebEvidenceCandidate = {
  role: InspirationDocumentRole;
  title: string;
  imageUrl: string;
  sourcePageUrl: string;
  sourceSiteName: string;
  sourceQuery: string;
  sourceIndexes: number[];
  productName: string | null;
  brand: string | null;
  priceText: string | null;
};

type PlanInput = {
  prompt: string;
  result: InspirationAnalysisResult;
  sources: readonly InspirationSource[];
};

const normalizeText = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

const host = (url: URL) => url.hostname.toLowerCase().replace(/\.$/u, "");

function canonicalUrl(value: string) {
  const parsed = URL.parse(value);
  if (
    parsed === null ||
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) return null;
  parsed.hash = "";
  return parsed;
}

function sourcePageKey(url: URL) {
  // Compare parameter order independently without rewriting signed download URLs.
  const key = new URL(url.href);
  key.searchParams.sort();
  return key.href;
}

const pagePath = (url: URL) => `${host(url)}${url.pathname.replace(/\/+$/u, "") || "/"}`;

function mappedSources(indexes: readonly number[], sources: readonly InspirationSource[]) {
  const included = new Set(indexes);
  return sources.filter(({ index }) => included.has(index));
}

function queryFor(prompt: string, subject: string) {
  const suffix = subject.trim();
  const prefix = prompt.trim().replace(/\s+/gu, " ").slice(0, 299 - suffix.length).trim();
  return `${prefix} ${suffix}`.trim();
}

export function planWebEvidenceIntents({ prompt, result, sources }: PlanInput): WebEvidenceIntent[] {
  const intents: WebEvidenceIntent[] = [];
  const seen = new Set<string>();

  const append = (role: InspirationDocumentRole, subject: string, indexes: readonly number[]) => {
    const mapped = mappedSources(indexes, sources);
    const identity = normalizeText(subject);
    if (mapped.length === 0 || seen.has(identity)) return;
    seen.add(identity);
    const ordinal = intents.filter((intent) => intent.role === role).length + 1;
    intents.push({
      key: `${role}-${ordinal}`,
      role,
      query: queryFor(role === "hero" ? result.headline : prompt, subject),
      sourceIndexes: mapped.map(({ index }) => index),
      sourceHosts: [...new Set(mapped.map(({ url }) => host(new URL(url))))],
      productName: role === "product" ? subject : null,
      // Reference looks do not have a validated brand field. Do not infer one.
      brand: null,
    });
  };

  const strength: Record<TrendFacet["strength"], number> = { high: 3, medium: 2, emerging: 1 };
  const strongest = result.marketSignals
    .filter(({ sourceIndexes }) => mappedSources(sourceIndexes, sources).length > 0)
    .toSorted((left, right) => strength[right.strength] - strength[left.strength])[0];
  if (strongest) append("hero", strongest.name, strongest.sourceIndexes);

  const facets = [
    ...result.marketSignals,
    ...result.dimensions.silhouettes,
    ...result.dimensions.productTypes,
    ...result.dimensions.styles,
    ...result.dimensions.categories,
    ...result.dimensions.colors,
    ...result.dimensions.materials,
  ];
  for (const facet of facets) {
    if (intents.filter(({ role }) => role === "evidence").length === 3) break;
    append("evidence", facet.name, facet.sourceIndexes);
  }

  // Product names have their own identity set: a sourced garment may also be a facet.
  seen.clear();
  for (const look of result.referenceLooks) {
    if (intents.filter(({ role }) => role === "product").length === 4) break;
    if (look.sourceKind === "product") append("product", look.name, look.sourceIndexes);
  }
  return intents;
}

const boundedText = (value: string | null | undefined, max: number) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed
    : null;
};

/** Classifies alternatives; the importer enforces final asset quotas after failures. */
export function classifyWebEvidenceCandidates({ intents, sources, candidates }: {
  intents: readonly WebEvidenceIntent[];
  sources: readonly InspirationSource[];
  candidates: readonly WebEvidenceCandidate[];
}): ClassifiedWebEvidenceCandidate[] {
  const sourcePages = sources.map((source) => ({ source, page: canonicalUrl(source.url)! }));
  const seen = new Set<string>();
  const classified: { candidate: ClassifiedWebEvidenceCandidate; intentOrder: number }[] = [];

  for (const candidate of candidates) {
    const page = canonicalUrl(candidate.sourcePageUrl);
    const image = canonicalUrl(candidate.imageUrl);
    if (!page || !image || page.protocol !== "https:" || image.protocol !== "https:") continue;
    const identity = JSON.stringify([image.href, sourcePageKey(page)]);
    if (seen.has(identity)) continue;
    seen.add(identity);

    const exact = sourcePages.filter((source) => sourcePageKey(source.page) === sourcePageKey(page));
    const queryIntent = intents.find((intent) => normalizeText(intent.query) === normalizeText(candidate.query));
    const samePath = sourcePages.filter((source) => pagePath(source.page) === pagePath(page));
    const sameHost = sourcePages.filter((source) => host(source.page) === host(page));
    const pageSources = exact.length ? exact : samePath.length ? samePath : sameHost;
    const pageIndexes = new Set(pageSources.map(({ source }) => source.index));
    const intent = queryIntent ?? intents.find((intent) => intent.sourceIndexes.some((index) => pageIndexes.has(index)));
    const mapped = exact.length
      ? exact.map(({ source }) => source)
      : queryIntent
        ? mappedSources(queryIntent.sourceIndexes, sources)
        : pageSources.map(({ source }) => source);

    // Derive the host from the current report, rather than trusting intent.sourceHosts.
    const productHostMatches = intent?.role === "product" && mappedSources(intent.sourceIndexes, sources)
      .some((source) => host(new URL(source.url)) === host(page));
    const role = intent?.role === "product"
      ? productHostMatches && intent.productName !== null ? "product" : "evidence"
      : intent?.role ?? "evidence";
    classified.push({
      intentOrder: intent ? intents.indexOf(intent) : intents.length,
      candidate: {
        role,
        title: candidate.title,
        imageUrl: image.href,
        sourcePageUrl: page.href,
        sourceSiteName: boundedText(pageSources[0]?.source.siteName, 120)
          ?? boundedText(candidate.sourceSiteName, 120) ?? host(page),
        sourceQuery: intent?.query ?? candidate.query,
        sourceIndexes: mapped.map(({ index }) => index),
        productName: role === "product" ? intent!.productName : null,
        brand: role === "product" ? intent!.brand : null,
        priceText: role === "product" ? boundedText(candidate.priceText, 120) : null,
      },
    });
  }

  return classified.toSorted((left, right) => left.intentOrder - right.intentOrder)
    .map(({ candidate }) => candidate);
}
