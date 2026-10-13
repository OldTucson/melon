import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchBytesWithTimeout,
  runRealOssTestLifecycle,
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
      /fetchBytesWithTimeout\([\s\S]*timeoutMs:\s*UPLOAD_REQUEST_TIMEOUT_MS/,
    );
    expect(source).toMatch(/retryMax:\s*0/);
  });

  it("cancels a timed-out body and still runs cleanup", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let bodySignal: AbortSignal | undefined;
    const result = runRealOssTestLifecycle({
      body: (signal) => {
        bodySignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("aborted");
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      bodyTimeoutMs: 10,
      cancelBody: () => {
        events.push("cancelled");
      },
      cleanup: async () => {
        events.push("cleanup");
      },
      cleanupTimeoutMs: 10,
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: "REAL_OSS_BODY_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    expect(bodySignal?.aborted).toBe(true);
    expect(events).toContain("cancelled");
    expect(events.at(-1)).toBe("cleanup");
  });

  it("gives cleanup its own deadline after a successful body", async () => {
    vi.useFakeTimers();
    const result = runRealOssTestLifecycle({
      body: async () => "uploaded",
      bodyTimeoutMs: 10,
      cancelBody: () => undefined,
      cleanup: () => new Promise<never>(() => undefined),
      cleanupTimeoutMs: 20,
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: "REAL_OSS_CLEANUP_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(20);
    await rejection;
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
