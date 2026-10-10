# melon Foundation and Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a secure, Mac-first online pattern library with private accounts, light/dark themes, PostgreSQL metadata, tags and filters, resumable direct OSS uploads, JPG/PNG previews, and authorized source downloads.

**Architecture:** Use one Next.js App Router deployment with domain services behind Route Handlers. PostgreSQL is authoritative, while the browser sends file bytes directly to private Alibaba Cloud OSS using short-lived, prefix-scoped STS credentials and keeps upload checkpoints in Dexie. Cloud access is behind interfaces so the required test suite runs without real credentials.

**Tech Stack:** Node.js 24 LTS, npm, Next.js App Router, TypeScript, React, Tailwind CSS, Radix UI, Lucide, Auth.js Credentials, Argon2id, PostgreSQL, Drizzle ORM, Zod, TanStack Query/Virtual, Zustand, Dexie, `ali-oss`, Vitest, Testing Library, and Playwright.

---

## Scope and File Map

This phase ends with a usable online library. PSD/AI/Procreate preview parsing, commercial authorizations, full offline metadata sync, automated trash expiry, and production deployment belong to later plans.

```text
melon/
├── .env.example
├── .node-version
├── .nvmrc
├── compose.yaml
├── drizzle.config.ts
├── package.json
├── playwright.config.ts
├── src/proxy.ts
├── vitest.config.ts
├── vitest.integration.config.ts
├── drizzle/                            # Reviewed SQL migrations
├── scripts/create-user.ts
├── scripts/reset-password.ts
├── docs/operations/aliyun-oss.md
├── src/app/                            # Pages and thin Route Handlers
├── src/components/ui/                  # Focused Radix-backed primitives
├── src/features/auth/                  # Password policy and session checks
├── src/features/library/               # Grid, toolbar and inspector
├── src/features/patterns/              # Tenant-safe pattern service
├── src/features/preview/               # JPG/PNG browser worker only
├── src/features/storage/               # Object keys, STS policy, adapters
├── src/features/tags/                  # Tag rules and picker
├── src/features/theme/                 # Theme provider and preference
├── src/features/uploads/               # Server lifecycle and browser queue
├── src/lib/db/                         # Connection and schema
├── src/lib/env/                        # Server-only environment parsing
├── src/lib/http/                       # Stable errors and responses
├── src/lib/query/                      # Query provider and keys
├── src/test/                           # Factories, fakes, database reset
└── tests/e2e/                          # Browser journeys
```

## Task 1: Bootstrap the Runtime, Test Harness, and Design Tokens

**Files:**
- Create: `.node-version`, `.nvmrc`, `.gitignore`
- Create: `package.json`, `package-lock.json`, `tsconfig.json`
- Create: `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`
- Create: `vitest.config.ts`, `src/test/setup.ts`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Create: `src/features/theme/theme-provider.tsx`
- Test: `src/app/page.test.tsx`, `src/features/theme/theme-provider.test.tsx`

- [ ] **Step 1: Pin Node 24 and write the first failing route test**

Put `24` followed by a newline in both runtime files. Create this test:

```tsx
import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect }));

describe("root page", () => {
  it("redirects into the private library", async () => {
    const { default: Page } = await import("./page");
    Page();
    expect(redirect).toHaveBeenCalledWith("/library");
  });
});
```

Run:

```bash
node --version
npm test -- src/app/page.test.tsx
```

Expected: Node begins with `v24.`; the test command fails because the manifest and page do not exist. Stop and switch Node before continuing if the runtime is not 24.x.

- [ ] **Step 2: Install the locked application and test toolchain**

Create this manifest before installation:

```json
{
  "name": "melon",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:e2e": "playwright test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "user:create": "tsx scripts/create-user.ts",
    "user:reset-password": "tsx scripts/reset-password.ts"
  }
}
```

Run once and commit the resulting lockfile:

```bash
npm install next@latest react@latest react-dom@latest next-auth@latest server-only zod drizzle-orm postgres argon2 ali-oss dexie hash-wasm @alicloud/credentials @alicloud/sts20150401 @alicloud/openapi-client @tanstack/react-query @tanstack/react-virtual zustand next-themes lucide-react clsx tailwind-merge class-variance-authority @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-tooltip @radix-ui/react-checkbox @radix-ui/react-tabs @radix-ui/react-select
npm install --save-dev typescript @types/node @types/react @types/react-dom @types/ali-oss tailwindcss @tailwindcss/postcss eslint eslint-config-next vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test drizzle-kit tsx dotenv fake-indexeddb
npm ls --depth=0
```

Expected: installation and `npm ls` exit 0, with `package-lock.json` present.

- [ ] **Step 3: Add exact framework and test configuration**

Configure Vitest as follows:

```ts
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["tests/e2e/**", "**/*.integration.test.ts"],
    clearMocks: true,
  },
});
```

