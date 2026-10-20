import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  parseBackfillArgs,
  runImageSearchBackfill,
  runImageSearchBackfillCli,
  type ImageSearchBackfillCandidate,
  type ImageSearchBackfillServices,
} from "./backfill-image-search";

const NOW = new Date("2026-10-20T09:00:00.000Z");

function uuid(value: number) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function candidate(index: number): ImageSearchBackfillCandidate {
  return {
    ownerId: uuid(index % 2 === 0 ? 1 : 2),
    patternId: uuid(index + 10),
    previewAssetId: uuid(index + 10_000),
  };
}

type TestTransaction = { page: number };

function servicesForPages(
  pages: ImageSearchBackfillCandidate[][],
): ImageSearchBackfillServices<TestTransaction> & {
  transactionCount: () => number;
} {
  let page = 0;
  let transactionCount = 0;
  return {
    transactionCount: () => transactionCount,
    transaction: async (work) => {
      transactionCount += 1;
      return work({ page: page++ });
    },
    listCandidates: vi.fn(async (tx) => {
      const candidates = pages[tx.page] ?? [];
      return {
        candidates,
        scanned: candidates.length,
        nextCursor: candidates.at(-1) ?? null,
      };
    }),
    enqueue: vi.fn(async () => ({ inserted: true as const, jobId: uuid(99) })),
    closeDatabase: vi.fn(async () => undefined),
  };
}

