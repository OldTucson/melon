import { describe, expect, it, vi } from "vitest";

import { runTrashCleanup, type TrashCleanupServices } from "./cleanup-trash";

const ownerId = "10000000-0000-4000-8000-000000000001";
const pendingPatternOperationId = "20000000-0000-4000-8000-000000000002";
const pendingFolderOperationId = "30000000-0000-4000-8000-000000000003";
const patternId = "40000000-0000-4000-8000-000000000004";
const folderBatchId = "50000000-0000-4000-8000-000000000005";
const expiredPatternId = "60000000-0000-4000-8000-000000000006";
const expiredBatchId = "70000000-0000-4000-8000-000000000007";
const newOperationId = "80000000-0000-4000-8000-000000000008";

function operation(operationId: string) {
  return {
    ownerId,
    operationId,
    kind: "kind",
    result: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createServices(): TrashCleanupServices {
  return {
    listPendingOperations: vi
      .fn()
      .mockResolvedValueOnce([operation(pendingPatternOperationId)])
      .mockResolvedValueOnce([operation(pendingFolderOperationId)]),
    parsePendingPurgeOperation: vi
      .fn()
      .mockReturnValueOnce({ kind: "patterns", patternIds: [patternId] })
      .mockReturnValueOnce({
        kind: "folder_batch",
        trashBatchId: folderBatchId,
      }),
    listExpiredTrashTargets: vi.fn().mockResolvedValue([
      {
        kind: "patterns",
        ownerId,
        trashBatchId: expiredBatchId,
        patternIds: [expiredPatternId],
      },
    ]),
    purgePatterns: vi.fn().mockResolvedValue({ state: "complete" }),
    purgeFolderBatch: vi.fn().mockResolvedValue({ state: "complete" }),
    closeDatabase: vi.fn().mockResolvedValue(undefined),
  };
}

describe("trash cleanup command", () => {
  it("resumes pending operations first and creates IDs only for expired batches", async () => {
    const services = createServices();
    const calls: string[] = [];
    vi.mocked(services.purgePatterns).mockImplementation(async (input) => {
      calls.push(`patterns:${input.operationId}`);
      return { state: "complete" };
    });
    vi.mocked(services.purgeFolderBatch).mockImplementation(async (input) => {
      calls.push(`folder:${input.operationId}`);
      return { state: "complete" };
    });

    const result = await runTrashCleanup({
      services,
      now: new Date("2026-10-13T00:00:00.000Z"),
      createOperationId: () => newOperationId,
      reportError: vi.fn(),
    });

    expect(result).toEqual({ processed: 3, failures: 0 });
    expect(calls).toEqual([
      `patterns:${pendingPatternOperationId}`,
      `folder:${pendingFolderOperationId}`,
      `patterns:${newOperationId}`,
    ]);
    expect(services.listExpiredTrashTargets).toHaveBeenCalledWith(
      new Date("2026-09-13T00:00:00.000Z"),
    );
  });

  it("isolates failures and reports a nonzero failure count", async () => {
    const services = createServices();
    vi.mocked(services.purgePatterns)
      .mockRejectedValueOnce(new Error("pending failed"))
      .mockResolvedValueOnce({ state: "complete" });
    const reportError = vi.fn();

    const result = await runTrashCleanup({
      services,
      now: new Date("2026-10-13T00:00:00.000Z"),
      createOperationId: () => newOperationId,
      reportError,
    });

    expect(result).toEqual({ processed: 3, failures: 1 });
    expect(services.purgeFolderBatch).toHaveBeenCalledTimes(1);
    expect(services.purgePatterns).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
