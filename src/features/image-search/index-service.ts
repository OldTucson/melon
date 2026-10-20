import "server-only";

import type { DbTransaction } from "@/lib/db/client";

import {
  deleteVisualSearchRowsForPatterns,
  insertVisualSearchJob,
  parseVisualSearchIndexVersion,
  selectVisualSearchBackfillCandidates,
  type VisualSearchBackfillCandidate,
} from "./index-repository";

export const ACTIVE_VISUAL_SEARCH_INDEX_VERSION = "visual-search-v1";

export type EnqueueVisualSearchIndexJobInput = {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
  indexVersion: string;
  now: Date;
};

export type { VisualSearchBackfillCandidate };

export function validateVisualSearchIndexVersion(value: unknown) {
  return parseVisualSearchIndexVersion(value);
}

export function enqueueVisualSearchIndexJob(
  tx: DbTransaction,
  input: EnqueueVisualSearchIndexJobInput,
) {
  return insertVisualSearchJob(tx, input);
}

export function listVisualSearchBackfillCandidates(
  tx: DbTransaction,
  input: { cursor?: VisualSearchBackfillCandidate; limit: number },
) {
  return selectVisualSearchBackfillCandidates(tx, input);
}

export function removeVisualSearchRowsForPatterns(
  tx: DbTransaction,
  input: { ownerId: string; patternIds: readonly string[] },
) {
  return deleteVisualSearchRowsForPatterns(tx, {
    ownerId: input.ownerId,
    patternIds: [...input.patternIds],
  });
}
