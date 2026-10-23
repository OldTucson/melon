# Melon Prelaunch Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the known Next.js vulnerability and add durable login throttling, baseline response headers, and core health probes without making visual search a core availability dependency.

**Architecture:** PostgreSQL stores HMAC-keyed login buckets so limits survive restarts and multiple processes. Authentication keeps one indistinguishable external failure result, health routes expose only coarse status, and static security headers are emitted by Next.js for every route.

**Tech Stack:** Next.js 16 App Router, Auth.js credentials provider, TypeScript, Drizzle ORM, PostgreSQL 17, Vitest.

---

## File Map

- `package.json`, `package-lock.json`: pin the patched Next.js package family.
- `src/lib/db/schema/auth.ts`: define persistent login buckets.
- `src/lib/db/schema/index.ts`: export the auth schema.
- `src/test/database.ts`: reset auth buckets in integration tests.
- `drizzle/0007_*.sql`, `drizzle/meta/*`: generated migration and metadata.
- `src/features/auth/login-rate-limit.ts`: pure HMAC, IP parsing, policy, and state transitions.
- `src/features/auth/login-rate-limit-repository.ts`: serialized PostgreSQL reads, writes, clears, and cleanup.
- `src/features/auth/login-rate-limit.test.ts`: pure behavior tests.
- `src/features/auth/login-rate-limit-repository.integration.test.ts`: persistence and concurrency tests.
- `src/features/auth/credentials.ts`: enforce limits around the existing fixed-cost password verification.
- `src/features/auth/credentials.integration.test.ts`: external authorization behavior.
- `scripts/cleanup-auth-rate-limits.ts`: idempotent expired-bucket cleanup command.
- `src/lib/env/server.ts`, `src/lib/env/server.test.ts`: add `AUTH_TRUST_PROXY`.
- `src/lib/db/health.ts`: isolated database readiness query.
- `src/app/api/health/live/route.ts`, `route.test.ts`: liveness route.
- `src/app/api/health/ready/route.ts`, `route.test.ts`: readiness route.
- `src/lib/http/security-headers.ts`, `security-headers.test.ts`: shared header values.
- `next.config.ts`, `next.config.test.ts`: apply headers to all routes.

## Task 1: Patch the Next.js package family

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Record the current advisory failure**

Run:

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org
```

Expected: non-zero exit with `next@16.4.0` affected by the published critical advisories.

- [ ] **Step 2: Install the patched package family as exact versions**

Run:

```bash
npm install --save-exact next@16.4.1 @next/env@16.4.1
npm install --save-dev --save-exact eslint-config-next@16.4.1
npm update ip-address --registry=https://registry.npmjs.org
```

Expected: `package.json` and `package-lock.json` resolve all three Next.js packages to `16.4.1`, and the transitive `socks` dependency resolves `ip-address` to patched `10.7.4` rather than `10.7.3`.

- [ ] **Step 3: Read the installed framework guides required by `AGENTS.md`**

Run:

```bash
sed -n '1,260p' node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md
sed -n '1,260p' node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
sed -n '1,260p' node_modules/next/dist/docs/01-app/02-guides/environment-variables.md
sed -n '1,260p' node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md
sed -n '1,260p' node_modules/next/dist/docs/01-app/02-guides/self-hosting.md
```

Expected: confirm the async `headers()` config shape, Route Handler response rules, server-only environment behavior, and standalone file layout before later tasks.

- [ ] **Step 4: Verify the vulnerable Next.js advisory is gone**

Run:

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run typecheck
npm run build
```

Expected: audit reports zero production vulnerabilities; typecheck and build exit 0. Any advisory that still remains blocks this task and must be resolved rather than hidden.

- [ ] **Step 5: Commit the dependency patch**

```bash
git add package.json package-lock.json
git commit -m "chore: patch Next.js security issues"
```

## Task 2: Add the persistent login-limit schema

