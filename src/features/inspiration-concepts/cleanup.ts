import "server-only";
import * as defaultRepository from "./repository";
import type { ConceptCleanupStore } from "./object-store";
import { conceptSetObjectPrefix, parseConceptObjectKey } from "./object-keys";
import { parseVisualObjectKey } from "@/features/inspiration-visuals/visual-object-keys";

export const CONCEPT_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
export interface ConceptCleanupSummary {
  scannedSets: number; deletedObjects: number; deletedSets: number;
  skippedActiveSets: number; deletedResearchObjects: number; failures: number;
}
export async function cleanupInspirationConceptObjects(input: {
  now: Date; orphanAgeMs?: number; dryRun: boolean; store: ConceptCleanupStore;
  repository?: Pick<typeof defaultRepository, "listConceptCleanupCandidates" | "withConceptCleanupSet" | "listResearchCleanupCandidates" | "withResearchCleanupKey">;
}): Promise<ConceptCleanupSummary> {
  const age = input.orphanAgeMs ?? CONCEPT_ORPHAN_AGE_MS;
  if (!Number.isFinite(input.now.getTime()) || !Number.isFinite(age) || age < CONCEPT_ORPHAN_AGE_MS) throw Error("Invalid cleanup retention");
  const cutoff = new Date(input.now.getTime() - age);
  const repository = input.repository ?? defaultRepository;
  const summary = { scannedSets: 0, deletedObjects: 0, deletedSets: 0, skippedActiveSets: 0, deletedResearchObjects: 0, failures: 0 };
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
  return summary;
}
