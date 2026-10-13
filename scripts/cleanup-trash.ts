import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";

type PendingOperation = {
  ownerId: string;
  operationId: string;
  kind: string;
  result: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type PurgeTarget =
  | { kind: "patterns"; patternIds: string[] }
  | { kind: "folder_batch"; trashBatchId: string };

type ExpiredTrashTarget =
  | {
      kind: "patterns";
      ownerId: string;
      trashBatchId: string;
      patternIds: string[];
    }
  | {
      kind: "folder_batch";
      ownerId: string;
      trashBatchId: string;
    };

export type TrashCleanupServices = {
  listPendingOperations(kindPrefix: string): Promise<PendingOperation[]>;
  parsePendingPurgeOperation(operation: PendingOperation): PurgeTarget;
  listExpiredTrashTargets(cutoff: Date): Promise<ExpiredTrashTarget[]>;
  purgePatterns(input: {
    ownerId: string;
    operationId: string;
    patternIds: string[];
  }): Promise<unknown>;
  purgeFolderBatch(input: {
    ownerId: string;
    operationId: string;
    trashBatchId: string;
  }): Promise<unknown>;
  closeDatabase(): Promise<void>;
};

type CleanupInput = {
  services: TrashCleanupServices;
  now: Date;
  createOperationId: () => string;
  reportError: (context: string, error: unknown) => void;
};

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function isPurgeDeferred(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "TRASH_PURGE_DEFERRED"
  );
}

export async function runTrashCleanup(input: CleanupInput) {
  let processed = 0;
  let failures = 0;

  const attempt = async (context: string, work: () => Promise<unknown>) => {
    processed += 1;
    try {
      await work();
    } catch (error) {
      if (isPurgeDeferred(error)) return;
      failures += 1;
      input.reportError(context, error);
    }
  };

  const pending = [
    ...(await input.services.listPendingOperations("trash.patterns.purge:")),
    ...(await input.services.listPendingOperations("trash.folder-batch.purge:")),
  ].sort((left, right) => {
    const createdOrder = left.createdAt.getTime() - right.createdAt.getTime();
    return createdOrder === 0
      ? left.operationId.localeCompare(right.operationId)
      : createdOrder;
  });

  for (const operation of pending) {
    await attempt(`pending purge ${operation.operationId}`, async () => {
      const target = input.services.parsePendingPurgeOperation(operation);
      if (target.kind === "patterns") {
        await input.services.purgePatterns({
          ownerId: operation.ownerId,
          operationId: operation.operationId,
          patternIds: target.patternIds,
        });
      } else {
        await input.services.purgeFolderBatch({
          ownerId: operation.ownerId,
          operationId: operation.operationId,
          trashBatchId: target.trashBatchId,
        });
      }
    });
  }

  const cutoff = new Date(input.now.getTime() - RETENTION_MS);
  const expired = await input.services.listExpiredTrashTargets(cutoff);
  for (const target of expired) {
    const operationId = input.createOperationId();
    await attempt(`expired trash batch ${target.trashBatchId}`, async () => {
      if (target.kind === "patterns") {
        await input.services.purgePatterns({
          ownerId: target.ownerId,
          operationId,
          patternIds: target.patternIds,
        });
      } else {
        await input.services.purgeFolderBatch({
          ownerId: target.ownerId,
          operationId,
          trashBatchId: target.trashBatchId,
        });
      }
    });
  }

  return { processed, failures };
}

async function loadServices(): Promise<TrashCleanupServices> {
  nextEnv.loadEnvConfig(process.cwd());
  const [operation, purgeRepository, purgeService, database] =
    await Promise.all([
      import("@/lib/db/operation"),
      import("@/features/trash/trash-purge-repository"),
      import("@/features/trash/trash-purge-service"),
      import("@/lib/db/client"),
    ]);
  return {
    listPendingOperations: operation.listPendingOperations,
    parsePendingPurgeOperation: purgeService.parsePendingPurgeOperation,
    listExpiredTrashTargets: purgeRepository.listExpiredTrashTargets,
    purgePatterns: purgeService.purgePatterns,
    purgeFolderBatch: purgeService.purgeFolderBatch,
    closeDatabase: database.closeDatabase,
  };
}

async function main() {
  const services = await loadServices();
  try {
    const result = await runTrashCleanup({
      services,
      now: new Date(),
      createOperationId: randomUUID,
      reportError: (context, error) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`${context}: ${message}`);
      },
    });
    console.log(
      `Trash cleanup processed ${result.processed} batch(es); ${result.failures} failed.`,
    );
    if (result.failures > 0) process.exitCode = 1;
  } finally {
    await services.closeDatabase();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Trash cleanup failed.");
    process.exitCode = 1;
  });
}
