import { describe, expect, it } from "vitest";

import {
  extractTrustedClientIp,
  hashLoginRateLimitKey,
  LOGIN_RATE_LIMIT_POLICIES,
  nextLoginRateLimitFailure,
} from "./login-rate-limit";

const now = new Date("2026-10-23T08:00:00Z");

describe("login rate limit keys", () => {
  it("hashes normalized account identifiers without retaining the source", () => {
    const secret = "s".repeat(32);
    const lower = hashLoginRateLimitKey(
      "account",
      "owner@example.test",
      secret,
    );
    const mixed = hashLoginRateLimitKey(
      "account",
      "  Owner@Example.Test  ",
      secret,
    );

    expect(lower).toMatch(/^[a-f0-9]{64}$/);
    expect(lower).toBe(mixed);
    expect(lower).not.toContain("owner");
  });

  it("separates account and IP key namespaces", () => {
    const secret = "s".repeat(32);

    expect(hashLoginRateLimitKey("account", "same", secret)).not.toBe(
      hashLoginRateLimitKey("ip", "same", secret),
    );
  });
});

describe("trusted client IP extraction", () => {
  it("ignores proxy headers unless trust is explicitly enabled", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7, 127.0.0.1",
    });

    expect(extractTrustedClientIp(headers, false)).toBeUndefined();
    expect(extractTrustedClientIp(headers, true)).toBe("203.0.113.7");
  });

  it("accepts IPv6 and trims the left-most forwarded address", () => {
    const headers = new Headers({
      "x-forwarded-for": " 2001:db8::7 , 127.0.0.1",
    });

    expect(extractTrustedClientIp(headers, true)).toBe("2001:db8::7");
  });

  it("uses x-real-ip only when a valid forwarded IP is unavailable", () => {
    const headers = new Headers({
      "x-forwarded-for": "not-an-ip",
      "x-real-ip": "198.51.100.12",
    });

    expect(extractTrustedClientIp(headers, true)).toBe("198.51.100.12");
  });

  it.each([
    new Headers({ "x-forwarded-for": "not-an-ip" }),
    new Headers({ "x-forwarded-for": "203.0.113.7:443" }),
    new Headers({ "x-real-ip": "unknown" }),
  ])("rejects invalid proxy IP input", (headers) => {
    expect(extractTrustedClientIp(headers, true)).toBeUndefined();
  });
});

describe("login rate limit state transitions", () => {
  it("blocks the fifth account failure for fifteen minutes", () => {
    const next = nextLoginRateLimitFailure({
      scope: "account",
      current: {
        failureCount: 4,
        windowStartedAt: new Date("2026-10-23T07:55:00Z"),
        blockedUntil: null,
      },
      now,
    });

    expect(next.failureCount).toBe(5);
    expect(next.blockedUntil).toEqual(
      new Date(now.getTime() + LOGIN_RATE_LIMIT_POLICIES.account.blockMs),
    );
  });

  it("blocks the twentieth IP failure", () => {
    const next = nextLoginRateLimitFailure({
      scope: "ip",
      current: {
        failureCount: 19,
        windowStartedAt: new Date("2026-10-23T07:50:00Z"),
        blockedUntil: null,
      },
      now,
    });

    expect(next.failureCount).toBe(20);
    expect(next.blockedUntil).toEqual(new Date("2026-10-23T08:15:00Z"));
  });

  it("resets a window once it expires", () => {
    expect(
      nextLoginRateLimitFailure({
        scope: "account",
        current: {
          failureCount: 4,
          windowStartedAt: new Date("2026-10-23T07:45:00Z"),
          blockedUntil: null,
        },
        now,
      }),
    ).toEqual({
      failureCount: 1,
      windowStartedAt: now,
      blockedUntil: null,
    });
  });

  it("preserves an active block without extending it", () => {
    const current = {
      failureCount: 5,
      windowStartedAt: new Date("2026-10-23T07:55:00Z"),
      blockedUntil: new Date("2026-10-23T08:05:00Z"),
    };

    expect(
      nextLoginRateLimitFailure({ scope: "account", current, now }),
    ).toEqual(current);
  });

  it("starts a new window after a block expires", () => {
    expect(
      nextLoginRateLimitFailure({
        scope: "account",
        current: {
          failureCount: 5,
          windowStartedAt: new Date("2026-10-23T07:30:00Z"),
          blockedUntil: now,
        },
        now,
      }),
    ).toEqual({
      failureCount: 1,
      windowStartedAt: now,
      blockedUntil: null,
    });
  });
});
