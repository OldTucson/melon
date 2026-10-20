import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";

import {
  validateVisualSearchIndexVersion,
  type EnqueueVisualSearchIndexJobInput,
  type VisualSearchBackfillCandidate,
  type VisualSearchBackfillPage,
} from "@/features/image-search/index-service";
import type { DbTransaction } from "@/lib/db/client";

const PAGE_SIZE = 500;
const ARGUMENT_ERROR = "IMAGE_SEARCH_BACKFILL_ARGUMENTS_INVALID";

export type ImageSearchBackfillCandidate = VisualSearchBackfillCandidate;
export type ImageSearchBackfillPage = VisualSearchBackfillPage;

type EnqueueResult =
  | { inserted: true; jobId: string }
  | { inserted: false; jobId: null };

export type ImageSearchBackfillServices<TTransaction> = {
  transaction<TResult>(
    work: (tx: TTransaction) => Promise<TResult>,
  ): Promise<TResult>;
  listCandidates(
    tx: TTransaction,
    input: {
      cursor?: ImageSearchBackfillCandidate;
      limit: number;
    },
  ): Promise<ImageSearchBackfillPage>;
  enqueue(
    tx: TTransaction,
    input: EnqueueVisualSearchIndexJobInput,
  ): Promise<EnqueueResult>;
  closeDatabase(): Promise<void>;
};

export type ImageSearchBackfillResult = {
  version: string;
  pages: number;
  scanned: number;
  inserted: number;
  alreadyExisting: number;
};

export function parseBackfillArgs(args: readonly string[]) {
  if (args.length !== 2 || args[0] !== "--version") {
    throw new Error(ARGUMENT_ERROR);
  }
  try {
    return { version: validateVisualSearchIndexVersion(args[1]) };
  } catch {
    throw new Error(ARGUMENT_ERROR);
  }
}

export async function runImageSearchBackfill<TTransaction>(input: {
  version: string;
  services: ImageSearchBackfillServices<TTransaction>;
  now: () => Date;
}): Promise<ImageSearchBackfillResult> {
  const version = validateVisualSearchIndexVersion(input.version);
  let cursor: ImageSearchBackfillCandidate | undefined;
  let pages = 0;
  let scanned = 0;
  let inserted = 0;
  let alreadyExisting = 0;

  while (true) {
    const page = await input.services.transaction(async (tx) => {
      const candidatePage = await input.services.listCandidates(tx, {
        cursor,
        limit: PAGE_SIZE,
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

    if (page.scanned < PAGE_SIZE) break;
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

type RuntimeServices = ImageSearchBackfillServices<DbTransaction>;

async function loadRuntimeServices(): Promise<RuntimeServices> {
  nextEnv.loadEnvConfig(process.cwd());
  const [database, indexService] = await Promise.all([
    import("@/lib/db/client"),
    import("@/features/image-search/index-service"),
  ]);
  return {
    transaction: (work) => database.db.transaction(work),
    listCandidates: indexService.listVisualSearchBackfillCandidates,
    enqueue: indexService.enqueueVisualSearchIndexJob,
    closeDatabase: database.closeDatabase,
  };
}

export async function runImageSearchBackfillCli<TTransaction>(input: {
  args: readonly string[];
  loadServices: () => Promise<ImageSearchBackfillServices<TTransaction>>;
  now: () => Date;
  stdout: (line: string) => void;
}) {
  const { version } = parseBackfillArgs(input.args);
  const services = await input.loadServices();
  let result: ImageSearchBackfillResult;
  try {
    result = await runImageSearchBackfill({
      version,
      services,
      now: input.now,
    });
  } catch (error) {
    try {
      await services.closeDatabase();
    } catch {
      // The operation failure remains authoritative; direct execution sanitizes it.
    }
    throw error;
  }
  await services.closeDatabase();
  input.stdout(JSON.stringify(result));
  return result;
}

async function main() {
  return runImageSearchBackfillCli({
    args: process.argv.slice(2),
    loadServices: loadRuntimeServices,
    now: () => new Date(),
    stdout: (line) => console.log(line),
  });
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error && error.message === ARGUMENT_ERROR
        ? ARGUMENT_ERROR
        : "Image search backfill failed.",
    );
    process.exitCode = 1;
  });
}