describe("image search backfill command", () => {
  it("requires exactly one canonical --version argument", () => {
    expect(parseBackfillArgs(["--version", "visual-search-v2"])).toEqual({
      version: "visual-search-v2",
    });

    for (const args of [
      [],
      ["--version"],
      ["--unknown", "visual-search-v2"],
      ["--version", "visual-search-v2", "extra"],
      ["--version", "v1", "--version", "v2"],
      ["--version", "Visual-Search-V2"],
      ["--version", "visual_search_v2"],
      ["--version", "x".repeat(65)],
    ]) {
      expect(() => parseBackfillArgs(args)).toThrow(
        "IMAGE_SEARCH_BACKFILL_ARGUMENTS_INVALID",
      );
    }
  });

  it("validates arguments before loading database services", async () => {
    const loadServices = vi.fn();
    const stdout = vi.fn();

    await expect(
      runImageSearchBackfillCli({
        args: ["--unknown", "visual-search-v2"],
        loadServices,
        now: () => NOW,
        stdout,
      }),
    ).rejects.toThrow("IMAGE_SEARCH_BACKFILL_ARGUMENTS_INVALID");
    expect(loadServices).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("uses stable 500-row keyset pages and deterministic counts", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => candidate(index));
    const secondPage = [candidate(500), candidate(501)];
    const services = servicesForPages([firstPage, secondPage]);
    vi.mocked(services.enqueue).mockImplementation(async (_tx, input) => {
      const inserted = Number.parseInt(input.patternId.slice(-1), 16) % 2 === 0;
      return inserted
        ? { inserted: true, jobId: uuid(50_000) }
        : { inserted: false, jobId: null };
    });

    const result = await runImageSearchBackfill({
      version: "visual-search-v2",
      services,
      now: () => NOW,
    });

    expect(result).toEqual({
      version: "visual-search-v2",
      pages: 2,
      scanned: 502,
      inserted: 251,
      alreadyExisting: 251,
    });
    expect(services.transactionCount()).toBe(2);
    expect(services.listCandidates).toHaveBeenNthCalledWith(
      1,
      { page: 0 },
      { cursor: undefined, limit: 500 },
    );
    expect(services.listCandidates).toHaveBeenNthCalledWith(
      2,
      { page: 1 },
      { cursor: firstPage[499], limit: 500 },
    );
    expect(services.enqueue).toHaveBeenCalledTimes(502);
    expect(services.enqueue).toHaveBeenLastCalledWith(
      { page: 1 },
      {
        ...secondPage[1],
        indexVersion: "visual-search-v2",
        now: NOW,
      },
    );
  });

  it("advances from the raw full-page cursor when revalidation removes a candidate", async () => {
    const rawFirstPage = Array.from({ length: 500 }, (_, index) =>
      candidate(index),
    );
    const validFirstPage = rawFirstPage.slice(0, -1);
    const secondPage = [candidate(500)];
    const transactions: TestTransaction[] = [];
    const listCandidates = vi.fn(
      async (
        _tx: TestTransaction,
        input: { cursor?: ImageSearchBackfillCandidate; limit: number },
      ) => {
        if (!input.cursor) {
          return {
            candidates: validFirstPage,
            scanned: rawFirstPage.length,
            nextCursor: rawFirstPage.at(-1)!,
          };
        }
        expect(input.cursor).toEqual(rawFirstPage.at(-1));
        return {
          candidates: secondPage,
          scanned: secondPage.length,
          nextCursor: secondPage.at(-1)!,
        };
      },
    );
    const services = {
      transaction: async <T>(work: (tx: TestTransaction) => Promise<T>) => {
        const tx = { page: transactions.length };
        transactions.push(tx);
        return work(tx);
      },
      listCandidates,
      enqueue: vi.fn(async () => ({
        inserted: true as const,
        jobId: uuid(70_000),
      })),
      closeDatabase: vi.fn(async () => undefined),
    } satisfies ImageSearchBackfillServices<TestTransaction>;

    await expect(
      runImageSearchBackfill({
        version: "visual-search-v2",
        services,
        now: () => NOW,
      }),
    ).resolves.toEqual({
      version: "visual-search-v2",
      pages: 2,
      scanned: 501,
      inserted: 500,
      alreadyExisting: 0,
    });
    expect(transactions).toHaveLength(2);
    expect(listCandidates).toHaveBeenCalledTimes(2);
    expect(services.enqueue).toHaveBeenCalledTimes(500);
  });

  it("continues when a full raw page revalidates to no candidates", async () => {
    const rawFirstPage = Array.from({ length: 500 }, (_, index) =>
      candidate(index),
    );
    const secondPage = [candidate(500)];
    const services = servicesForPages([]);
    vi.mocked(services.listCandidates)
      .mockResolvedValueOnce({
        candidates: [],
        scanned: rawFirstPage.length,
        nextCursor: rawFirstPage.at(-1)!,
      })
      .mockResolvedValueOnce({
        candidates: secondPage,
        scanned: secondPage.length,
        nextCursor: secondPage.at(-1)!,
      });

    await expect(
      runImageSearchBackfill({
        version: "visual-search-v2",
        services,
        now: () => NOW,
      }),
    ).resolves.toEqual({
      version: "visual-search-v2",
      pages: 2,
      scanned: 501,
      inserted: 1,
      alreadyExisting: 0,
    });
    expect(services.transactionCount()).toBe(2);
    expect(services.listCandidates).toHaveBeenNthCalledWith(
      2,
      { page: 1 },
      { cursor: rawFirstPage.at(-1), limit: 500 },
    );
    expect(services.enqueue).toHaveBeenCalledOnce();
  });

  it("is idempotent across two runs and does not alter other versions", async () => {
    const rows = [candidate(1), candidate(2), candidate(3)];
    const otherVersionIdentity = [
      rows[0]!.ownerId,
      rows[0]!.patternId,
      rows[0]!.previewAssetId,
      "visual-search-old",
    ].join(":");
    const otherVersionJob = Object.freeze({
      identity: otherVersionIdentity,
      status: "ready",
      attemptCount: 2,
      updatedAt: new Date("2026-10-19T08:00:00.000Z"),
    });
    const jobs = new Map<
      string,
      Readonly<{
        identity: string;
        status: string;
        attemptCount: number;
        updatedAt: Date;
      }>
    >([[otherVersionIdentity, otherVersionJob]]);
    const services = servicesForPages([rows, rows]);
    vi.mocked(services.listCandidates).mockImplementation(async () => ({
      candidates: rows,
      scanned: rows.length,
      nextCursor: rows.at(-1)!,
    }));
    vi.mocked(services.enqueue).mockImplementation(async (_tx, input) => {
      const identity = [
        input.ownerId,
        input.patternId,
        input.previewAssetId,
        input.indexVersion,
      ].join(":");
      const inserted = !jobs.has(identity);
      if (inserted) {
        jobs.set(identity, {
          identity,
          status: "pending",
          attemptCount: 0,
          updatedAt: input.now,
        });
      }
      return inserted
        ? { inserted: true, jobId: uuid(60_000 + jobs.size) }
        : { inserted: false, jobId: null };
    });

    const first = await runImageSearchBackfill({
      version: "visual-search-v2",
      services,
      now: () => NOW,
    });
    const second = await runImageSearchBackfill({
      version: "visual-search-v2",
      services,
      now: () => NOW,
    });

    expect(first).toEqual({
      version: "visual-search-v2",
      pages: 1,
      scanned: 3,
      inserted: 3,
      alreadyExisting: 0,
    });
    expect(second).toEqual({
      version: "visual-search-v2",
      pages: 1,
      scanned: 3,
      inserted: 0,
      alreadyExisting: 3,
    });
    expect(jobs.size).toBe(4);
    expect(jobs.get(otherVersionIdentity)).toBe(otherVersionJob);
    expect(jobs.get(otherVersionIdentity)).toEqual({
      identity: otherVersionIdentity,
      status: "ready",
      attemptCount: 2,
      updatedAt: new Date("2026-10-19T08:00:00.000Z"),
    });
    expect(
      [...jobs.keys()].filter((identity) =>
        identity.endsWith(":visual-search-v2"),
      ),
    ).toHaveLength(3);
  });

  it("prints one JSON result and always closes database services", async () => {
    const services = servicesForPages([[candidate(1)]]);
    const stdout = vi.fn();

    await expect(
      runImageSearchBackfillCli({
        args: ["--version", "visual-search-v2"],
        loadServices: async () => services,
        now: () => NOW,
        stdout,
      }),
    ).resolves.toEqual({
      version: "visual-search-v2",
      pages: 1,
      scanned: 1,
      inserted: 1,
      alreadyExisting: 0,
    });
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({
        version: "visual-search-v2",
        pages: 1,
        scanned: 1,
        inserted: 1,
        alreadyExisting: 0,
      }),
    );
    expect(services.closeDatabase).toHaveBeenCalledOnce();
  });

  it("closes database services when a page fails", async () => {
    const services = servicesForPages([]);
    vi.mocked(services.listCandidates).mockRejectedValueOnce(
      new Error("DATABASE_UNAVAILABLE_WITH_SECRET_DETAILS"),
    );
    const stdout = vi.fn();

    await expect(
      runImageSearchBackfillCli({
        args: ["--version", "visual-search-v2"],
        loadServices: async () => services,
        now: () => NOW,
        stdout,
      }),
    ).rejects.toThrow("DATABASE_UNAVAILABLE_WITH_SECRET_DETAILS");
    expect(stdout).not.toHaveBeenCalled();
    expect(services.closeDatabase).toHaveBeenCalledOnce();
  });

  it("does not print a success result when closing the database fails", async () => {
    const services = servicesForPages([[candidate(1)]]);
    const closeError = new Error("DATABASE_CLOSE_FAILED_WITH_SECRET_DETAILS");
    vi.mocked(services.closeDatabase).mockRejectedValueOnce(closeError);
    const stdout = vi.fn();

    await expect(
      runImageSearchBackfillCli({
        args: ["--version", "visual-search-v2"],
        loadServices: async () => services,
        now: () => NOW,
        stdout,
      }),
    ).rejects.toBe(closeError);
    expect(stdout).not.toHaveBeenCalled();
    expect(services.closeDatabase).toHaveBeenCalledOnce();
  });

  it("preserves the operation error when closing the database also fails", async () => {
    const services = servicesForPages([]);
    const operationError = new Error(
      "DATABASE_OPERATION_FAILED_WITH_SECRET_DETAILS",
    );
    const closeError = new Error("DATABASE_CLOSE_FAILED_WITH_SECRET_DETAILS");
    vi.mocked(services.listCandidates).mockRejectedValueOnce(operationError);
    vi.mocked(services.closeDatabase).mockRejectedValueOnce(closeError);
    const stdout = vi.fn();

    await expect(
      runImageSearchBackfillCli({
        args: ["--version", "visual-search-v2"],
        loadServices: async () => services,
        now: () => NOW,
        stdout,
      }),
    ).rejects.toBe(operationError);
    expect(stdout).not.toHaveBeenCalled();
    expect(services.closeDatabase).toHaveBeenCalledOnce();
  });

  it("exits nonzero with a safe message when invoked with invalid arguments", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "scripts/backfill-image-search.ts",
        "--unknown",
        "visual-search-v2",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("IMAGE_SEARCH_BACKFILL_ARGUMENTS_INVALID");
  });
});
