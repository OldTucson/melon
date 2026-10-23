import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupExpiredLoginRateLimits,
  clearLoginRateLimits,
  isAnyLoginRateLimitBlocked,
  recordLoginRateLimitFailures,
} from "@/features/auth/login-rate-limit-repository";
import { hashLoginRateLimitKey } from "@/features/auth/login-rate-limit";
import { closeDatabase, db } from "@/lib/db/client";
import { authLoginRateLimits } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const secret = "rate-limit-test-secret".repeat(2);
const now = new Date("2026-10-23T08:00:00Z");
const account = {
  keyHash: hashLoginRateLimitKey(
    "account",
    "owner@example.test",
    secret,
  ),
  scope: "account" as const,
};
const ip = {
  keyHash: hashLoginRateLimitKey("ip", "203.0.113.7", secret),
  scope: "ip" as const,
};

describe("login rate limit repository", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("blocks an account at its threshold and clears it", async () => {
    await recordLoginRateLimitFailures({ buckets: [account], now });
    expect(
      await isAnyLoginRateLimitBlocked([account.keyHash], now),
    ).toBe(false);

    for (let attempt = 1; attempt < 5; attempt += 1) {
      await recordLoginRateLimitFailures({ buckets: [account], now });
    }

    expect(
      await isAnyLoginRateLimitBlocked([account.keyHash], now),
    ).toBe(true);

    await clearLoginRateLimits([account.keyHash]);
    expect(
      await isAnyLoginRateLimitBlocked([account.keyHash], now),
    ).toBe(false);
  });

  it("serializes concurrent failures without losing updates", async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        recordLoginRateLimitFailures({ buckets: [account], now }),
      ),
    );

    const [stored] = await db
      .select()
      .from(authLoginRateLimits)
      .where(eq(authLoginRateLimits.keyHash, account.keyHash));

    expect(stored).toMatchObject({
      scope: "account",
      failureCount: 5,
      blockedUntil: new Date("2026-10-23T08:15:00Z"),
    });
  });

  it("keeps account and IP buckets isolated", async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        recordLoginRateLimitFailures({ buckets: [account], now }),
      ),
    );
    await recordLoginRateLimitFailures({ buckets: [ip], now });

    expect(
      await isAnyLoginRateLimitBlocked([account.keyHash], now),
    ).toBe(true);
    expect(await isAnyLoginRateLimitBlocked([ip.keyHash], now)).toBe(false);
  });

  it("cleans only stale buckets that are no longer actively blocked", async () => {
    const cutoff = new Date("2026-10-22T08:00:00Z");
    const staleInactive = hashLoginRateLimitKey("ip", "203.0.113.8", secret);
    const staleExpiredBlock = hashLoginRateLimitKey(
      "ip",
      "203.0.113.9",
      secret,
    );
    const staleActiveBlock = hashLoginRateLimitKey(
      "ip",
      "203.0.113.10",
      secret,
    );
    const recentInactive = hashLoginRateLimitKey(
      "ip",
      "203.0.113.11",
      secret,
    );

    await db.insert(authLoginRateLimits).values([
      {
        keyHash: staleInactive,
        scope: "ip",
        failureCount: 1,
        windowStartedAt: new Date("2026-10-21T06:00:00Z"),
        blockedUntil: null,
        updatedAt: new Date("2026-10-21T07:00:00Z"),
      },
      {
        keyHash: staleExpiredBlock,
        scope: "ip",
        failureCount: 20,
        windowStartedAt: new Date("2026-10-21T06:00:00Z"),
        blockedUntil: new Date("2026-10-21T07:15:00Z"),
        updatedAt: new Date("2026-10-21T07:00:00Z"),
      },
      {
        keyHash: staleActiveBlock,
        scope: "ip",
        failureCount: 20,
        windowStartedAt: new Date("2026-10-21T06:00:00Z"),
        blockedUntil: new Date("2026-10-23T08:15:00Z"),
        updatedAt: new Date("2026-10-21T07:00:00Z"),
      },
      {
        keyHash: recentInactive,
        scope: "ip",
        failureCount: 1,
        windowStartedAt: new Date("2026-10-23T07:00:00Z"),
        blockedUntil: null,
        updatedAt: new Date("2026-10-23T07:00:00Z"),
      },
    ]);

    await expect(
      cleanupExpiredLoginRateLimits({ cutoff, now }),
    ).resolves.toBe(2);

    const remaining = await db
      .select({ keyHash: authLoginRateLimits.keyHash })
      .from(authLoginRateLimits);
    expect(remaining.map(({ keyHash }) => keyHash).sort()).toEqual(
      [recentInactive, staleActiveBlock].sort(),
    );
  });

  it("treats an empty bucket list as unblocked", async () => {
    await expect(isAnyLoginRateLimitBlocked([], now)).resolves.toBe(false);
    await expect(clearLoginRateLimits([])).resolves.toBeUndefined();
  });
});
