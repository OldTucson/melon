import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { getServerEnv } from "@/lib/env/server";

import type { InspirationDocumentRole, VisualWarning } from "./contracts";
import { sniffImage } from "./image-sniffer";
import { fetchRemoteImage, type RemoteImage } from "./safe-image-fetch";
import { researchVisualObjectKey } from "./visual-object-keys";
import type { VisualObjectStore } from "./visual-object-store";
import type { ClassifiedWebEvidenceCandidate } from "./web-evidence-intents";

/** Private insert record. The repository must preserve this pre-generated id. */
export type ImportedWebEvidenceAsset = {
  id: string;
  kind: "web_evidence";
  ordinal: number;
  directionIndex: null;
  title: string;
  altText: string;
  documentRole: InspirationDocumentRole;
  sourcePageUrl: string;
  sourceSiteName: string;
  sourceQuery: string;
  sourceIndexes: number[];
  productName: string | null;
  brand: string | null;
  priceText: string | null;
  objectKey: string;
  contentType: string;
  width: number;
  height: number;
};
export type WebEvidenceImportResult = {
  assets: ImportedWebEvidenceAsset[];
  warnings: VisualWarning[];
  writtenKeys: string[];
};
type ImportInput = {
  ownerId: string;
  analysisId: string;
  jobId: string;
  candidates: readonly ClassifiedWebEvidenceCandidate[];
  signal: AbortSignal;
  maxImages?: number;
};
type ImportDependencies = {
  store: VisualObjectStore;
  fetchImage?: (url: string, options: { signal: AbortSignal }) => Promise<RemoteImage>;
  createAssetId?: () => string;
};
type FetchOutcome = { image: RemoteImage } | { failed: true };
type Pending = { candidate: ClassifiedWebEvidenceCandidate; id: string; outcome: Promise<FetchOutcome> };
const cancelled = () => new Error("Web evidence import cancelled");
const unavailable = () => new Error("Web evidence import unavailable");

/** Three bounded fetch slots; ordered writes make fallback selection independent of timing. */
export async function importWebEvidence(input: ImportInput, dependencies: ImportDependencies): Promise<WebEvidenceImportResult> {
  if (input.signal.aborted) throw cancelled();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal.addEventListener("abort", onAbort, { once: true });
  const assets: ImportedWebEvidenceAsset[] = [];
  const writtenKeys: string[] = [];
  const warnings = new Set<VisualWarning>();
  const checkAbort = () => { if (input.signal.aborted) throw cancelled(); };
  try {
    // Validate identity before networking, without allowing schema errors to echo input.
    const ownerId = normalizedUuidSchema.parse(input.ownerId);
    const analysisId = normalizedUuidSchema.parse(input.analysisId);
    const jobId = normalizedUuidSchema.parse(input.jobId);
    const maxImages = input.maxImages ?? getServerEnv().INSPIRATION_VISUAL_MAX_IMAGES;
    if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 8) throw unavailable();
    const fetchImage = dependencies.fetchImage ?? fetchRemoteImage;
    const createAssetId = dependencies.createAssetId ?? randomUUID;
    const seenUrls = new Set<string>();
    const seenBytes = new Set<string>();
    const usedIds = new Set<string>();
    const counts = { hero: 0, evidence: 0, product: 0 };
    const allowed = (role: InspirationDocumentRole) => counts[role] < (role === "hero" ? 1 : role === "product" ? 4 : maxImages);
    const queue: Pending[] = [];
    let cursor = 0;
    const fillWindow = () => {
      checkAbort();
      while (queue.length < 3 && cursor < input.candidates.length) {
        const candidate = input.candidates[cursor++]!;
        if (!allowed(candidate.role) || seenUrls.has(candidate.imageUrl)) continue;
        seenUrls.add(candidate.imageUrl);
        // Generated before fetch; validate and normalize once for both key and row.
        const id = normalizedUuidSchema.parse(createAssetId());
        if (usedIds.has(id)) throw unavailable();
        usedIds.add(id);
        const outcome = Promise.resolve()
          .then(() => {
            checkAbort();
            if (controller.signal.aborted) throw unavailable();
            return fetchImage(candidate.imageUrl, { signal: controller.signal });
          })
          .then((image): FetchOutcome => ({ image }), (): FetchOutcome => ({ failed: true }));
        queue.push({ candidate, id, outcome });
      }
    };
    const consume = async ({ candidate, id, outcome }: Pending) => {
      const fetched = await outcome;
      checkAbort();
      // A previous result may have filled this role while this fetch was in flight.
      if (!allowed(candidate.role)) return;
      if ("failed" in fetched) { warnings.add("INSPIRATION_WEB_VISUALS_UNAVAILABLE"); return; }
      try {
        // Read metadata from validated bytes, never from remote filenames or URL suffixes.
        const metadata = sniffImage(fetched.image.bytes, fetched.image.contentType);
        const digest = createHash("sha256").update(fetched.image.bytes).digest("hex");
        if (seenBytes.has(digest)) return;
        const objectKey = researchVisualObjectKey({ ownerId, analysisId, jobId, assetId: id, extension: metadata.extension });
        checkAbort();
        await dependencies.store.put({ key: objectKey, bytes: fetched.image.bytes, contentType: metadata.contentType });
        // Track a successful put before checking abort so compensation includes races.
        writtenKeys.push(objectKey);
        checkAbort();
        seenBytes.add(digest);
        counts[candidate.role]++;
        assets.push({
          id, kind: "web_evidence", ordinal: assets.length, directionIndex: null,
          title: candidate.title, altText: candidate.title,
          documentRole: candidate.role,
          sourcePageUrl: candidate.sourcePageUrl, sourceSiteName: candidate.sourceSiteName,
          sourceQuery: candidate.sourceQuery, sourceIndexes: [...candidate.sourceIndexes],
          productName: candidate.productName, brand: candidate.brand, priceText: candidate.priceText,
          objectKey, contentType: metadata.contentType, width: metadata.width, height: metadata.height,
        });
      } catch {
        checkAbort();
        warnings.add("INSPIRATION_WEB_VISUALS_UNAVAILABLE");
      }
    };
    fillWindow();
    while (queue.length > 0) {
      // Consume in a separate scope before replenishing, releasing image bytes.
      await consume(queue.shift()!);
      if (assets.length === maxImages) break;
      fillWindow();
    }
    checkAbort();
    if (assets.length === 0) warnings.add("INSPIRATION_WEB_VISUALS_UNAVAILABLE");
    return { assets, writtenKeys, warnings: [...warnings] };
  } catch {
    controller.abort();
    // Fatal exits cannot return a compensation ledger: clean up here instead.
    // Cleanup failures are best effort; the private bucket lifecycle is the fallback.
    if (writtenKeys.length > 0) {
      try { await dependencies.store.delete(writtenKeys); } catch { /* Preserve the original failure. */ }
    }
    if (input.signal.aborted) throw cancelled();
    throw unavailable();
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    // Cancel unused speculative fetches when caps are filled or a fatal exit occurs.
    controller.abort();
  }
}
