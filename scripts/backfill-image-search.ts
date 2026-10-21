import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";

import {
  runVisualSearchBackfill,
  validateVisualSearchIndexVersion,
  type VisualSearchBackfillResult,
  type VisualSearchBackfillServices,
  type VisualSearchBackfillCandidate,
  type VisualSearchBackfillPage,
} from "@/features/image-search/index-service";
import type { DbTransaction } from "@/lib/db/client";

const ARGUMENT_ERROR = "IMAGE_SEARCH_BACKFILL_ARGUMENTS_INVALID";

export type ImageSearchBackfillCandidate = VisualSearchBackfillCandidate;
export type ImageSearchBackfillPage = VisualSearchBackfillPage;

export type ImageSearchBackfillServices<TTransaction> =
  VisualSearchBackfillServices<TTransaction> & {
    closeDatabase(): Promise<void>;
  };

export type ImageSearchBackfillResult = VisualSearchBackfillResult;

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
  return runVisualSearchBackfill(input);
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
