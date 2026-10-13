import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.select },
}));

import { listPendingOperations, readOperation } from "./operation";

const ownerId = "10000000-0000-4000-8000-000000000001";

function readBuilder(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
    })),
  };
}

function listBuilder(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue(rows) })),
    })),
  };
}

describe("operation reads", () => {
  beforeEach(() => mocks.select.mockReset());

  it("reads one owner-scoped operation and returns undefined when absent", async () => {
    const operationId = randomUUID();
    const row = {
      ownerId,
      operationId,
      kind: "trash.patterns.purge:fingerprint",
      result: { state: "pending" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.select
      .mockReturnValueOnce(readBuilder([row]))
      .mockReturnValueOnce(readBuilder([]));

    await expect(readOperation(ownerId, operationId)).resolves.toBe(row);
    await expect(readOperation(ownerId, randomUUID())).resolves.toBeUndefined();
  });

  it("lists pending operations for an exact kind prefix in stable order", async () => {
    const rows = [
      {
        ownerId,
        operationId: randomUUID(),
        kind: "trash.patterns.purge:a",
        result: { state: "pending" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    mocks.select.mockReturnValueOnce(listBuilder(rows));

    await expect(
      listPendingOperations("trash.patterns.purge:"),
    ).resolves.toBe(rows);
  });

  it.each(["", "%", "trash._"])(
    "rejects unsafe pending-operation prefix %j",
    async (kindPrefix) => {
      await expect(listPendingOperations(kindPrefix)).rejects.toThrow(
        "OPERATION_KIND_PREFIX_INVALID",
      );
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );
});
