import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export type LoginRateLimitScope = "account" | "ip";

export type LoginRateLimitState = {
  failureCount: number;
  windowStartedAt: Date;
  blockedUntil: Date | null;
};

export const LOGIN_RATE_LIMIT_POLICIES = {
  account: { limit: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
  ip: { limit: 20, windowMs: 15 * 60_000, blockMs: 15 * 60_000 },
} as const;

const normalizeIdentifier = (identifier: string) =>
  identifier.trim().toLowerCase();

export function hashLoginRateLimitKey(
  scope: LoginRateLimitScope,
  identifier: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(scope)
    .update("\0")
    .update(normalizeIdentifier(identifier))
    .digest("hex");
}

export function extractTrustedClientIp(
  headers: Headers,
  trustProxy: boolean,
): string | undefined {
  if (!trustProxy) {
    return undefined;
  }

  const forwardedIp = headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  if (forwardedIp && isIP(forwardedIp) !== 0) {
    return forwardedIp;
  }

  const realIp = headers.get("x-real-ip")?.trim();
  return realIp && isIP(realIp) !== 0 ? realIp : undefined;
}

export function nextLoginRateLimitFailure(input: {
  scope: LoginRateLimitScope;
  current?: LoginRateLimitState;
  now: Date;
}): LoginRateLimitState {
  const { current, now, scope } = input;
  const policy = LOGIN_RATE_LIMIT_POLICIES[scope];

  if (!current) {
    return {
      failureCount: 1,
      windowStartedAt: now,
      blockedUntil: null,
    };
  }

  if (current.blockedUntil) {
    if (current.blockedUntil.getTime() > now.getTime()) {
      return { ...current };
    }

    return {
      failureCount: 1,
      windowStartedAt: now,
      blockedUntil: null,
    };
  }

  const elapsedMs = now.getTime() - current.windowStartedAt.getTime();
  if (elapsedMs < 0 || elapsedMs >= policy.windowMs) {
    return {
      failureCount: 1,
      windowStartedAt: now,
      blockedUntil: null,
    };
  }

  const failureCount = current.failureCount + 1;
  return {
    failureCount,
    windowStartedAt: current.windowStartedAt,
    blockedUntil:
      failureCount >= policy.limit
        ? new Date(now.getTime() + policy.blockMs)
        : null,
  };
}