**Files:**
- Create: `src/lib/db/schema/auth.ts`
- Modify: `src/lib/db/schema/index.ts`
- Modify: `src/test/database.ts`
- Create: `src/lib/db/schema/auth.integration.test.ts`
- Create: `drizzle/0007_*.sql`
- Create/Modify: `drizzle/meta/*`

- [ ] **Step 1: Write the failing schema test**

Create `src/lib/db/schema/auth.integration.test.ts` with tests that insert a valid account bucket and reject an invalid scope, malformed hash, zero failure count, and duplicate key:

```ts
import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { closeDatabase, db } from "@/lib/db/client";
import { authLoginRateLimits } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

describe("auth login rate limit schema", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("stores a canonical HMAC bucket", async () => {
    const keyHash = randomBytes(32).toString("hex");
    await db.insert(authLoginRateLimits).values({
      keyHash,
      scope: "account",
      failureCount: 1,
      windowStartedAt: new Date("2026-10-23T00:00:00Z"),
      updatedAt: new Date("2026-10-23T00:00:00Z"),
    });
    await expect(db.select().from(authLoginRateLimits)).resolves.toHaveLength(1);
  });

  it.each([
    ["bad scope", sql`insert into auth_login_rate_limits (key_hash, scope, failure_count, window_started_at, updated_at) values (${'a'.repeat(64)}, 'device', 1, now(), now())`],
    ["bad hash", sql`insert into auth_login_rate_limits (key_hash, scope, failure_count, window_started_at, updated_at) values ('raw-email', 'account', 1, now(), now())`],
    ["bad count", sql`insert into auth_login_rate_limits (key_hash, scope, failure_count, window_started_at, updated_at) values (${'b'.repeat(64)}, 'ip', 0, now(), now())`],
  ])("rejects %s", async (_name, statement) => {
    await expect(db.execute(statement)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the schema test and verify the missing-export failure**

Run:

```bash
npm run test:integration -- src/lib/db/schema/auth.integration.test.ts
```

Expected: FAIL because `authLoginRateLimits` does not exist.

- [ ] **Step 3: Define and export the schema**

Create `src/lib/db/schema/auth.ts`:

```ts
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const authLoginRateLimits = pgTable(
  "auth_login_rate_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    scope: text("scope").notNull(),
    failureCount: integer("failure_count").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("auth_login_rate_limits_hash_check", sql`${table.keyHash} ~ '^[a-f0-9]{64}$'`),
    check("auth_login_rate_limits_scope_check", sql`${table.scope} in ('account', 'ip')`),
    check("auth_login_rate_limits_failure_count_check", sql`${table.failureCount} > 0`),
    index("auth_login_rate_limits_updated_at_idx").on(table.updatedAt),
  ],
);
```

Export it from `src/lib/db/schema/index.ts`, and add `"auth_login_rate_limits"` before `"users"` in `resetDatabase()`.

- [ ] **Step 4: Generate and apply the migration**

Run:

```bash
npm run db:generate -- --name melon_auth_rate_limits
npm run db:migrate
```

Expected: a `0007` migration with the table, three named checks, primary key, and cleanup index.

- [ ] **Step 5: Run the focused schema tests**

Run:

```bash
npm run test:integration -- src/lib/db/schema/auth.integration.test.ts src/test/database.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the schema slice**

```bash
git add drizzle src/lib/db/schema src/test/database.ts
git commit -m "feat: persist login rate limits"
```

## Task 3: Implement deterministic rate-limit behavior

**Files:**
- Create: `src/features/auth/login-rate-limit.ts`
- Create: `src/features/auth/login-rate-limit.test.ts`
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing pure behavior tests**

Create tests for all policy boundaries:

```ts
import { describe, expect, it } from "vitest";
import {
  extractTrustedClientIp,
  hashLoginRateLimitKey,
  nextLoginRateLimitFailure,
} from "./login-rate-limit";

const now = new Date("2026-10-23T08:00:00Z");

it("hashes normalized identifiers without retaining the source value", () => {
  const hash = hashLoginRateLimitKey("account", "owner@example.test", "s".repeat(32));
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect(hash).not.toContain("owner");
});

it("trusts only valid proxy IP headers when explicitly enabled", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 127.0.0.1" });
  expect(extractTrustedClientIp(headers, false)).toBeUndefined();
  expect(extractTrustedClientIp(headers, true)).toBe("203.0.113.7");
});

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
  expect(next.blockedUntil).toEqual(new Date("2026-10-23T08:15:00Z"));
});
```

