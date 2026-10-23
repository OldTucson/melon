import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { authLoginRateLimits } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const bucketValues = () => ({
  keyHash: randomBytes(32).toString("hex"),
  scope: "account" as const,
  failureCount: 1,
  windowStartedAt: new Date("2026-10-23T00:00:00Z"),
  updatedAt: new Date("2026-10-23T00:00:00Z"),
});

describe("auth login rate limit schema", () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(closeDatabase);

  it("stores a canonical HMAC bucket", async () => {
    await db.insert(authLoginRateLimits).values(bucketValues());

    await expect(db.select().from(authLoginRateLimits)).resolves.toHaveLength(1);
  });

  it.each([
    [
      "bad scope",
      sql`insert into auth_login_rate_limits (key_hash, scope, failure_count, window_started_at, updated_at) values (${"a".repeat(64)}, 'device', 1, now(), now())`,
    ],
    [
      "bad hash",
      sql`insert into auth_login_rate_limits (key_hash, scope, failure_count, window_started_at, updated_at) values ('raw-email', 'account', 1, now(), now())`,
    ],
    [
      "bad count",
      sql`insert into auth_login_rate_limits (key_hash, scope, failure_count, window_started_at, updated_at) values (${"b".repeat(64)}, 'ip', 0, now(), now())`,
    ],
  ])("rejects %s", async (_name, statement) => {
    await expect(db.execute(statement)).rejects.toThrow();
  });

  it("rejects duplicate bucket keys", async () => {
    const values = bucketValues();
    await db.insert(authLoginRateLimits).values(values);

    await expect(db.insert(authLoginRateLimits).values(values)).rejects.toThrow();
  });
});
