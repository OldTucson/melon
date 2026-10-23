import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const authLoginRateLimits = pgTable(
  "auth_login_rate_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    scope: text("scope").notNull(),
    failureCount: integer("failure_count").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "auth_login_rate_limits_hash_check",
      sql`${table.keyHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "auth_login_rate_limits_scope_check",
      sql`${table.scope} in ('account', 'ip')`,
    ),
    check(
      "auth_login_rate_limits_failure_count_check",
      sql`${table.failureCount} > 0`,
    ),
    index("auth_login_rate_limits_updated_at_idx").on(table.updatedAt),
  ],
);