Also cover the twentieth IP failure, expired window reset, active-block preservation, expired-block reset, invalid IP input, IPv6, and scope-separated HMAC output.

- [ ] **Step 2: Run the unit test and verify it fails for a missing module**

Run:

```bash
npm test -- src/features/auth/login-rate-limit.test.ts
```

Expected: FAIL because `login-rate-limit.ts` does not exist.

- [ ] **Step 3: Implement the pure module**

Expose these exact contracts:

```ts
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

export function hashLoginRateLimitKey(
  scope: LoginRateLimitScope,
  identifier: string,
  secret: string,
): string;

export function extractTrustedClientIp(
  headers: Headers,
  trustProxy: boolean,
): string | undefined;

export function nextLoginRateLimitFailure(input: {
  scope: LoginRateLimitScope;
  current?: LoginRateLimitState;
  now: Date;
}): LoginRateLimitState;
```

Use `createHmac("sha256", secret)`, `net.isIP`, the left-most `x-forwarded-for` entry, and `x-real-ip` only as a fallback. An active block keeps its original deadline; an expired block starts a new window at one failure.

- [ ] **Step 4: Add and test `AUTH_TRUST_PROXY`**

Extend `serverEnvSchema` with the existing optional-boolean parser:

```ts
AUTH_TRUST_PROXY: optionalBoolean,
```

Add `.env.example`:

```dotenv
AUTH_TRUST_PROXY=false
```

Test that the default is false and only literal `true` enables it.

- [ ] **Step 5: Run focused unit tests**

Run:

```bash
npm test -- src/features/auth/login-rate-limit.test.ts src/lib/env/server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the pure policy slice**

```bash
git add .env.example src/features/auth/login-rate-limit.ts src/features/auth/login-rate-limit.test.ts src/lib/env/server.ts src/lib/env/server.test.ts
git commit -m "feat: define login rate limit policy"
```

## Task 4: Persist and enforce login limits

**Files:**
- Create: `src/features/auth/login-rate-limit-repository.ts`
- Create: `src/features/auth/login-rate-limit-repository.integration.test.ts`
- Modify: `src/features/auth/credentials.ts`
- Modify: `src/features/auth/credentials.integration.test.ts`
- Create: `scripts/cleanup-auth-rate-limits.ts`
- Create: `scripts/cleanup-auth-rate-limits.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing repository integration tests**

Define the repository API through tests:

```ts
const account = {
  keyHash: hashLoginRateLimitKey("account", "owner@example.test", secret),
  scope: "account" as const,
};

await recordLoginRateLimitFailures({ buckets: [account], now });
expect(await isAnyLoginRateLimitBlocked([account.keyHash], now)).toBe(false);

for (let index = 1; index < 5; index += 1) {
  await recordLoginRateLimitFailures({ buckets: [account], now });
}
expect(await isAnyLoginRateLimitBlocked([account.keyHash], now)).toBe(true);

await clearLoginRateLimits([account.keyHash]);
expect(await isAnyLoginRateLimitBlocked([account.keyHash], now)).toBe(false);
```

Also run five `recordLoginRateLimitFailures` calls concurrently and assert the stored count is exactly five, prove account/IP isolation, and prove cleanup removes only expired inactive rows.

- [ ] **Step 2: Run the repository test and verify the missing-module failure**

Run:

```bash
npm run test:integration -- src/features/auth/login-rate-limit-repository.integration.test.ts
```

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement serialized bucket updates**

Export:

