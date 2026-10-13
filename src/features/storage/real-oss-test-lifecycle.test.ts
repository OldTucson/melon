import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchBytesWithTimeout,
  runRealOssTestLifecycle,
  runRequestWithTimeout,
} from "./real-oss-test-lifecycle";

afterEach(() => {
  vi.useRealTimers();
});

describe("real OSS test lifecycle", () => {
  it("wires the real OSS suite through independent body, fetch, and cleanup deadlines", async () => {
    const source = await readFile(
      path.resolve(
        process.cwd(),
        "src/features/storage/oss-adapter.real.integration.test.ts",
      ),
      "utf8",
    );

    expect(source).toMatch(/runRealOssTestLifecycle\(\{/);
    expect(source).toMatch(
      /bodyTimeoutMs:\s*REAL_OSS_TEST_BODY_TIMEOUT_MS/,
    );
    expect(source).toMatch(
      /cleanupTimeoutMs:\s*REAL_OSS_TEST_CLEANUP_TIMEOUT_MS/,
    );
    expect(source).toMatch(
      /shutdownTimeoutMs:\s*REAL_OSS_TEST_SHUTDOWN_TIMEOUT_MS/,
    );
    expect(source).toMatch(
      /runRequestWithTimeout\(\s*\(\)\s*=>\s*issuer\.issue\(\{ ownerId, patternId \}\),\s*UPLOAD_REQUEST_TIMEOUT_MS/,
    );
    expect(source).toMatch(
      /fetchBytesWithTimeout\([\s\S]*timeoutMs:\s*UPLOAD_REQUEST_TIMEOUT_MS/,
    );
    expect(
      source.match(/signal\.throwIfAborted\(\)/g)?.length,
    ).toBeGreaterThanOrEqual(8);
    expect(source).toMatch(
      /uploadId\s*=\s*initiated\.uploadId;\s*signal\.throwIfAborted\(\)/,
    );
    expect(source).toMatch(/completed\s*=\s*true;\s*signal\.throwIfAborted\(\)/);
    expect(source).toMatch(/retryMax:\s*0/);
  });

  it("times out a non-abortable request and consumes its late rejection", async () => {
    vi.useFakeTimers();
    let rejectRequest!: (error: Error) => void;
    let continued = false;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const result = (async () => {
        await runRequestWithTimeout(
          () =>
            new Promise<never>((_resolve, reject) => {
              rejectRequest = reject;
            }),
          10,
        );
        continued = true;
      })();
      const rejection = expect(result).rejects.toMatchObject({
        code: "REAL_OSS_REQUEST_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(continued).toBe(false);

      vi.useRealTimers();
      rejectRequest(new Error("late STS rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(continued).toBe(false);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each([
    ["body", { bodyTimeoutMs: 0 }],
    ["shutdown", { shutdownTimeoutMs: 0 }],
    ["cleanup", { cleanupTimeoutMs: 0 }],
  ])("validates the %s timeout before starting any work", async (_name, override) => {
    const body = vi.fn(async () => "uploaded");
    const cleanup = vi.fn(async () => undefined);

    await expect(
      runRealOssTestLifecycle({
        body,
        bodyTimeoutMs: 10,
        cancelBody: () => undefined,
        cleanup,
        cleanupTimeoutMs: 10,
        shutdownTimeoutMs: 10,
        ...override,
      }),
    ).rejects.toThrow("REAL_OSS_TIMEOUT_INVALID");

    expect(body).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("waits for a timed-out body to stop before cleanup", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let bodySignal: AbortSignal | undefined;
    const result = runRealOssTestLifecycle({
      body: async (signal) => {
        bodySignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("aborted");
              setTimeout(() => {
                events.push("late-write");
                resolve();
              }, 5);
            },
            { once: true },
          );
        });
        events.push("body-stopped");
      },
      bodyTimeoutMs: 10,
      cancelBody: () => {
        events.push("cancelled");
      },
      cleanup: async () => {
        events.push("cleanup");
      },
      cleanupTimeoutMs: 10,
      shutdownTimeoutMs: 20,
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: "REAL_OSS_BODY_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual(["aborted", "cancelled"]);

    await vi.advanceTimersByTimeAsync(5);
    await rejection;

    expect(bodySignal?.aborted).toBe(true);
    expect(events).toEqual([
      "aborted",
      "cancelled",
      "late-write",
      "body-stopped",
      "cleanup",
    ]);
  });

  it("does not clean up if a timed-out body cannot become quiescent", async () => {
    vi.useFakeTimers();
    let rejectBody!: (error: Error) => void;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const cleanup = vi.fn(async () => undefined);

    try {
      const result = runRealOssTestLifecycle({
        body: () =>
          new Promise<never>((_resolve, reject) => {
            rejectBody = reject;
          }),
        bodyTimeoutMs: 10,
        cancelBody: () => undefined,
        cleanup,
        cleanupTimeoutMs: 10,
        shutdownTimeoutMs: 20,
      });
      const rejection = expect(result).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.some(
            (item) =>
              item instanceof Error &&
              "code" in item &&
              item.code === "REAL_OSS_BODY_SHUTDOWN_TIMEOUT",
          ),
      );

      await vi.advanceTimersByTimeAsync(30);
      await rejection;
      expect(cleanup).not.toHaveBeenCalled();

      vi.useRealTimers();
      rejectBody(new Error("late body rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("gives cleanup its own deadline after a successful body", async () => {
    vi.useFakeTimers();
    const result = runRealOssTestLifecycle({
      body: async () => "uploaded",
      bodyTimeoutMs: 10,
      cancelBody: () => undefined,
      cleanup: () => new Promise<never>(() => undefined),
      cleanupTimeoutMs: 20,
      shutdownTimeoutMs: 10,
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: "REAL_OSS_CLEANUP_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(20);
    await rejection;
  });

  it("consumes a cleanup rejection that arrives after its deadline", async () => {
    vi.useFakeTimers();
    let rejectCleanup!: (error: Error) => void;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const result = runRealOssTestLifecycle({
        body: async () => "uploaded",
        bodyTimeoutMs: 10,
        cancelBody: () => undefined,
        cleanup: () =>
          new Promise<never>((_resolve, reject) => {
            rejectCleanup = reject;
          }),
        cleanupTimeoutMs: 10,
        shutdownTimeoutMs: 10,
      });
      const rejection = expect(result).rejects.toMatchObject({
        code: "REAL_OSS_CLEANUP_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);

      vi.useRealTimers();
      rejectCleanup(new Error("late cleanup rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("keeps body and cleanup failures observable together", async () => {
    const bodyError = new Error("body failed");
    const cleanupError = new Error("cleanup failed");

    await expect(
      runRealOssTestLifecycle({
        body: async () => {
          throw bodyError;
        },
        bodyTimeoutMs: 10,
        cancelBody: () => undefined,
        cleanup: async () => {
          throw cleanupError;
        },
        cleanupTimeoutMs: 10,
        shutdownTimeoutMs: 10,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.includes(bodyError) &&
        error.errors.includes(cleanupError),
    );
  });

  it("does not swallow a cleanup that rejects without an error value", async () => {
    let rejected = false;
    try {
      await runRealOssTestLifecycle({
        body: async () => "uploaded",
        bodyTimeoutMs: 10,
        cancelBody: () => undefined,
        cleanup: () => Promise.reject(undefined),
        cleanupTimeoutMs: 10,
        shutdownTimeoutMs: 10,
      });
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);
  });

  it("aborts a signed download at its independent request deadline", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener(
            "abort",
            () => reject(fetchSignal?.reason),
            { once: true },
          );
        });
      },
    );
    const result = fetchBytesWithTimeout("https://assets.example.test/file", {
      fetchImplementation,
      timeoutMs: 10,
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: "REAL_OSS_FETCH_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    expect(fetchSignal?.aborted).toBe(true);
  });
});
