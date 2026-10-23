import { describe, expect, it, vi } from "vitest";

import { runAuthRateLimitCleanup } from "./cleanup-auth-rate-limits";

describe("runAuthRateLimitCleanup", () => {
  it("deletes buckets inactive for more than twenty-four hours", async () => {
    const now = new Date("2026-10-23T08:00:00Z");
    const cleanup = vi.fn().mockResolvedValue(3);

    await expect(
      runAuthRateLimitCleanup({ now, cleanup }),
    ).resolves.toEqual({ deleted: 3 });
    expect(cleanup).toHaveBeenCalledWith(
      new Date("2026-10-22T08:00:00Z"),
      now,
    );
  });

  it("propagates cleanup failures to the command boundary", async () => {
    const failure = new Error("database unavailable");

    await expect(
      runAuthRateLimitCleanup({
        now: new Date("2026-10-23T08:00:00Z"),
        cleanup: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);
  });
});