```ts
export type LoginRateLimitBucket = {
  keyHash: string;
  scope: LoginRateLimitScope;
};

export async function isAnyLoginRateLimitBlocked(
  keyHashes: string[],
  now: Date,
): Promise<boolean>;

export async function recordLoginRateLimitFailures(input: {
  buckets: LoginRateLimitBucket[];
  now: Date;
}): Promise<void>;

export async function clearLoginRateLimits(keyHashes: string[]): Promise<void>;
export async function cleanupExpiredLoginRateLimits(input: {
  cutoff: Date;
  now: Date;
}): Promise<number>;
```

Within one transaction, sort buckets by `keyHash`, acquire `pg_advisory_xact_lock(hashtextextended(keyHash, 0))` for each bucket, read the row, call `nextLoginRateLimitFailure`, and upsert the returned state. Sorting prevents lock-order deadlocks.

- [ ] **Step 4: Run repository tests**

Run:

```bash
npm run test:integration -- src/features/auth/login-rate-limit-repository.integration.test.ts
```

Expected: PASS, including the concurrency assertion.

- [ ] **Step 5: Write failing credential integration tests**

Extend `credentials.integration.test.ts` to pass a Request as the second argument and prove:

```ts
const request = new Request("https://app.example.test/login", {
  headers: { "x-forwarded-for": "203.0.113.7" },
});

for (let attempt = 0; attempt < 5; attempt += 1) {
  await expect(
    authorizeCredentials(
      { email: "owner@example.test", password: "wrong password" },
      request,
    ),
  ).resolves.toBeNull();
}

await expect(
  authorizeCredentials(
    { email: "owner@example.test", password: correctPassword },
    request,
  ),
).resolves.toBeNull();
```

Add a second test that a successful login before the threshold clears both rows, and that unknown accounts create only an IP bucket.

- [ ] **Step 6: Run the credential test and verify it fails because limits are not enforced**

Run:

```bash
AUTH_TRUST_PROXY=true npm run test:integration -- src/features/auth/credentials.integration.test.ts
```

Expected: FAIL because the correct password still succeeds after five failures.

- [ ] **Step 7: Integrate limits into credentials authorization**

Change the signature to:

```ts
export async function authorizeCredentials(raw: unknown, request?: Request)
```

After normalized parsing and user lookup, derive an account bucket only when a database user exists and an IP bucket only when a trusted valid IP exists. Check active blocks, always perform the existing real-or-dummy Argon2 verification for account-level indistinguishability, record failures, clear buckets on success, and return `null` if any limiter operation fails.

- [ ] **Step 8: Add the cleanup command with a unit-tested runner**

Export a pure runner from `scripts/cleanup-auth-rate-limits.ts`:

```ts
export async function runAuthRateLimitCleanup(input: {
  now: Date;
  cleanup(cutoff: Date, now: Date): Promise<number>;
}) {
  const cutoff = new Date(input.now.getTime() - 24 * 60 * 60 * 1_000);
  return { deleted: await input.cleanup(cutoff, input.now) };
}
```

Load `.env` only in direct execution, print only the deleted count, close the database in `finally`, and set a non-zero exit code on failure. Add to `package.json`:

```json
"auth:cleanup": "node --conditions=react-server --import tsx scripts/cleanup-auth-rate-limits.ts"
```

- [ ] **Step 9: Run all focused auth tests**

Run:

```bash
npm test -- src/features/auth/login-rate-limit.test.ts scripts/cleanup-auth-rate-limits.test.ts src/lib/env/server.test.ts
npm run test:integration -- src/lib/db/schema/auth.integration.test.ts src/features/auth/login-rate-limit-repository.integration.test.ts src/features/auth/credentials.integration.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit enforcement and cleanup**

```bash
git add package.json scripts/cleanup-auth-rate-limits.ts scripts/cleanup-auth-rate-limits.test.ts src/features/auth src/lib/db/schema/auth.integration.test.ts
git commit -m "feat: throttle private account logins"
```

## Task 5: Add core health probes

**Files:**
- Create: `src/lib/db/health.ts`
- Create: `src/app/api/health/live/route.ts`
- Create: `src/app/api/health/live/route.test.ts`
- Create: `src/app/api/health/ready/route.ts`
- Create: `src/app/api/health/ready/route.test.ts`

- [ ] **Step 1: Write failing route tests**

The liveness test must assert status 200, exact body, and `no-store`. The readiness test mocks `checkDatabaseReadiness` and asserts a database error becomes a sanitized 503:

```ts
expect(await response.json()).toEqual({ status: "unavailable" });
expect(response.status).toBe(503);
expect(response.headers.get("cache-control")).toBe("no-store");
expect(await response.text()).not.toMatch(/postgres|password|stack/i);
```

- [ ] **Step 2: Run tests and verify missing routes**

Run:

```bash
npm test -- src/app/api/health/live/route.test.ts src/app/api/health/ready/route.test.ts
```

Expected: FAIL because both routes are missing.

- [ ] **Step 3: Implement the database check and routes**

`src/lib/db/health.ts` executes exactly `select 1` through the existing Drizzle client. Both routes return JSON with `Cache-Control: no-store`; readiness catches all errors without logging or returning details.

- [ ] **Step 4: Run focused health tests**

Run:

```bash
npm test -- src/app/api/health/live/route.test.ts src/app/api/health/ready/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit health probes**

```bash
git add src/app/api/health src/lib/db/health.ts
git commit -m "feat: add core health probes"
```

## Task 6: Add compatible baseline security headers

**Files:**
- Create: `src/lib/http/security-headers.ts`
- Create: `src/lib/http/security-headers.test.ts`
- Modify: `next.config.ts`
- Create: `next.config.test.ts`

- [ ] **Step 1: Write the failing header contract test**

Require these keys and CSP directives:

```ts
expect(Object.fromEntries(SECURITY_HEADERS.map(({ key, value }) => [key, value]))).toMatchObject({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
});
expect(csp).toContain("object-src 'none'");
expect(csp).toContain("frame-ancestors 'none'");
expect(csp).toContain("img-src 'self' blob: data: https:");
expect(csp).toContain("connect-src 'self' https:");
```

The config test must call `nextConfig.headers()` and assert one `/:path*` rule contains the shared array.

- [ ] **Step 2: Run tests and verify the missing export/config failure**

Run:

```bash
npm test -- src/lib/http/security-headers.test.ts next.config.test.ts
```

Expected: FAIL because the shared headers and `headers()` config do not exist.

- [ ] **Step 3: Implement headers and wire Next.js config**

Export an immutable header array. Use a CSP with these directives:

```text
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
object-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data: https:;
font-src 'self' data:;
connect-src 'self' https:;
worker-src 'self' blob:
```

Add `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()` and return the rule from `next.config.ts` without changing standalone output.

- [ ] **Step 4: Run header and build verification**

Run:

```bash
npm test -- src/lib/http/security-headers.test.ts next.config.test.ts
npm run typecheck
npm run build
```

Expected: PASS. The production build must retain all existing routes plus `/api/health/live` and `/api/health/ready`.

- [ ] **Step 5: Commit security headers**

```bash
git add next.config.ts next.config.test.ts src/lib/http/security-headers.ts src/lib/http/security-headers.test.ts
git commit -m "feat: add baseline response security"
```

## Task 7: Verify the security phase

- [ ] **Step 1: Run fresh security verification**

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org
npm test -- src/features/auth src/lib/env/server.test.ts src/lib/http/security-headers.test.ts next.config.test.ts src/app/api/health scripts/cleanup-auth-rate-limits.test.ts
npm run test:integration -- src/lib/db/schema/auth.integration.test.ts src/features/auth/login-rate-limit-repository.integration.test.ts src/features/auth/credentials.integration.test.ts
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0, the patched Next.js advisories are absent, and no test logs raw email/IP identifiers from rate-limit rows.

- [ ] **Step 2: Record the phase state**

```bash
git status --short --branch
git log --oneline -7
```

Expected: only intentionally deferred compliance/operations plan files may remain uncommitted.
