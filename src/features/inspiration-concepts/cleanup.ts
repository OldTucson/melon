import "server-only";
import * as defaultRepository from "./repository";
import * as reportRepository from "./report-cleanup-repository";
import type { ConceptCleanupStore } from "./object-store";
import { conceptSetObjectPrefix, parseConceptObjectKey } from "./object-keys";
import { researchAnalysisObjectPrefix, parseVisualObjectKey } from "@/features/inspiration-visuals/visual-object-keys";

export const CONCEPT_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
export interface ConceptCleanupSummary {
  scannedSets: number; deletedObjects: number; deletedSets: number;
  skippedActiveSets: number; deletedResearchObjects: number; failures: number;
  scannedReports: number; deletedReports: number;
}
export async function cleanupInspirationConceptObjects(input: {
  now: Date; orphanAgeMs?: number; dryRun: boolean; store: ConceptCleanupStore;
  reportRepository?: typeof reportRepository;
  repository?: Pick<typeof defaultRepository, "listConceptCleanupCandidates" | "withConceptCleanupSet" | "listResearchCleanupCandidates" | "withResearchCleanupKey">;
}): Promise<ConceptCleanupSummary> {
  const age = input.orphanAgeMs ?? CONCEPT_ORPHAN_AGE_MS;
  if (!Number.isFinite(input.now.getTime()) || !Number.isFinite(age) || age < CONCEPT_ORPHAN_AGE_MS) throw Error("Invalid cleanup retention");
  const cutoff = new Date(input.now.getTime() - age);
  const repository = input.repository ?? defaultRepository;
  const summary = { scannedSets: 0, deletedObjects: 0, deletedSets: 0, skippedActiveSets: 0, deletedResearchObjects: 0, failures: 0, scannedReports: 0, deletedReports: 0 };
  const started = Date.now();
  const { candidates, skippedActiveSets } = await repository.listConceptCleanupCandidates(cutoff);
  summary.skippedActiveSets = skippedActiveSets;
  for (const candidate of candidates) {
    if (Date.now() - started > 10 * 60_000) { summary.failures++; break; }
    try {
      const cleaned = await repository.withConceptCleanupSet({ ...candidate, cutoff, now: new Date(input.now.getTime() + Date.now() - started), dryRun: input.dryRun }, async (set, protectedKeys) => {
        const prefix = conceptSetObjectPrefix({ ownerId: set.ownerId, analysisId: set.analysisId, setId: set.id });
        const objects = await input.store.listObjects(prefix);
        if (objects.length > 10_000) throw Error("Cleanup listing limit");
        const seen = new Set<string>();
        for (const object of objects) {
          parseConceptObjectKey(object.key);
          if (!object.key.startsWith(prefix) || seen.has(object.key) || !(object.lastModified instanceof Date) || !Number.isFinite(object.lastModified.getTime())) throw Error("Invalid cleanup listing");
          seen.add(object.key);
        }
        const keys = objects.filter(({ key, lastModified }) => lastModified < cutoff && !protectedKeys.has(key)).map(({ key }) => key);
        if (!input.dryRun && keys.length) await input.store.delete(keys);
        // A second scoped listing is required before releasing tombstoned reference relations.
        const allGone = !input.dryRun && set.status === "deleting" && (await input.store.listObjects(prefix)).length === 0;
        return { result: input.dryRun ? 0 : keys.length, allGone };
      });
      if (cleaned) { summary.scannedSets++; summary.deletedObjects += cleaned.result; if (cleaned.deletedSet) summary.deletedSets++; }
    } catch { summary.failures++; }
  }
  for (const candidate of await repository.listResearchCleanupCandidates(cutoff)) {
    if (Date.now() - started > 10 * 60_000) { summary.failures++; break; }
    try {
      if (!candidate.key) continue;
      const parts = parseVisualObjectKey(candidate.key);
      if (parts.ownerId !== candidate.ownerId || parts.analysisId !== candidate.analysisId) throw Error("Invalid research scope");
      const key = candidate.key;
      const removed = await repository.withResearchCleanupKey({ ...candidate, key, cutoff, dryRun: input.dryRun }, async () => {
        const modified = await input.store.researchObjectLastModified(key);
        if (modified && (!Number.isFinite(modified.getTime()) || modified >= cutoff)) return false;
        if (input.dryRun) return false;
        await input.store.deleteResearchObjects([key]);
        return true;
      });
      if (removed) summary.deletedResearchObjects++;
    } catch { summary.failures++; }
  }
  const reports = input.reportRepository ?? reportRepository;
  const clock = () => new Date(input.now.getTime() + Date.now() - started);
  for (const candidate of await reports.listReportCleanupCandidates({ now: clock(), cutoff })) {
    if (Date.now() - started > 10 * 60_000) { summary.failures++; break; }
    let claim: reportRepository.ReportCleanupClaim | undefined;
    try {
      claim = input.dryRun ? undefined : await reports.claimReportCleanup({ ...candidate, cutoff, now: clock() });
      if (!input.dryRun && !claim) continue;
      const manifest = claim ?? candidate;
      summary.scannedReports++;
      const scopes = [
        { prefix: researchAnalysisObjectPrefix(manifest), research: true },
        ...[...new Set(manifest.setIds)].map((setId) => ({ prefix: conceptSetObjectPrefix({ ...manifest, setId }), research: false })),
      ];
      let allGone = true;
      for (const { prefix, research } of scopes) {
        if (Date.now() - started > 10 * 60_000) throw Error("Cleanup time limit");
        const list = async () => {
          const objects = await input.store.listObjects(prefix);
          if (objects.length > 10_000) throw Error("Cleanup listing limit");
          const seen = new Set<string>();
          for (const object of objects) {
            (research ? parseVisualObjectKey : parseConceptObjectKey)(object.key);
            if (!object.key.startsWith(prefix) || seen.has(object.key) || !(object.lastModified instanceof Date) || !Number.isFinite(object.lastModified.getTime())) throw Error("Invalid cleanup listing");
            seen.add(object.key);
          }
          return objects;
        };
        const objects = await list();
        if (input.dryRun) continue;
        const protectedKeys = await reports.reportCleanupProtectedKeys(prefix);
        const keys = objects.filter(({ key, lastModified }) => lastModified < cutoff && !protectedKeys.has(key)).map(({ key }) => key);
        if (keys.length) {
          // Both adapters require verbose acknowledgement of every deletion.
          if (research) { await input.store.deleteResearchObjects(keys); summary.deletedResearchObjects += keys.length; }
          else { await input.store.delete(keys); summary.deletedObjects += keys.length; }
        }
        if ((await list()).length) allGone = false;
      }
      if (claim && allGone) {
        if (!await reports.completeReportCleanup(claim, clock())) throw Error("Cleanup claim expired");
        summary.deletedReports++;
      } else if (claim) await reports.releaseReportCleanup(claim, clock());
    } catch {
      summary.failures++;
      // A failed release (or process death) leaves a reclaimable durable lease.
      if (claim) { try { await reports.releaseReportCleanup(claim, clock()); } catch { /* retry after lease expiry */ } }
    }
  }
  return summary;
}
