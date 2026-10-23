import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { verifyPassword } from "@/features/auth/password";
import {
  extractTrustedClientIp,
  hashLoginRateLimitKey,
} from "@/features/auth/login-rate-limit";
import {
  clearLoginRateLimits,
  isAnyLoginRateLimitBlocked,
  recordLoginRateLimitFailures,
  type LoginRateLimitBucket,
} from "@/features/auth/login-rate-limit-repository";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { getServerEnv } from "@/lib/env/server";

const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

// A fixed valid hash keeps unknown and disabled accounts on the Argon2 path.
const dummyPasswordHash =
  "$argon2id$v=19$m=65536,p=1,t=3$Do/XJZTUltcGcuT5J6dZ5g$zkyuV7RbIP7YmFJa1z1Gq2a7jupJRezi9cjNkcA8Qys";

export async function authorizeCredentials(raw: unknown, request?: Request) {
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) return null;

  const env = getServerEnv();

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      status: users.status,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1);

  const eligibleUser = user?.status === "active" ? user : null;
  const buckets: LoginRateLimitBucket[] = [];
  if (user) {
    buckets.push({
      keyHash: hashLoginRateLimitKey(
        "account",
        parsed.data.email,
        env.AUTH_SECRET,
      ),
      scope: "account",
    });
  }
  const clientIp = request
    ? extractTrustedClientIp(request.headers, env.AUTH_TRUST_PROXY)
    : undefined;
  if (clientIp) {
    buckets.push({
      keyHash: hashLoginRateLimitKey("ip", clientIp, env.AUTH_SECRET),
      scope: "ip",
    });
  }

  const now = new Date();
  let isBlocked = true;
  let limiterAvailable = true;
  try {
    isBlocked = await isAnyLoginRateLimitBlocked(
      buckets.map(({ keyHash }) => keyHash),
      now,
    );
  } catch {
    limiterAvailable = false;
  }

  const passwordMatches = await verifyPassword(
    parsed.data.password,
    eligibleUser?.passwordHash ?? dummyPasswordHash,
  );

  if (!limiterAvailable || isBlocked) return null;

  if (!eligibleUser || !passwordMatches) {
    try {
      await recordLoginRateLimitFailures({ buckets, now });
    } catch {
      return null;
    }
    return null;
  }

  try {
    await clearLoginRateLimits(buckets.map(({ keyHash }) => keyHash));
  } catch {
    return null;
  }

  return {
    id: eligibleUser.id,
    email: eligibleUser.email,
    name: eligibleUser.displayName,
    sessionVersion: eligibleUser.sessionVersion,
  };
}
