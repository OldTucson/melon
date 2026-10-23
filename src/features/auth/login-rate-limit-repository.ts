import "server-only";

import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  nextLoginRateLimitFailure,
  type LoginRateLimitScope,
} from "@/features/auth/login-rate-limit";
import { db } from "@/lib/db/client";
import { authLoginRateLimits } from "@/lib/db/schema";

export type LoginRateLimitBucket = {
  keyHash: string;
  scope: LoginRateLimitScope;
};

export async function isAnyLoginRateLimitBlocked(
  keyHashes: string[],
  now: Date,
): Promise<boolean> {
  if (keyHashes.length === 0) return false;

  const [blocked] = await db
    .select({ keyHash: authLoginRateLimits.keyHash })
    .from(authLoginRateLimits)
    .where(
      and(
        inArray(authLoginRateLimits.keyHash, keyHashes),
        gt(authLoginRateLimits.blockedUntil, now),
      ),
    )
    .limit(1);

  return blocked !== undefined;
}

export async function recordLoginRateLimitFailures(input: {
  buckets: LoginRateLimitBucket[];
  now: Date;
}): Promise<void> {
  const buckets = [
    ...new Map(input.buckets.map((bucket) => [bucket.keyHash, bucket])).values(),
  ].sort((left, right) => left.keyHash.localeCompare(right.keyHash));

  if (buckets.length === 0) return;

  await db.transaction(async (tx) => {
    for (const bucket of buckets) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${bucket.keyHash}, 0))`,
      );

      const [current] = await tx
        .select({
          failureCount: authLoginRateLimits.failureCount,
          windowStartedAt: authLoginRateLimits.windowStartedAt,
          blockedUntil: authLoginRateLimits.blockedUntil,
        })
        .from(authLoginRateLimits)
        .where(eq(authLoginRateLimits.keyHash, bucket.keyHash))
        .limit(1);
      const next = nextLoginRateLimitFailure({
        scope: bucket.scope,
        current,
        now: input.now,
      });

      await tx
        .insert(authLoginRateLimits)
        .values({
          keyHash: bucket.keyHash,
          scope: bucket.scope,
          ...next,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: authLoginRateLimits.keyHash,
          set: {
            scope: bucket.scope,
            failureCount: next.failureCount,
            windowStartedAt: next.windowStartedAt,
            blockedUntil: next.blockedUntil,
            updatedAt: input.now,
          },
        });
    }
  });
}

export async function clearLoginRateLimits(keyHashes: string[]): Promise<void> {
  if (keyHashes.length === 0) return;

  await db
    .delete(authLoginRateLimits)
    .where(inArray(authLoginRateLimits.keyHash, keyHashes));
}

export async function cleanupExpiredLoginRateLimits(input: {
  cutoff: Date;
  now: Date;
}): Promise<number> {
  const deleted = await db
    .delete(authLoginRateLimits)
    .where(
      and(
        lt(authLoginRateLimits.updatedAt, input.cutoff),
        or(
          isNull(authLoginRateLimits.blockedUntil),
          lte(authLoginRateLimits.blockedUntil, input.now),
        ),
      ),
    )
    .returning({ keyHash: authLoginRateLimits.keyHash });

  return deleted.length;
}
