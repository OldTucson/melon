import "server-only";

import type { DbTransaction } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env/server";

import {
  deleteVisualSearchRowsForPatterns,
  insertVisualSearchJob,
  parseVisualSearchIndexVersion,
  selectVisualSearchBackfillCandidates,
  type VisualSearchBackfillCandidate,
  type VisualSearchBackfillPage,
} from "./index-repository";

export const ACTIVE_VISUAL_SEARCH_INDEX_VERSION = "visual-search-v1";
const VISUAL_SEARCH_BACKFILL_PAGE_SIZE = 500;

export type EnqueueVisualSearchIndexJobInput = {
  ownerId: string;
  patternId: string;
  previewAssetId: string;
  indexVersion: string;
  now: Date;
};

export type { VisualSearchBackfillCandidate, VisualSearchBackfillPage };

type EnqueueResult =
  | { inserted: true; jobId: string }
  | { inserted: false; jobId: null };

export type VisualSearchBackfillServices<TTransaction> = {
  transaction<TResult>(
    work: (tx: TTransaction) => Promise<TResult>,
  ): Promise<TResult>;
  listCandidates(
    tx: TTransaction,
    input: {
      ownerId?: string;
      cursor?: VisualSearchBackfillCandidate;
      limit: number;
    },
  ): Promise<VisualSearchBackfillPage>;
  enqueue(
    tx: TTransaction,
    input: EnqueueVisualSearchIndexJobInput,
  ): Promise<EnqueueResult>;
};

export type VisualSearchBackfillResult = {
  version: string;
  pages: number;
  scanned: number;
  inserted: number;
  alreadyExisting: number;
};

export function validateVisualSearchIndexVersion(value: unknown) {
  return parseVisualSearchIndexVersion(value);
}

export function getActiveVisualSearchIndexVersion() {
  return validateVisualSearchIndexVersion(
    getServerEnv().IMAGE_SEARCH_ACTIVE_VERSION ??
      ACTIVE_VISUAL_SEARCH_INDEX_VERSION,
  );
}

export function enqueueVisualSearchIndexJob(
  tx: DbTransaction,
  input: EnqueueVisualSearchIndexJobInput,
) {
  return insertVisualSearchJob(tx, input);
}

export function listVisualSearchBackfillCandidates(
  tx: DbTransaction,
  input: {
    ownerId?: string;
    cursor?: VisualSearchBackfillCandidate;
    limit: number;
  },
) {
  return selectVisualSearchBackfillCandidates(tx, input);
}

export async function runVisualSearchBackfill<TTransaction>(input: {
  ownerId?: string;
  version: string;
  services: VisualSearchBackfillServices<TTransaction>;
  now: () => Date;
}): Promise<VisualSearchBackfillResult> {
  const version = validateVisualSearchIndexVersion(input.version);
  let cursor: VisualSearchBackfillCandidate | undefined;
  let pages = 0;
  let scanned = 0;
  let inserted = 0;
  let alreadyExisting = 0;

  while (true) {
    const page = await input.services.transaction(async (tx) => {
      const candidatePage = await input.services.listCandidates(tx, {
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        cursor,
        limit: VISUAL_SEARCH_BACKFILL_PAGE_SIZE,
      });
      let pageInserted = 0;
      let pageAlreadyExisting = 0;
      const timestamp = input.now();

      for (const candidate of candidatePage.candidates) {
        const result = await input.services.enqueue(tx, {
          ...candidate,
          indexVersion: version,
          now: timestamp,
        });
        if (result.inserted) pageInserted += 1;
        else pageAlreadyExisting += 1;
      }

      return {
        ...candidatePage,
        inserted: pageInserted,
        alreadyExisting: pageAlreadyExisting,
      };
    });

    if (page.scanned === 0) break;
    pages += 1;
    scanned += page.scanned;
    inserted += page.inserted;
    alreadyExisting += page.alreadyExisting;

    if (page.scanned < VISUAL_SEARCH_BACKFILL_PAGE_SIZE) break;
    const nextCursor = page.nextCursor;
    if (!nextCursor) throw new Error("IMAGE_SEARCH_BACKFILL_CURSOR_MISSING");
    if (
      cursor &&
      cursor.ownerId === nextCursor.ownerId &&
      cursor.patternId === nextCursor.patternId &&
      cursor.previewAssetId === nextCursor.previewAssetId
    ) {
      throw new Error("IMAGE_SEARCH_BACKFILL_CURSOR_STALLED");
    }
    cursor = nextCursor;
  }

  return { version, pages, scanned, inserted, alreadyExisting };
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