`src/test/setup.ts` contains `import "@testing-library/jest-dom/vitest";`. Configure `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, the Next.js plugin, and alias `@/*` to `./src/*`. Configure Next.js with `output: "standalone"` and `poweredByHeader: false`. Extend the current Next.js flat ESLint presets for core web vitals and TypeScript.

Implement the redirect and root layout:

```tsx
// src/app/page.tsx
import { redirect } from "next/navigation";
export default function Page() { redirect("/library"); }
```

```tsx
// src/app/layout.tsx
import type { Metadata } from "next";
import { ThemeProvider } from "@/features/theme/theme-provider";
import "./globals.css";

export const metadata: Metadata = { title: "melon", description: "Private pattern library" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><body><ThemeProvider>{children}</ThemeProvider></body></html>;
}
```

- [ ] **Step 4: Implement theme behavior and semantic tokens**

```tsx
"use client";
import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <NextThemesProvider attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange>{children}</NextThemesProvider>;
}
```

Define these exact core tokens in `globals.css`; components use variables rather than raw theme colors:

```css
@import "tailwindcss";
:root { color-scheme: light; --canvas:#f6f7f9; --surface:#fff; --surface-raised:#fff; --text:#202227; --text-muted:#6f7480; --border:#e1e4e9; --primary:#3b5da8; --primary-hover:#304f95; --status-standard:#2f6f4e; --status-exclusive:#80651e; --status-buyout:#a34747; }
[data-theme="dark"] { color-scheme: dark; --canvas:#090b0f; --surface:#0f1217; --surface-raised:#151922; --text:#eceef4; --text-muted:#9aa0ad; --border:#292e38; --primary:#7893dc; --primary-hover:#8ca4e5; --status-standard:#6fb58b; --status-exclusive:#d2b45b; --status-buyout:#de7b7b; }
* { box-sizing:border-box; letter-spacing:0; }
html,body { min-height:100%; margin:0; }
body { background:var(--canvas); color:var(--text); font-family:Inter,"PingFang SC",system-ui,sans-serif; }
button,input,select,textarea { font:inherit; }
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition-duration:.01ms!important; } }
```

Mock `next-themes` and assert the provider receives `attribute="data-theme"`, `defaultTheme="system"`, and `enableSystem=true`.

- [ ] **Step 5: Verify and commit the bootstrap**

```bash
npm test -- src/app/page.test.tsx src/features/theme/theme-provider.test.tsx
npm run typecheck
npm run lint
git add .node-version .nvmrc .gitignore package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs vitest.config.ts src/app src/features/theme src/test/setup.ts
git commit -m "chore: bootstrap melon web app"
```

Expected: two tests pass and all validation commands exit 0.

## Task 2: Add Environment Validation and PostgreSQL Infrastructure

**Files:**
- Create: `.env.example`, `compose.yaml`, `drizzle.config.ts`, `vitest.integration.config.ts`
- Create: `src/lib/env/server.ts`, `src/lib/db/client.ts`
- Create: `src/lib/db/schema/users.ts`, `src/lib/db/schema/index.ts`
- Create: `src/test/database.ts`
- Test: `src/lib/env/server.test.ts`, `src/lib/db/schema/users.integration.test.ts`
- Generate: `drizzle/0000_*.sql`

- [ ] **Step 1: Write failing environment and user-schema tests**

Use this fixture and assertions in `server.test.ts`:

```ts
const validEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://melon:melon@localhost:55432/melon_test",
  AUTH_SECRET: "a".repeat(32),
  APP_ORIGIN: "http://localhost:3000",
  ALIYUN_OSS_REGION: "oss-cn-hangzhou",
  ALIYUN_OSS_BUCKET: "melon-test-assets",
  ALIYUN_OSS_ENDPOINT: "https://assets.example.test",
  ALIYUN_OSS_CNAME: "true",
  ALIYUN_STS_ROLE_ARN: "acs:ram::123456789012:role/melon-browser-upload",
};

expect(parseServerEnv(validEnv).ALIYUN_OSS_CNAME).toBe(true);
expect(() => parseServerEnv({ ...validEnv, AUTH_SECRET: "short" })).toThrow();
expect(() => parseServerEnv({ ...validEnv, ALIBABA_CLOUD_ACCESS_KEY_ID: "id-only" })).toThrow(/provided together/);
```

The integration test inserts one user and asserts defaults `role=user`, `status=active`, `themePreference=system`, `syncSeq=0n`, then proves normalized email uniqueness.

Run both focused commands. Expected: FAIL because the parser, database and schema are absent.

- [ ] **Step 2: Implement the server-only environment contract**

```ts
import "server-only";
import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url(),
  ALIYUN_OSS_REGION: z.string().min(1),
  ALIYUN_OSS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  ALIYUN_OSS_ENDPOINT: z.string().url(),
  ALIYUN_OSS_CNAME: z.enum(["true", "false"]).transform((value) => value === "true"),
  ALIYUN_STS_ROLE_ARN: z.string().startsWith("acs:ram::"),
  OSS_ADAPTER: z.enum(["real", "fake"]).default("real"),
  ALIBABA_CLOUD_ACCESS_KEY_ID: z.string().min(1).optional(),
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (Boolean(value.ALIBABA_CLOUD_ACCESS_KEY_ID) !== Boolean(value.ALIBABA_CLOUD_ACCESS_KEY_SECRET)) {
    context.addIssue({ code: "custom", path: ["ALIBABA_CLOUD_ACCESS_KEY_ID"], message: "AccessKey ID and secret must be provided together" });
  }
  if (value.OSS_ADAPTER === "fake" && value.NODE_ENV !== "test") {
    context.addIssue({ code: "custom", path: ["OSS_ADAPTER"], message: "Fake OSS adapter is test-only" });
  }
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export const parseServerEnv = (input: NodeJS.ProcessEnv | Record<string, string | undefined>) => serverEnvSchema.parse(input);
let cached: ServerEnv | undefined;
export const getServerEnv = () => (cached ??= parseServerEnv(process.env));
```

`.env.example` lists only inert examples and leaves both local development AccessKey values blank. `.gitignore` excludes `.env*` and explicitly allows `.env.example`.

- [ ] **Step 3: Start isolated PostgreSQL and implement the user schema**

Use PostgreSQL 17 on host port 55432:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment: { POSTGRES_USER: melon, POSTGRES_PASSWORD: melon, POSTGRES_DB: melon_test }
    ports: ["55432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U melon -d melon_test"]
      interval: 2s
      timeout: 2s
      retries: 20
    volumes: ["melon-postgres:/var/lib/postgresql/data"]
volumes: { melon-postgres: {} }
```

Define user enums and columns exactly:

```ts
export const userRole = pgEnum("user_role", ["admin", "user"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const themePreference = pgEnum("theme_preference", ["system", "light", "dark"]);
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("user"),
  status: userStatus("status").notNull().default("active"),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  themePreference: themePreference("theme_preference").notNull().default("system"),
  syncSeq: bigint("sync_seq", { mode: "bigint" }).notNull().default(0n),
  sessionVersion: integer("session_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Configure Drizzle for `./src/lib/db/schema/index.ts`, output to `./drizzle`, generate and inspect a migration, then apply it. The integration reset helper refuses to truncate unless the database name ends in `_test`.

- [ ] **Step 4: Run the red tests green and commit**

```bash
docker compose up -d postgres
docker compose ps
npm run db:generate
npm run db:migrate
npm test -- src/lib/env/server.test.ts
npm run test:integration -- src/lib/db/schema/users.integration.test.ts
npm run typecheck
git check-ignore .env.local
git add .env.example .gitignore compose.yaml drizzle.config.ts vitest.integration.config.ts drizzle src/lib/env src/lib/db src/test/database.ts
git commit -m "feat: add validated environment and user database"
```

Expected: PostgreSQL is healthy, both test files pass, `.env.local` is ignored, and no credential value appears in the staged diff.

## Task 3: Implement Private Credentials Authentication and Theme Preference

**Files:**
- Create: `src/auth.ts`, `src/auth.d.ts`, `src/proxy.ts`
- Create: `src/features/auth/password.ts`, `src/features/auth/session.ts`, `src/features/auth/user-admin.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Create: `src/app/(auth)/login/page.tsx`, `src/app/(auth)/login/actions.ts`
- Create: `src/app/(auth)/change-password/page.tsx`, `src/app/(auth)/change-password/actions.ts`
- Create: `src/app/api/settings/theme/route.ts`, `src/features/theme/theme-control.tsx`
- Create: `src/app/(workspace)/settings/page.tsx`
- Create: `scripts/create-user.ts`, `scripts/reset-password.ts`
- Test: `src/features/auth/password.test.ts`, `src/features/auth/session.integration.test.ts`, `src/features/theme/theme-control.test.tsx`

- [ ] **Step 1: Write failing password, session, and theme tests**

```ts
expect(passwordSchema.safeParse("short").success).toBe(false);
expect(passwordSchema.safeParse("correct horse battery staple").success).toBe(true);
expect(await verifyPassword("correct horse battery staple", await hashPassword("correct horse battery staple"))).toBe(true);
```

The integration test creates an active user, calls `loadSessionUser({ id, sessionVersion: 0 })`, increments `sessionVersion`, and expects the same token to be rejected. A disabled user is always rejected. The theme component test selects “夜间”, expects `setTheme("dark")`, and expects one PATCH with `{ themePreference: "dark" }`.

Install `@inquirer/prompts` for hidden CLI password input, then run the three focused tests. Expected: FAIL because the modules are absent.

```bash
npm install @inquirer/prompts
```

- [ ] **Step 2: Implement password and authenticated-user boundaries**

```ts
import argon2 from "argon2";
import { z } from "zod";

export const passwordSchema = z.string().min(12).max(128);
export const argonOptions = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
export const hashPassword = (password: string) => argon2.hash(passwordSchema.parse(password), argonOptions);
export const verifyPassword = (password: string, hash: string) => argon2.verify(hash, password);
```

`loadSessionUser` queries by token user ID, requires `active` status and equal `sessionVersion`, and returns only the authenticated profile fields. `requireUser` calls `auth()` and `loadSessionUser`; it never trusts an owner ID from request data.

- [ ] **Step 3: Configure Auth.js and guarded routes**

Configure a Credentials provider whose `authorize` method validates with Zod, normalizes email, returns the same failure for unknown users and bad passwords, and embeds `sessionVersion` in a JWT session. Export `{ handlers, auth, signIn, signOut }` and re-export GET/POST from the Auth.js route.

```ts
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [Credentials({
    credentials: { email: { type: "email" }, password: { type: "password" } },
    async authorize(raw) {
      const input = signInSchema.parse(raw);
      const user = await findUserByNormalizedEmail(input.email);
      if (!user || user.status !== "active" || !(await verifyPassword(input.password, user.passwordHash))) return null;
      return { id: user.id, email: user.email, name: user.displayName, sessionVersion: user.sessionVersion };
    },
  })],
});
```

`src/proxy.ts` performs only an optimistic cookie redirect for `/library`, `/dashboard`, `/trash`, and `/settings`; every page, action, and Route Handler still calls `requireUser`. The workspace layout redirects `mustChangePassword=true` users to `/change-password`.

- [ ] **Step 4: Implement account commands, password change, and theme persistence**

Both CLI commands require an explicit email flag and read the password from a hidden prompt, never a positional argument. Creating or resetting sets `mustChangePassword=true`; reset also increments `sessionVersion`. Password change verifies the current password, stores the new hash, clears the flag, and increments `sessionVersion` in one transaction.

The theme endpoint accepts only this payload:

```ts
const themeInput = z.object({ themePreference: z.enum(["system", "light", "dark"]) });
```

The client applies the theme immediately, rolls back on a failed PATCH, and uses the server value as the post-login source of truth.

- [ ] **Step 5: Verify security behavior and commit**

```bash
npm test -- src/features/auth/password.test.ts src/features/theme/theme-control.test.tsx
npm run test:integration -- src/features/auth/session.integration.test.ts
npm run typecheck
npm run lint
git grep -nE '/register|api/register' -- src || true
git add src/auth.ts src/auth.d.ts src/proxy.ts src/features/auth src/features/theme src/app/api/auth src/app/api/settings src/app/'(auth)' src/app/'(workspace)'/settings scripts package.json package-lock.json
git commit -m "feat: add private authentication and theme settings"
```

Expected: tests pass, no registration route exists, and password reset/change invalidates earlier sessions.

## Task 4: Create the Core Pattern, Asset, Tag, Upload, and Change Schemas

**Files:**
- Create: `src/lib/db/schema/patterns.ts`, `assets.ts`, `tags.ts`
- Create: `src/lib/db/schema/upload-sessions.ts`, `change-log.ts`, `operations.ts`
- Modify: `src/lib/db/schema/index.ts`, `src/test/database.ts`
- Test: `src/lib/db/schema/library.integration.test.ts`
- Generate: next migration under `drizzle/`

- [ ] **Step 1: Write failing database-constraint tests**

Create two users and prove all of these invariants:

```ts
await expect(insertSecondCurrentSource(patternId)).rejects.toThrow();
await expect(insertDuplicateOperation(ownerId, operationId)).rejects.toThrow();
await expect(insertPatternTag(patternId, foreignOwnerTagId, ownerId)).rejects.toThrow();
expect((await loadPattern(patternId)).commercialVersion).toBe(0);
```

Also assert that one user may reuse another user's normalized tag name, while the same user cannot own two active tags with that name. Run the focused integration test and expect missing-table failure.

- [ ] **Step 2: Define enums and authoritative tables**

Use these exact domain unions in schema enums:

```ts
export const patternStatuses = ["draft", "hashing", "uploading", "processing", "ready", "failed", "trashed", "deleted"] as const;
export const previewStatuses = ["pending", "ready", "unsupported", "failed", "manual"] as const;
export const assetRoles = ["source", "preview", "thumbnail"] as const;
export const uploadStatuses = ["initialized", "uploading", "completing", "completed", "aborted", "expired", "failed"] as const;
export const patternStatusEnum = pgEnum("pattern_status", patternStatuses);
export const previewStatusEnum = pgEnum("preview_status", previewStatuses);
export const assetRoleEnum = pgEnum("asset_role", assetRoles);
export const uploadStatusEnum = pgEnum("upload_status", uploadStatuses);
```

Define Pattern columns explicitly:

```ts
export const patterns = pgTable("patterns", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  originalFilename: text("original_filename").notNull(),
  extension: text("extension").notNull(),
  detectedMimeType: text("detected_mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
  contentHash: text("content_hash"),
  status: patternStatusEnum("status").notNull().default("draft"),
  previewStatus: previewStatusEnum("preview_status").notNull().default("pending"),
  isFavorite: boolean("is_favorite").notNull().default(false),
  version: integer("version").notNull().default(0),
  commercialVersion: integer("commercial_version").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  changeSeq: bigint("change_seq", { mode: "bigint" }).notNull().default(0n),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Add a unique `(ownerId, id)` key for composite ownership foreign keys plus `(ownerId, status, updatedAt, id)`, `(ownerId, name, id)`, and `(ownerId, originalFilename, id)` query indexes. `commercialVersion` remains 0 until phase 02.

`assets` has `id`, `ownerId`, `patternId`, `role`, `objectKey`, `originalFilename`, `detectedMimeType`, `sizeBytes`, nullable `width`/`height`, `contentHash`, and timestamps. It references Pattern by composite `(ownerId, patternId)`, stores only object keys, and makes `(ownerId, patternId, role)` unique; the upload service creates exactly one source placeholder and permanent deletion removes all asset rows. `tags` has a unique `(ownerId, id)` key and a partial unique index on `(ownerId, normalizedName)` where `deletedAt is null`. `patternTags` has composite primary key `(ownerId, patternId, tagId)`, composite ownership foreign keys to Pattern and Tag, and stores `isActive`, `version`, and `changeSeq`.

- [ ] **Step 3: Define idempotency and synchronization support**

`uploadSessions` stores session ID, owner, pattern, stable user-scoped operation ID, source key, optional OSS upload ID, fingerprint JSON, declared size, state, expiry, error code and timestamps. `operations` claims `(ownerId, operationId)` uniquely and stores operation kind plus JSON result for replay.

`changeLog` uses `(ownerId, seq)` as its primary key and stores `operationId`, entity type/ID, operation, JSON payload and server time. Implement this transaction helper:

```ts
export async function nextChangeSeq(tx: DbTransaction, ownerId: string): Promise<bigint> {
  const [row] = await tx.update(users)
    .set({ syncSeq: sql`${users.syncSeq} + 1` })
    .where(eq(users.id, ownerId))
    .returning({ syncSeq: users.syncSeq });
  if (!row) throw new Error("OWNER_NOT_FOUND");
  return row.syncSeq;
}
```

Every later business mutation must obtain its sequence and insert its change record in the same transaction.

- [ ] **Step 4: Generate, inspect, and test the migration**

```bash
npm run db:generate
git diff -- drizzle src/lib/db/schema
npm run db:migrate
npm run test:integration -- src/lib/db/schema/library.integration.test.ts
npm run typecheck
```

Expected: constraints reject all invalid fixtures and valid cross-user duplicate tag names succeed.

- [ ] **Step 5: Commit the core model**

```bash
git add drizzle src/lib/db/schema src/lib/db/change-seq.ts src/test/database.ts
git commit -m "feat: add core library data model"
```

## Task 5: Implement Tenant-Safe Pattern and Tag Services

**Files:**
- Create: `src/lib/http/app-error.ts`, `src/lib/http/route.ts`
- Create: `src/features/patterns/contracts.ts`, `pattern-service.ts`, `pattern-repository.ts`
- Create: `src/features/tags/contracts.ts`, `tag-service.ts`, `tag-repository.ts`
- Create: `src/app/api/patterns/route.ts`, `src/app/api/patterns/[patternId]/route.ts`
- Create: `src/app/api/tags/route.ts`, `src/app/api/tags/[tagId]/route.ts`
- Test: `src/features/patterns/pattern-service.integration.test.ts`, `src/features/tags/tag-service.integration.test.ts`
- Test: `src/app/api/patterns/route.test.ts`

- [ ] **Step 1: Write failing tenant, cursor, and tag-rule tests**

Seed two owners and assert:

```ts
expect((await listPatterns({ ownerId: ownerA, input: {} })).items).toHaveLength(2);
await expect(updatePattern({ ownerId: ownerA, patternId: ownerBPattern, patch: { name: "stolen" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
await expect(createTag({ ownerId: ownerA, name: "  Summer  ", colorToken: "green" })).resolves.toMatchObject({ name: "Summer", normalizedName: "summer" });
await expect(addTagToPattern({ ownerId: ownerA, patternId, tagId: twentyFirstTag })).rejects.toMatchObject({ code: "TAG_LIMIT_EXCEEDED" });
```

Create 31 equal-timestamp patterns, page with a 20-item cursor, and assert no duplicates or omissions. The Route Handler test passes an attacker-owned `ownerId` in query/body and proves it is ignored. Run and expect failures because services are missing.

- [ ] **Step 2: Define validated query and mutation contracts**

```ts
export const patternQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  formats: z.array(z.enum(["psd", "ai", "jpg", "jpeg", "png", "procreate"])).max(6).default([]),
  tagIds: z.array(z.string().uuid()).max(20).default([]),
  tagMode: z.enum(["all", "any"]).default("all"),
  favorite: z.coerce.boolean().optional(),
  previewStatus: z.enum(["pending", "ready", "unsupported", "failed", "manual"]).optional(),
  sort: z.enum(["updated_desc", "created_desc", "name_asc", "size_desc"]).default("updated_desc"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const patternPatchSchema = z.object({
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(160).optional(),
  isFavorite: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.isFavorite !== undefined);
```

Encode cursors as base64url JSON containing the active sort value and UUID tie-breaker. Reject a cursor whose sort does not match the current query.

- [ ] **Step 3: Implement repository predicates with mandatory owner scope**

Every repository method receives `ownerId` as its first input and includes it in the SQL predicate. Search escapes `%`, `_`, and `\` before an `ILIKE` contains query. Tag `all` mode uses a grouped subquery with `having count(distinct tag_id) = requestedTagCount`; `any` mode uses `exists`.

Use optimistic concurrency for pattern patch:

```ts
const [updated] = await tx.update(patterns)
  .set({ ...patch, version: sql`${patterns.version} + 1`, updatedAt: new Date() })
  .where(and(eq(patterns.ownerId, ownerId), eq(patterns.id, patternId), eq(patterns.version, version), ne(patterns.status, "deleted")))
  .returning();
if (!updated) throw new AppError("PATTERN_STATE_CHANGED", 409);
```

Create/rename tags with normalized lowercase names, restrict colors to the fixed token palette, and count active pattern-tag relations inside the add transaction before accepting the 20th boundary.

- [ ] **Step 4: Add thin Route Handlers and stable errors**

`withRoute` converts `AppError` into `{ error: { code, message } }`, adds a request ID, and maps unrecognized failures to `INTERNAL_ERROR` without leaking SQL or stack traces. Each handler follows this order: `requireUser` → Zod parse → domain service → JSON response. Cross-owner and unknown IDs both return 404.

```ts
export const GET = withRoute(async (request: Request) => {
  const user = await requireUser();
  const input = patternQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  return Response.json(await listPatterns({ ownerId: user.id, input }));
});
```

- [ ] **Step 5: Verify and commit the domain layer**

```bash
npm run test:integration -- src/features/patterns/pattern-service.integration.test.ts src/features/tags/tag-service.integration.test.ts
npm test -- src/app/api/patterns/route.test.ts
npm run typecheck
npm run lint
git add src/lib/http src/features/patterns src/features/tags src/app/api/patterns src/app/api/tags
git commit -m "feat: add tenant-safe library services"
```

Expected: pagination is stable, 20 tags are accepted and the 21st is rejected, and all cross-owner probes return the same 404 shape.

## Task 6: Build the Mac-First Workspace and Online Library

**Files:**
- Create: `src/lib/query/provider.tsx`, `src/lib/query/keys.ts`
- Create: `src/features/library/workspace-shell.tsx`, `sidebar.tsx`, `topbar.tsx`
- Create: `src/features/library/library-view.tsx`, `library-toolbar.tsx`, `pattern-grid.tsx`
- Create: `src/features/library/pattern-card.tsx`, `inspector.tsx`, `selection-store.ts`
- Create: `src/features/library/pattern-mutations.ts`, `query-state.ts`
- Create: `src/features/tags/tag-picker.tsx`
- Create: `src/app/(workspace)/layout.tsx`, `src/app/(workspace)/library/page.tsx`
- Test: `src/features/library/query-state.test.ts`, `selection-store.test.ts`, `library-view.test.tsx`
- Test: `src/features/tags/tag-picker.test.tsx`

- [ ] **Step 1: Write failing interaction and query-state tests**

Test URL round-tripping with a concrete case:

```ts
const state = parseLibrarySearchParams(new URLSearchParams("q=leaf&format=psd&tag=t1&tag=t2&tagMode=all&sort=name_asc"));
expect(state).toMatchObject({ q: "leaf", formats: ["psd"], tagIds: ["t1", "t2"], tagMode: "all", sort: "name_asc" });
expect(serializeLibrarySearchParams(state).toString()).toBe("q=leaf&format=psd&tag=t1&tag=t2&tagMode=all&sort=name_asc");
```

Selection tests cover single click, Command-toggle, Shift-range and Escape clear. Component tests assert a virtualized result region, a 220 px sidebar, a collapsible 340 px inspector, keyboard preview on Space, and no page-level horizontal overflow at 1024 px.

- [ ] **Step 2: Add query provider and canonical query keys**

```ts
export const queryKeys = {
  patterns: (query: PatternQuery) => ["patterns", query] as const,
  pattern: (id: string) => ["pattern", id] as const,
  tags: ["tags"] as const,
};
```

Construct one `QueryClient` per browser session with two retries for transient GET failures and zero retries for 4xx mutations. The server page parses search params with the same Zod schema used by the API and prefetches the first page.

- [ ] **Step 3: Implement the stable workspace geometry**

Use CSS grid columns `220px minmax(0,1fr) auto`, a 48 px top bar, and a fixed 340 px inspector when open. At iPad width, collapse the sidebar to an icon rail before reducing the content below 640 px. Cards use at most 6 px radius, stable thumbnail aspect ratio, neutral checkerboard for alpha, and icon buttons with tooltips for grid/list, favorite, preview and download.

```css
.workspace { display:grid; grid-template-columns:220px minmax(0,1fr) auto; grid-template-rows:48px minmax(0,1fr); min-height:100dvh; }
.inspector { width:340px; min-width:340px; border-left:1px solid var(--border); }
.pattern-media { aspect-ratio:1 / 1; min-width:0; overflow:hidden; border-radius:6px; }
@media (max-width:1100px) { .workspace { grid-template-columns:56px minmax(0,1fr) auto; } }
```

The virtual grid computes rows from the current column count and renders only visible rows through TanStack Virtual. Card selection state stays in Zustand and does not trigger refetches.

- [ ] **Step 4: Implement editor mutations and tag picker**

Name changes debounce 400 ms and flush on blur. Favorite and tag mutations update exact TanStack Query caches optimistically, restore snapshots on failure, then invalidate the detail and active list key. The tag picker uses checkboxes, searchable names, fixed color swatches and an explicit “创建标签” action; it does not use colored text pills in place of swatches.

Use this rollback shape for every mutation:

```ts
onMutate: async ({ patternId, patch }) => {
  await queryClient.cancelQueries({ queryKey: queryKeys.pattern(patternId) });
  const previous = queryClient.getQueryData(queryKeys.pattern(patternId));
  queryClient.setQueryData(queryKeys.pattern(patternId), (value: PatternDetail | undefined) => value ? { ...value, ...patch } : value);
  return { previous, patternId };
},
onError: (_error, _variables, context) => {
  if (context) queryClient.setQueryData(queryKeys.pattern(context.patternId), context.previous);
},
```

- [ ] **Step 5: Run focused UI tests and commit**

```bash
npm test -- src/features/library src/features/tags/tag-picker.test.tsx
npm run typecheck
npm run lint
git add src/lib/query src/features/library src/features/tags/tag-picker.tsx src/app/'(workspace)'
git commit -m "feat: add mac-first library workspace"
```

Expected: keyboard, selection, URL state and optimistic rollback tests pass; no component uses a marketing hero, nested cards, gradients or decorative orbs.

## Task 7: Define the Least-Privilege OSS Boundary

**Files:**
- Create: `src/features/storage/object-keys.ts`, `sts-policy.ts`, `contracts.ts`
- Create: `src/features/storage/cloud-credentials.ts`, `oss-adapter.ts`
- Create: `src/test/fake-oss.ts`
- Create: `docs/operations/aliyun-oss.md`
- Test: `src/features/storage/object-keys.test.ts`, `sts-policy.test.ts`

- [ ] **Step 1: Write failing object-key and policy tests**

```ts
expect(sourceObjectKey({ ownerId, patternId, assetId, extension: "PSD" }))
  .toBe(`users/${ownerId}/patterns/${patternId}/source/${assetId}.psd`);

const policy = JSON.parse(createUploadPolicy({ bucket: "melon-test-assets", ownerId, patternId }));
expect(policy.Statement[0].Action).toEqual(["oss:AbortMultipartUpload", "oss:ListParts", "oss:PutObject"]);
expect(policy.Statement[0].Resource).toBe(`acs:oss:*:*:melon-test-assets/users/${ownerId}/patterns/${patternId}/*`);
expect(JSON.stringify(policy)).not.toContain("oss:*");
expect(JSON.stringify(policy)).not.toContain("users/*");
```

Also test invalid UUIDs, path separators in extensions, and cross-pattern keys. Run focused tests and expect missing exports.

- [ ] **Step 2: Implement UUID-only keys and the exact session policy**

Validate every ID with `z.string().uuid()` and use role-aware extension enums: source keys accept `psd|ai|jpg|jpeg|png|procreate`, while derived keys accept `jpg|jpeg|png|webp`. WebP is derived-only. Never include email, display name, pattern name or original filename. Generate a version `1` policy with one object-prefix resource and these actions only:

```ts
const uploadActions = ["oss:AbortMultipartUpload", "oss:ListParts", "oss:PutObject"] as const;
```

`oss:PutObject` covers initiate, upload-part and complete. Do not invent `oss:InitiateMultipartUpload`, `oss:UploadPart` or `oss:CompleteMultipartUpload`. Do not grant object reads or bucket listing to browser credentials.

- [ ] **Step 3: Define adapters and credential issuer**

```ts
export interface OssAdapter {
  headObject(key: string): Promise<{ sizeBytes: number; contentType: string }>;
  readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array>;
  deleteObjects(keys: string[]): Promise<void>;
  createSignedGet(input: { key: string; filename: string; expiresSeconds: number }): Promise<string>;
}

export interface BrowserCredentialIssuer {
  issue(input: { ownerId: string; patternId: string }): Promise<BrowserOssCredentials>;
}
```

Production uses the Alibaba default credential provider chain to call STS AssumeRole. Tests inject `FakeOssAdapter` and `FakeCredentialIssuer`; no default test reads cloud environment credentials.

- [ ] **Step 4: Write the OSS operations guide**

Document private Bucket ACL, server-side encryption, exact-origin CORS, custom HTTPS CNAME requirement for affected new mainland China accounts, seven-day incomplete multipart expiry, local dedicated RAM assume-role identity, and production ECS instance role. Link the official multipart permission table and state why the browser actions are exactly `PutObject`, `ListParts`, and `AbortMultipartUpload`.

```json
{
  "Effect": "Allow",
  "Action": ["oss:AbortMultipartUpload", "oss:ListParts", "oss:PutObject"],
  "Resource": ["acs:oss:*:*:BUCKET/users/USER_ID/patterns/PATTERN_ID/*"]
}
```

- [ ] **Step 5: Verify policy safety and commit**

```bash
npm test -- src/features/storage
npm run typecheck
git grep -nE 'oss:\*|AliyunOSSFullAccess|oss:(InitiateMultipartUpload|UploadPart|CompleteMultipartUpload)' -- src || true
git add src/features/storage src/test/fake-oss.ts docs/operations/aliyun-oss.md
git commit -m "feat: define secure OSS access boundary"
```

Expected: storage tests pass and the grep has no source-code matches.

## Task 8: Implement the Server Upload Lifecycle and Authorized Downloads

**Files:**
- Create: `src/features/uploads/contracts.ts`, `file-signatures.ts`, `upload-service.ts`
- Create: `src/app/api/uploads/init/route.ts`
- Create: `src/app/api/uploads/[sessionId]/credentials/route.ts`
- Create: `src/app/api/uploads/[sessionId]/complete/route.ts`
- Create: `src/app/api/uploads/[sessionId]/cancel/route.ts`
- Create: `src/app/api/assets/[assetId]/download/route.ts`, `view/route.ts`
- Test: `src/features/uploads/file-signatures.test.ts`
- Test: `src/features/uploads/upload-service.integration.test.ts`
- Test: `src/app/api/uploads/init/route.test.ts`

- [ ] **Step 1: Write failing validation and lifecycle tests**

Unit-test JPEG, PNG, PSD `8BPS`, PDF AI, PostScript AI and ZIP-container Procreate signatures. Reject extension/signature mismatch and declared sizes above `209715200`.

The lifecycle integration test injects fakes and proves idempotency:

```ts
const initialized = await initializeUpload({ ownerId, operationId, input });
expect(initialized.pattern.status).toBe("uploading");
const first = await completeUpload({ ownerId, sessionId: initialized.session.id, operationId, assets });
const second = await completeUpload({ ownerId, sessionId: initialized.session.id, operationId, assets });
expect(second.pattern.id).toBe(first.pattern.id);
expect(await countCurrentSourceAssets(first.pattern.id)).toBe(1);
```

Another owner must receive the same 404 response for the session and asset. Run and expect failure because the service does not exist.

- [ ] **Step 2: Implement strict request contracts and signature detection**

Initialization accepts client-generated pattern/source asset UUIDs, a stable operation UUID, original filename, extension, size, lastModified and optional hash. Completion accepts the same operation ID and an array whose roles are unique. Server-side detection reads only the required prefix bytes and returns a typed detected format; ZIP alone is insufficient unless the extension is `.procreate`.

```ts
export const uploadInitSchema = z.object({
  patternId: z.string().uuid(),
  sourceAssetId: z.string().uuid(),
  operationId: z.string().uuid(),
  originalFilename: z.string().min(1).max(255),
  extension: z.enum(["psd", "ai", "jpg", "jpeg", "png", "procreate"]),
  sizeBytes: z.number().int().positive().max(209_715_200),
  lastModified: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
```

Return stable codes `UPLOAD_FILE_TOO_LARGE`, `UPLOAD_EXTENSION_UNSUPPORTED`, `UPLOAD_SIGNATURE_MISMATCH`, `UPLOAD_SESSION_EXPIRED`, and `UPLOAD_OBJECT_INVALID`.

- [ ] **Step 3: Implement initialization, refresh, completion, and cancel transactions**

Initialization claims `(ownerId, operationId)`, creates pattern/source placeholder/session and a change event in one transaction, then issues STS. Credential refresh loads by owner and rejects terminal or expired sessions.

Initialization never searches by content hash and never deduplicates. Once a pattern becomes `ready`, no source-replacement endpoint exists; a revised source must create a new pattern.

Completion uses three phases. A short transaction locks the session, returns stored output when already completed, claims the normalized completion fingerprint, validates every key against the session pattern prefix and marks the session `completing`. The service then verifies size and signature through `OssAdapter` outside any database transaction with an explicit timeout. A final short transaction re-locks the session, rechecks the fingerprint and terminal state, inserts current assets, marks the pattern `ready`, marks the session completed and stores the replay result. The failure path performs the same terminal-state recheck before persisting diagnostics, so it cannot overwrite a concurrent success, cancellation or expiry.

```ts
const preparation = await claimCompletionInShortTransaction(input);
if (preparation.kind === "replay") return preparation.result;
const verified = await withTimeout(verifySubmittedAssets(oss, input.assets));
const completed = await commitVerifiedAssetsInShortTransaction(verified);
```

Cancel is idempotent: it marks the session aborted and attempts multipart abort through a browser command result when available; lifecycle expiry remains the fallback. A cancel failure returns a warning but never changes ownership checks.

- [ ] **Step 4: Implement signed view and download endpoints**

Load assets through `(ownerId, assetId)`. Preview/view URLs expire after 60 seconds and return `Cache-Control: private, no-store`; source download URLs expire after 300 seconds and include a sanitized filename. Remove CR/LF, control characters, slash, backslash and quotes before signing. Respond with `303 See Other`; never proxy a 100 MB body through Next.js.

```ts
const location = await oss.createSignedGet({ key: asset.objectKey, filename: sanitizeDownloadName(asset.originalFilename), expiresSeconds: 300 });
return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "private, no-store" } });
```

- [ ] **Step 5: Verify server behavior and commit**

```bash
npm test -- src/features/uploads/file-signatures.test.ts src/app/api/uploads/init/route.test.ts
npm run test:integration -- src/features/uploads/upload-service.integration.test.ts
npm run typecheck
npm run lint
git add src/features/uploads src/app/api/uploads src/app/api/assets
git commit -m "feat: add secure upload and download lifecycle"
```

Expected: valid formats complete, mismatches stay non-ready, retries return one result, and cross-owner probes are indistinguishable from missing IDs.

## Task 9: Add JPG/PNG Preview Generation and the Resumable Browser Queue

**Files:**
- Create: `src/features/preview/contracts.ts`, `raster-preview.worker.ts`, `raster-preview.ts`
- Create: `src/features/uploads/upload-db.ts`, `upload-store.ts`, `oss-browser-client.ts`, `upload-runner.ts`
- Create: `src/features/uploads/upload-dropzone.tsx`, `upload-tray.tsx`
- Create: `src/test/fixtures/transparent-16x16.png`, `opaque-16x16.jpg`
- Modify: `src/features/library/workspace-shell.tsx`
- Test: `src/features/preview/raster-preview.test.ts`
- Test: `src/features/uploads/upload-db.test.ts`, `upload-runner.test.ts`, `upload-tray.test.tsx`

- [ ] **Step 1: Write failing preview and queue-state tests**

```ts
expect(fitWithin({ width: 4000, height: 2000 }, 2048)).toEqual({ width: 2048, height: 1024 });
expect(selectOutputType({ hasAlpha: true })).toBe("image/png");
expect(() => assertPixelBudget({ width: 12000, height: 9000 })).toThrow("PREVIEW_PIXEL_LIMIT");
expect(states).toEqual(["draft", "hashing", "uploading", "processing", "ready"]);
```

Add tests for cancel preserving a checkpoint, explicit abandon deleting it, one credential refresh, and reselected-file mismatch before any OSS call. Inspect the serialized Dexie row and assert it contains no `File`, `Blob`, AccessKey secret or security token.

- [ ] **Step 2: Implement deterministic preview contracts and worker**

Export constants `PREVIEW_LONG_EDGE=2048`, `THUMBNAIL_LONG_EDGE=512`, `MAX_PIXELS=100_000_000`, and `PREVIEW_TIMEOUT_MS=30_000`. The worker accepts JPG/PNG, decodes with image orientation, refuses the pixel limit, creates separate canvases, preserves alpha as PNG and uses WebP for opaque output, closes the bitmap in `finally`, and returns both blobs plus dimensions.

```ts
export const PREVIEW_LONG_EDGE = 2048;
export const THUMBNAIL_LONG_EDGE = 512;
export const MAX_PIXELS = 100_000_000;
export const PREVIEW_TIMEOUT_MS = 30_000;
```

The wrapper terminates after 30 seconds and maps errors to `PREVIEW_PIXEL_LIMIT`, `PREVIEW_TIMEOUT`, or `PREVIEW_DECODE_FAILED`. Unsupported formats return `null`, allowing the source upload to continue.

- [ ] **Step 3: Implement checkpoint storage without file bytes or credentials**

Create Dexie database `melon-upload-v1` with `uploadCheckpoints` keyed by local task ID. Persist session/pattern IDs, object keys, SDK checkpoint JSON, filename, size, lastModified, hash and updated time. Export `saveCheckpoint`, `loadCheckpoint`, `deleteCheckpoint`, and `listRecoverableUploads`; cover them with `fake-indexeddb`.

```ts
class UploadDatabase extends Dexie {
  uploadCheckpoints!: Table<UploadCheckpointRow, string>;
  constructor() { super("melon-upload-v1"); this.version(1).stores({ uploadCheckpoints: "localTaskId,sessionId,patternId,updatedAt" }); }
}
```

- [ ] **Step 4: Wrap multipart upload and orchestrate the state machine**

The OSS client is constructed only from the temporary response. Use four parallel parts, 1 MiB part size, checkpoint callbacks, and overwrite protection where the SDK supports it. Recreate the client on credential refresh while retaining checkpoint state. Pause/cancel stops further work but preserves the checkpoint; “放弃上传” calls abort and deletes local recovery state.

```ts
await client.multipartUpload(objectKey, file, {
  checkpoint,
  parallel: 4,
  partSize: 1024 * 1024,
  progress: async (fraction, nextCheckpoint) => { onProgress(fraction); await saveCheckpoint(nextCheckpoint); },
});
```

`uploadRunner` validates, hashes incrementally, generates optional preview assets, initializes, uploads source and derived files, then completes with one stable operation ID. The tray has fixed rows, numeric progress, cancel/retry/reselect controls, accessible labels and no layout shift between stages.

- [ ] **Step 5: Verify browser upload behavior and commit**

```bash
npm test -- src/features/preview src/features/uploads/upload-db.test.ts src/features/uploads/upload-runner.test.ts src/features/uploads/upload-tray.test.tsx
npm run typecheck
npm run lint
git add src/features/preview src/features/uploads src/features/library/workspace-shell.tsx src/test/fixtures
git commit -m "feat: add resumable browser upload queue"
```

Expected: queue and preview tests pass and serialized checkpoints contain neither source bytes nor temporary credentials.

## Task 10: Complete Core E2E Coverage and Record the Milestone

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/fixtures.ts`
- Create: `tests/e2e/core-library.spec.ts`, `tenant-isolation.spec.ts`
- Create: `src/features/storage/oss-adapter.real.integration.test.ts`
- Create: `docs/verification/2026-10-08-foundation-library.md`
- Modify: `README.md`

- [ ] **Step 1: Write the failing browser journeys**

Core flow must log in, upload the transparent fixture, observe progress, rename it, add a tag, filter it, preview it, toggle favorite, and download the original filename. The tenant journey creates two users and proves user A cannot list, edit, view, download, complete a session, or refresh credentials for user B.

```ts
test("uploads, tags, filters, previews and downloads", async ({ page }) => {
  await loginAs(page, "designer@example.com");
  await page.getByRole("button", { name: "上传" }).click();
  await page.getByLabel("选择文件").setInputFiles("src/test/fixtures/transparent-16x16.png");
  await expect(page.getByText("上传完成")).toBeVisible();
  await page.getByRole("button", { name: /transparent-16x16/ }).click();
  await page.getByLabel("图案名称").fill("Watermelon Bloom");
  await addTag(page, "夏季");
  await expect(page.getByRole("button", { name: /Watermelon Bloom/ })).toBeVisible();
});
```

Configure Chromium and WebKit at 1440×900 plus WebKit at 1024×1366. E2E selects an in-process fake adapter only when `NODE_ENV=test` and `OSS_ADAPTER=fake`; production environment parsing rejects that adapter value.

- [ ] **Step 2: Add test fixtures and deterministic setup**

Each worker receives an isolated database schema or serial execution with a reset hook. Seed users through the same admin service used by CLI commands. Fake OSS stores bytes in process memory, supports HEAD/range/signing semantics, and resets before each test. Do not special-case ownership inside routes.

```ts
export class FakeOssAdapter implements OssAdapter {
  readonly objects = new Map<string, Uint8Array>();
  async headObject(key: string) { const value = this.require(key); return { sizeBytes: value.byteLength, contentType: "application/octet-stream" }; }
  async readRange(key: string, start: number, endInclusive: number) { return this.require(key).slice(start, endInclusive + 1); }
  async deleteObjects(keys: string[]) { for (const key of keys) this.objects.delete(key); }
  async createSignedGet({ key }: { key: string; filename: string; expiresSeconds: number }) { this.require(key); return `http://127.0.0.1/fake-oss/${encodeURIComponent(key)}`; }
  private require(key: string) { const value = this.objects.get(key); if (!value) throw new Error("OSS_OBJECT_NOT_FOUND"); return value; }
}
```

- [ ] **Step 3: Run the full foundation gate**

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Expected: every command exits 0; all three browser projects pass; the 1024 px workspace has no page-level horizontal overflow.

- [ ] **Step 4: Optionally smoke-test a dedicated real OSS prefix**

Only with operator-provided local credentials and an isolated test Bucket/prefix, run:

```bash
RUN_REAL_OSS_TESTS=1 npm run test:integration -- src/features/storage/oss-adapter.real.integration.test.ts
```

Expected: a generated object uploads by multipart, resumes after interruption, validates, downloads through a five-minute signed URL and is deleted. Without configuration, write `NOT RUN: cloud test environment not configured` in the verification record.

- [ ] **Step 5: Document evidence and commit the phase**

README documents Node 24, PostgreSQL startup, migrations, account creation, fake-OSS tests, development server and the rule that real credentials belong only in `.env.local` or an ECS role. The verification document records command, exit code, test count, browser projects and timestamp.

```bash
git grep -nE 'LTAI[A-Za-z0-9]+' -- . ':!package-lock.json' || true
git status --short
git add playwright.config.ts tests src/features/storage/oss-adapter.real.integration.test.ts docs/verification/2026-10-08-foundation-library.md README.md
git commit -m "test: verify foundation library milestone"
git status --short --branch
```

Expected: no credential-like strings, a clean branch, and a runnable online library ready for phase 02.
