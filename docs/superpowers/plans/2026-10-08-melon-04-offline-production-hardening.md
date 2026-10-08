# melon Offline Sync and Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the completed online app resilient offline for cached browsing and tag/metadata edits, add deterministic multi-device convergence and 30-day cleanup, then package and verify the MVP for production deployment.

**Architecture:** PostgreSQL remains authoritative and emits per-user ordered changes. Dexie mirrors permitted records, stores an idempotent outbox and advances its pull cursor atomically; commercial mutations stay online-only. Serwist caches only the app shell/static assets, while an application cache stores authorized thumbnails with LRU eviction. Production runs one standalone Next.js container behind Nginx with separate migration and scheduled-cleanup commands.

**Tech Stack:** Existing application plus Dexie, Serwist, Cache Storage, PostgreSQL advisory locks, Docker, Nginx, Vitest and Playwright multi-context/offline testing.

---

## File Map

```text
src/features/offline/             # Connectivity, local identity, storage pressure UI
src/features/sync/                # Dexie schema, outbox, pull/apply, conflicts
src/app/offline/page.tsx          # Public offline bootstrap shell; never private SSR data
src/app/api/sync/push/route.ts
src/app/api/sync/pull/route.ts
src/app/api/sync/snapshot/route.ts
src/features/storage/thumbnail-cache.ts
src/features/patterns/purge-service.ts
scripts/purge-trash.ts
scripts/cleanup-storage.ts
src/app/api/health/live/route.ts
src/app/api/health/ready/route.ts
Dockerfile
docker/entrypoint.sh
deploy/nginx/melon.conf
deploy/README.md
tests/e2e/offline-sync.spec.ts
tests/e2e/multi-device-conflicts.spec.ts
docs/verification/2026-10-08-mvp.md
```

## Task 1: Install Serwist and Cache the Offline App Shell

**Files:**
- Modify: `package.json`, `package-lock.json`, `next.config.ts`
- Create: `src/app/sw.ts`, `src/app/offline/page.tsx`, `src/features/offline/connectivity.tsx`
- Create: `src/features/offline/offline-bootstrap.ts`, `offline-banner.tsx`
- Modify: `src/app/layout.tsx`, `src/features/library/workspace-shell.tsx`
- Test: `src/features/offline/offline-bootstrap.test.ts`, `connectivity.test.tsx`

- [ ] **Step 1: Install Serwist and write failing offline-state tests**

```bash
npm install @serwist/next serwist
```

Test transitions `online → offline → online`, banner copy, stale-commercial-summary label, disabled upload/download/password/commercial controls, and automatic sync trigger after reconnect. Test that a browser with no prior authenticated local identity sees the login/offline-unavailable screen rather than cached private data.

- [ ] **Step 2: Configure a narrowly scoped service worker**

Wrap Next config with Serwist, emit `/sw.js`, and precache build/static app-shell assets. Runtime rules cache only same-origin scripts, styles, workers and fonts; `/api/**`, OSS signed URLs, source downloads, auth responses and user JSON never match. Navigation fallback is the static `/offline` bootstrap route, which mounts the local-identity/Dexie workspace but contains no cached server-rendered private data.

```ts
const withSerwist = withSerwistInit({ swSrc: "src/app/sw.ts", swDest: "public/sw.js", disable: process.env.NODE_ENV === "development" });
export default withSerwist(nextConfig);
```

```ts
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: { navigateFallback: "/offline" },
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
});

serwist.registerCapture(
  ({ request, sameOrigin, url }) =>
    sameOrigin &&
    !url.pathname.startsWith("/api/") &&
    ["script", "style", "worker", "font"].includes(request.destination),
  new CacheFirst({ cacheName: "melon-static-v1" }),
);

serwist.addEventListeners();
```

- [ ] **Step 3: Implement local identity bootstrap**

After successful online session validation, store only `{ userId, displayName, lastValidatedAt }` in a small local record. Offline bootstrap opens that user's isolated Dexie database and labels the whole session “离线数据，待联网验证”. On reconnect, revalidate session before pushing; invalid/changed user clears in-memory views and routes to login without sending another user's outbox.

```ts
export type LocalIdentity = { userId: string; displayName: string; lastValidatedAt: string };
export function openOfflineWorkspace(identity: LocalIdentity | null) {
  if (!identity) return { kind: "unavailable" as const };
  return { kind: "cached" as const, dbName: `melon-${identity.userId}-v1`, stale: true };
}
```

- [ ] **Step 4: Wire connectivity to feature capabilities**

Export explicit capability flags:

```ts
export const capabilities = (online: boolean) => ({
  cachedBrowse: true,
  metadataOutbox: true,
  upload: online,
  sourceDownload: online,
  manualPreview: online,
  passwordChange: online,
  authorizationWrite: online,
  dashboardRefresh: online,
  permanentDelete: online,
});
```

Components consume capabilities rather than scattered `navigator.onLine` checks.

- [ ] **Step 5: Verify and commit shell behavior**

```bash
npm test -- src/features/offline
npm run typecheck
npm run lint
npm run build
git add package.json package-lock.json next.config.ts src/app/sw.ts src/app/layout.tsx src/features/offline src/features/library/workspace-shell.tsx
git commit -m "feat: add offline app shell"
```

Expected: production build emits the service worker and tests prove no private API/source response is a runtime-cache candidate.

## Task 2: Create the Per-User Dexie Mirror and Thumbnail LRU

**Files:**
- Create: `src/features/sync/local-db.ts`, `local-types.ts`, `local-db.test.ts`
- Create: `src/features/storage/thumbnail-cache.ts`, `thumbnail-cache.test.ts`
- Create: `src/features/offline/storage-settings.tsx`, `logout-cleanup.ts`
- Modify: `src/app/(workspace)/settings/page.tsx`

- [ ] **Step 1: Write failing isolation and eviction tests**

Using `fake-indexeddb`, open databases for users A/B, insert the same pattern ID with different values and prove isolation. Assert logout deletes only that user's database and thumbnail cache. Fill thumbnails past a test quota and prove least-recently-used thumbnails are evicted while outbox, sync cursor and upload checkpoints remain.

```ts
expect((await dbA.patterns.get(patternId))?.name).toBe("A");
expect((await dbB.patterns.get(patternId))?.name).toBe("B");
await clearLocalUserData(userA);
expect(await Dexie.exists(`melon-${userA}-v1`)).toBe(false);
expect(await Dexie.exists(`melon-${userB}-v1`)).toBe(true);
```

- [ ] **Step 2: Define the versioned local schema**

```ts
export type LocalSyncState = { key: "state"; lastSeq: string; lastSnapshotAt: string | null };
export type OutboxRow = {
  operationId: string;
  entityType: "pattern" | "tag" | "pattern_tag";
  entityId: string;
  action: string;
  payload: unknown;
  status: "pending" | "sending" | "needs_attention";
  createdOrder: number;
  errorCode: string | null;
};
```

Database name is `melon-${userId}-v1`. Tables are `patterns`, `assets`, `tags`, `patternTags`, `outbox`, `syncState`, `uploadCheckpoints`, and `commercialSummaries`. Do not store original source blobs, signed URLs, authorization detail history, STS credentials or passwords.

- [ ] **Step 3: Implement stable thumbnail caching**

Fetch authorized thumbnail bytes online, then cache their response under a synthetic same-origin key `/__thumbnail-cache/{ownerId}/{assetId}/{version}`. Metadata tracks size and last access in Dexie. Before writes, call Storage Estimate; evict only thumbnail entries until below the soft threshold. Cache failures fall back to network/placeholder without losing metadata.

```ts
const cacheKey = new Request(`/__thumbnail-cache/${ownerId}/${assetId}/${version}`);
await cache.put(cacheKey, response.clone());
await db.thumbnailMeta.put({ cacheKey: cacheKey.url, assetId, sizeBytes, lastAccessedAt: Date.now() });
```

- [ ] **Step 4: Add storage settings and logout cleanup**

Settings displays estimated metadata/cache usage, exact last sync time and a “清理缩略图缓存” command. Logout first closes Dexie, deletes the user's local database and synthetic cache entries, clears local identity, then signs out. A failed cache deletion is reported but cannot retain the authenticated UI session.

```ts
export async function clearLocalUserData(userId: string) {
  await closeUserDatabase(userId);
  await Dexie.delete(`melon-${userId}-v1`);
  await deleteSyntheticThumbnailEntries(userId);
  localStorage.removeItem("melon:last-user");
}
```

- [ ] **Step 5: Verify and commit local storage**

```bash
npm test -- src/features/sync/local-db.test.ts src/features/storage/thumbnail-cache.test.ts src/features/offline
npm run typecheck
npm run lint
git add src/features/sync src/features/storage/thumbnail-cache.ts src/features/storage/thumbnail-cache.test.ts src/features/offline src/app/'(workspace)'/settings
git commit -m "feat: add isolated local data cache"
```

## Task 3: Implement Server Push, Pull, and Snapshot Protocols

**Files:**
- Create: `src/features/sync/contracts.ts`, `sync-service.ts`, `sync-repository.ts`
- Create: `src/app/api/sync/push/route.ts`, `pull/route.ts`, `snapshot/route.ts`
- Test: `src/features/sync/sync-service.integration.test.ts`
- Test: `src/app/api/sync/push/route.test.ts`, `pull/route.test.ts`

- [ ] **Step 1: Write failing idempotency and sequence tests**

Push the same operation twice and assert one mutation/change sequence. Push two valid operations and assert strictly increasing per-user sequences. Pull after sequence N returns only later rows in order. Another user cannot observe sequence values or entities. Snapshot contains current non-deleted library state, active tag relations and commercial summaries, but no authorization details.

```ts
const first = await push(ownerId, [operation]);
const replay = await push(ownerId, [operation]);
expect(replay.results[0]).toEqual(first.results[0]);
expect(await countOperations(operation.operationId)).toBe(1);
expect(await countChangesForOperation(operation.operationId)).toBe(1);
```

- [ ] **Step 2: Define a closed operation union**

```ts
export const syncOperationSchema = z.discriminatedUnion("action", [
  z.object({ operationId: z.string().uuid(), action: z.literal("pattern.rename"), entityId: z.string().uuid(), payload: z.object({ name: z.string().trim().min(1).max(160) }) }),
  z.object({ operationId: z.string().uuid(), action: z.literal("pattern.favorite"), entityId: z.string().uuid(), payload: z.object({ isFavorite: z.boolean() }) }),
  z.object({ operationId: z.string().uuid(), action: z.literal("tag.create"), entityId: z.string().uuid(), payload: z.object({ name: z.string(), colorToken: z.string() }) }),
  z.object({ operationId: z.string().uuid(), action: z.literal("tag.rename"), entityId: z.string().uuid(), payload: z.object({ name: z.string() }) }),
  z.object({ operationId: z.string().uuid(), action: z.literal("tag.color"), entityId: z.string().uuid(), payload: z.object({ colorToken: z.string() }) }),
  z.object({ operationId: z.string().uuid(), action: z.enum(["pattern_tag.add", "pattern_tag.remove"]), entityId: z.string().uuid(), payload: z.object({ patternId: z.string().uuid(), tagId: z.string().uuid() }) }),
]);
```

No commercial, upload, password, download, preview or permanent-delete action is accepted.

- [ ] **Step 3: Implement operation-by-operation transactions**

Process a batch in local order, one transaction per operation, so one conflict does not roll back unrelated accepted work. Claim operation ID first and return the stored result on retry. Scalar writes apply as the last legal server-accepted operation; trashed/deleted checks run before versions. Pattern-tag add/remove updates only that relation and enforces the 20-tag limit.

```ts
for (const operation of input.operations) {
  results.push(await db.transaction((tx) => applyOneSyncOperation(tx, ownerId, operation)));
}
return { results };
```

Concurrent same-name tag creation returns the existing canonical ID and `idRemap`; rename conflicts return `TAG_NAME_CONFLICT`; deleted targets return `SYNC_ENTITY_DELETED`; over-limit relations return `TAG_LIMIT_EXCEEDED`.

- [ ] **Step 4: Implement bounded pull and authoritative snapshot**

Pull accepts decimal-string `afterSeq` and limit ≤500, orders by seq, and returns `nextSeq` plus `hasMore`. Snapshot streams/page-builds the complete local projection and returns current server sequence. Both derive owner from session. Authorization change events carry only the recalculated per-pattern commercial summary and server update time; snapshots contain the same summaries, never authorization detail history.

```ts
export const pullQuerySchema = z.object({ afterSeq: z.string().regex(/^\d+$/), limit: z.coerce.number().int().min(1).max(500).default(200) });
export type PullDto = { changes: ChangeDto[]; nextSeq: string; hasMore: boolean };
export type SnapshotDto = { serverSeq: string; patterns: LocalPattern[]; assets: LocalAsset[]; tags: LocalTag[]; patternTags: LocalPatternTag[]; commercialSummaries: LocalCommercialSummary[] };
```

- [ ] **Step 5: Verify and commit server sync**

```bash
npm run test:integration -- src/features/sync/sync-service.integration.test.ts
npm test -- src/app/api/sync/push/route.test.ts src/app/api/sync/pull/route.test.ts
npm run typecheck
npm run lint
git add src/features/sync src/app/api/sync
git commit -m "feat: add ordered synchronization API"
```

## Task 4: Implement Client Outbox, Pull Application, and Conflict UI

**Files:**
- Create: `src/features/sync/outbox.ts`, `sync-runner.ts`, `apply-changes.ts`
- Create: `src/features/sync/conflict-center.tsx`, `sync-status.tsx`
- Modify: `src/features/library/pattern-mutations.ts`, `src/features/tags/tag-picker.tsx`
- Modify: `src/features/library/topbar.tsx`
- Test: `src/features/sync/outbox.test.ts`, `sync-runner.test.ts`, `apply-changes.test.ts`
- Test: `src/features/sync/conflict-center.test.tsx`

- [ ] **Step 1: Write failing replay and conflict tests**

Test ordered replay after restart, retry with stable operation IDs, crash after server commit/before local delete, atomic cursor advance, ID remap across tags/relations/pending operations, scalar convergence, 21st-tag rollback, deleted-target discard and rename conflict moving to `needs_attention` without retry loop.

```ts
await runner.pushOnce();
simulateBrowserCrashBeforeOutboxDelete();
await runner.pushOnce();
expect(await serverOperationCount(operationId)).toBe(1);
expect(await db.outbox.get(operationId)).toBeUndefined();
```

- [ ] **Step 2: Route permitted offline edits through one transaction**

Each offline mutation updates its local row and inserts an outbox record atomically. Repeated edits to one scalar may coalesce only before sending while retaining the newest user intent and one operation ID; add/remove relations may cancel each other only when neither has been sent. Upload checkpoints remain in their own lifecycle.

```ts
await db.transaction("rw", db.patterns, db.outbox, async () => {
  await db.patterns.update(patternId, { name: nextName, localDirty: true });
  await db.outbox.put(makeRenameOperation({ patternId, name: nextName }));
});
```

- [ ] **Step 3: Implement push-then-pull convergence**

On online start/reconnect: revalidate session, mark stale `sending` rows pending, push ordered batches, apply per-operation results/remaps in one Dexie transaction, then pull until `hasMore=false`. Apply server changes and advance `lastSeq` in the same Dexie transaction. If the cursor is invalid, replace mirror tables from snapshot but preserve outbox and upload checkpoints.

```ts
export async function synchronize() {
  await revalidateOnlineSession();
  await recoverSendingRows();
  await pushPendingBatches();
  do { await pullAndApplyNextPage(); } while (await hasMoreServerChanges());
}
```

- [ ] **Step 4: Build concise conflict recovery UI**

Topbar shows offline/syncing/action-needed states with fixed width. Conflict center lists tag rename conflicts with server name, attempted name and an editable retry; deleted-target/limit errors show one dismissible explanation after local rollback. Cached commercial summaries show “可能已过期” offline and provide no edit controls.

```tsx
<output className="sync-status" aria-live="polite">{status === "needs_attention" ? "同步需要处理" : statusLabel}</output>
{!online ? <span className="stale-badge">商业数据可能已过期</span> : null}
```

- [ ] **Step 5: Verify and commit client sync**

```bash
npm test -- src/features/sync src/features/library src/features/tags/tag-picker.test.tsx
npm run typecheck
npm run lint
git add src/features/sync src/features/library src/features/tags
git commit -m "feat: synchronize offline metadata edits"
```

Expected: retry/reload tests converge without duplicates, lost outbox rows or client-clock ordering.

## Task 5: Add Scheduled Trash and Storage Cleanup

**Files:**
- Create: `src/features/patterns/purge-service.ts`, `purge-repository.ts`
- Create: `src/features/storage/orphan-cleanup.ts`
- Create: `scripts/purge-trash.ts`, `scripts/cleanup-storage.ts`
- Modify: `package.json`
- Test: `src/features/patterns/purge-service.integration.test.ts`
- Test: `src/features/storage/orphan-cleanup.integration.test.ts`

- [ ] **Step 1: Write failing due-date, retry, and lock tests**

Freeze time and seed patterns at 29 days 23:59, exactly 30 days, and 31 days. Only due trashed patterns may purge. Simulate OSS deletion success followed by database failure and prove retry completes; simulate two job processes and prove advisory lock/row skipping prevents double work. Verify C semantics again: authorization rows and old commercial change payloads disappear, dashboard history decreases, final tombstone survives.

```ts
expect(await findDuePatternIds(now)).toEqual([exactlyThirtyDaysId, thirtyOneDaysId]);
await Promise.all([runPurgeBatch(now), runPurgeBatch(now)]);
expect(await deletionEventCount(exactlyThirtyDaysId)).toBe(1);
```

- [ ] **Step 2: Implement a bounded purge batch**

Acquire a PostgreSQL advisory lock keyed to `melon-trash-purge`. Select at most 100 due rows ordered by `trashedAt` using `for update skip locked`, then invoke the phase-02 idempotent permanent-deletion service per pattern. Release the lock in `finally`. Emit structured counts for selected/deleted/retried/failed without names, notes, credentials or signed URLs.

```sql
select id
from patterns
where status = 'trashed' and trashed_at <= now() - interval '30 days'
order by trashed_at, id
for update skip locked
limit 100
```

- [ ] **Step 3: Implement conservative orphan cleanup**

Only delete derived/temp object keys that are explicitly recorded as pending cleanup or belong to expired upload sessions. Never infer ownership by broad bucket listing and never delete a key still referenced by `assets`. Incomplete multipart parts are primarily handled by the seven-day OSS lifecycle rule; the script may abort a recorded expired upload ID with exact key/prefix.

```ts
for (const candidate of await listRecordedCleanupCandidates(100)) {
  if (await isObjectKeyReferenced(candidate.objectKey)) continue;
  await oss.deleteObjects([candidate.objectKey]);
  await markCleanupComplete(candidate.id);
}
```

- [ ] **Step 4: Add executable job commands**

```json
{
  "scripts": {
    "job:purge-trash": "tsx scripts/purge-trash.ts",
    "job:cleanup-storage": "tsx scripts/cleanup-storage.ts"
  }
}
```

Both scripts parse server environment, open database/cloud adapters, run one bounded batch, close resources and exit nonzero when any item remains failed. They do not run automatically during application startup.

- [ ] **Step 5: Verify and commit cleanup jobs**

```bash
npm run test:integration -- src/features/patterns/purge-service.integration.test.ts src/features/storage/orphan-cleanup.integration.test.ts
npm run typecheck
npm run lint
git add src/features/patterns src/features/storage scripts package.json package-lock.json
git commit -m "feat: add idempotent data cleanup jobs"
```

## Task 6: Package the Application and Harden the Production Edge

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`
- Create: `deploy/nginx/melon.conf`, `deploy/README.md`
- Create: `src/app/api/health/live/route.ts`, `ready/route.ts`
- Create: `src/lib/security/origin.ts`, `headers.ts`, `rate-limit.ts`, `redaction.ts`
- Modify: `next.config.ts`, authentication actions and state-changing Route Handlers
- Test: `src/lib/security/origin.test.ts`, `headers.test.ts`, `redaction.test.ts`
- Test: `src/app/api/health/ready/route.integration.test.ts`

- [ ] **Step 1: Write failing origin, header, redaction, and readiness tests**

Assert state-changing requests with a mismatched Origin are 403, exact app origin is accepted, security headers include CSP/nosniff/referrer policy, log redaction removes AccessKey/security tokens/signed query parameters/passwords/notes, liveness never checks dependencies, and readiness fails when PostgreSQL or required OSS configuration is unavailable.

```ts
expect(await mutateWithOrigin("https://attacker.example")).toMatchObject({ status: 403 });
expect(await mutateWithOrigin(APP_ORIGIN)).toMatchObject({ status: 200 });
expect(redactLog({ password: "secret", securityToken: "token" })).toEqual({ password: "[REDACTED]", securityToken: "[REDACTED]" });
```

- [ ] **Step 2: Implement application security boundaries**

All POST/PATCH/DELETE handlers call one same-origin guard in addition to Auth.js session checks. CSP permits self, blob workers, exact OSS HTTPS CNAME for image/connect traffic, and required inline hashes/nonces only. Add `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, frame denial, and production HSTS at Nginx.

```ts
export function assertSameOrigin(request: Request, appOrigin: string) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== appOrigin) throw new AppError("ORIGIN_FORBIDDEN", 403);
}
```

Application login backoff keys a one-way hash of normalized email plus coarse IP and never logs the email. Nginx adds an IP rate limit for the login endpoint. A single-instance in-memory limiter is acceptable for MVP and is documented as requiring shared storage before horizontal scaling.

- [ ] **Step 3: Build a non-root standalone image**

Use a multi-stage Node 24 Alpine image: dependencies, build, then runner containing `.next/standalone`, `.next/static`, public assets and no dev dependencies. Run as an unprivileged UID, expose 3000, set `NODE_ENV=production`, and use liveness/readiness endpoints. `entrypoint.sh` starts the app only; database migration is a separate deployment command.

```dockerfile
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
FROM deps AS build
COPY . .
RUN npm run build
FROM node:24-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 4: Configure Nginx and deployment procedure**

Nginx terminates TLS, forwards real IP/request ID, applies security headers and login rate limits, and keeps metadata request limits small because source files upload directly to OSS. Deployment docs sequence: back up → run reviewed migration job → deploy app → verify readiness → schedule cleanup commands → smoke test login/upload/download. Document RDS backups/PITR, exact OSS CORS/CNAME, instance role, secret injection and rollback.

```nginx
limit_req_zone $binary_remote_addr zone=melon_login:10m rate=5r/m;
location /api/auth/callback/credentials { limit_req zone=melon_login burst=5 nodelay; proxy_pass http://melon:3000; }
location / { proxy_set_header X-Request-ID $request_id; proxy_set_header X-Forwarded-Proto https; proxy_pass http://melon:3000; }
```

- [ ] **Step 5: Verify build/security and commit**

```bash
npm test -- src/lib/security
npm run test:integration -- src/app/api/health/ready/route.integration.test.ts
npm run typecheck
npm run lint
npm run build
docker build -t melon:mvp .
git add Dockerfile .dockerignore docker deploy src/lib/security src/app/api/health next.config.ts
git commit -m "chore: harden production deployment"
```

Expected: app and image builds succeed, container runs non-root, and security tests pass.

## Task 7: Verify Offline, Multi-Device, Performance, and Accessibility Behavior

**Files:**
- Create: `tests/e2e/offline-sync.spec.ts`, `multi-device-conflicts.spec.ts`
- Create: `tests/e2e/storage-pressure.spec.ts`, `accessibility-layout.spec.ts`
- Create: `scripts/seed-library-performance.ts`
- Create: `docs/verification/2026-10-08-offline-hardening.md`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Write offline reload journeys**

Online-load library data/thumbnails, switch Playwright context offline, reload, browse/search cached items, rename/tag, and assert uploads/downloads/commercial writes are disabled. Reconnect, await sync, reload from server and assert edits persisted. Log out and prove IndexedDB/cache data is gone.

```ts
await page.goto("/library");
await context.setOffline(true);
await page.reload();
await page.getByLabel("图案名称").fill("离线改名");
await expect(page.getByRole("button", { name: "新增授权" })).toBeDisabled();
await context.setOffline(false);
await expect(page.getByText("已同步")).toBeVisible();
```

- [ ] **Step 2: Write deterministic multi-device conflicts**

Use two browser contexts for one user. Cover same-field scalar edits, independent tag add/remove, concurrent same-name tag creation with ID remap, conflicting tag rename requiring action, 20-tag limit, trash beating stale metadata, and permanent deletion rejecting stale outbox operations. Assert both contexts converge after push/pull without using their clocks.

```ts
const deviceA = await browser.newContext();
const deviceB = await browser.newContext();
await loginContext(deviceA, user);
await loginContext(deviceB, user);
await runConcurrentTagScenario(deviceA, deviceB);
expect(await readLocalProjection(deviceA)).toEqual(await readLocalProjection(deviceB));
```

- [ ] **Step 3: Exercise storage pressure and target scale**

Mock Storage Estimate near quota, cache thumbnails, and prove LRU eviction leaves outbox/cursor/checkpoints intact. Seed 10,000 patterns and measure virtualized DOM count, cursor queries, search/filter selection and initial cached snapshot application. Store thresholds and actual results in the verification document; fail on unbounded DOM growth or a full-library client render.

```ts
expect(await page.locator("[data-pattern-card]").count()).toBeLessThan(200);
expect(await countRows("outbox")).toBe(before.outbox);
expect(await countRows("uploadCheckpoints")).toBe(before.uploadCheckpoints);
```

- [ ] **Step 4: Run layout/accessibility checks**

Install `@axe-core/playwright`, register `"seed:library-performance": "tsx scripts/seed-library-performance.ts"`, then at Chromium/WebKit 1440×900 and WebKit 1024×1366 take light/dark screenshots for library, inspector, dashboard, trash, settings, upload tray and conflict center. Run axe against each primary page, keyboard through each workflow, and assert no page horizontal overflow, clipped longest Chinese labels, incoherent overlap or invisible focus.

```bash
npm install --save-dev @axe-core/playwright
```

- [ ] **Step 5: Run and commit the hardening gate**

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
npm run seed:library-performance
git add tests/e2e scripts/seed-library-performance.ts docs/verification/2026-10-08-offline-hardening.md
git commit -m "test: verify offline and production hardening"
```

## Task 8: Run the Complete MVP Acceptance Gate

**Files:**
- Create: `docs/verification/2026-10-08-mvp.md`
- Modify: `README.md`

- [ ] **Step 1: Re-run every required automated command from a clean process**

Stop stale app processes, retain only isolated PostgreSQL, apply migrations to a fresh test database, then run:

```bash
npm ci
npm run db:migrate
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
docker build -t melon:mvp .
```

Record exact exit codes, counts, browser projects, commit SHA and timestamp. Any failure keeps the MVP status incomplete.

- [ ] **Step 2: Audit scope and security invariants**

```bash
git grep -nE 'LTAI[A-Za-z0-9]+' -- . ':!package-lock.json' || true
git grep -nE 'AliyunOSSFullAccess|oss:\*|oss:(InitiateMultipartUpload|UploadPart|CompleteMultipartUpload)' -- src deploy || true
git grep -nE '/register|api/register' -- src || true
git status --short
```

Expected: no secrets, broad/invented OSS actions or registration route, and no unexplained worktree changes.

- [ ] **Step 3: Run the optional real-cloud smoke test**

With an operator-configured isolated Bucket/prefix and deployment-like role chain, test multipart interruption/resume, credential refresh, completion verification, preview view, five-minute source download and cleanup. If not configured, record `NOT RUN` without requesting a root or broad AccessKey.

```bash
RUN_REAL_OSS_TESTS=1 npm run test:integration -- src/features/storage/oss-adapter.real.integration.test.ts
```

- [ ] **Step 4: Walk the eleven approved acceptance criteria**

For each criterion in the main design, link the automated test/evidence that proves it. Include the commercial design's ten criteria, especially field/buyout concurrency, void/restore, dashboard ranges, dark theme and C permanent deletion. Mark gaps explicitly; do not replace missing evidence with prose.

```bash
rg -n '^([0-9]+)\.' docs/superpowers/specs/2026-10-08-melon-web-design.md docs/superpowers/specs/2026-10-08-melon-commercial-authorization-dashboard-design.md
```

- [ ] **Step 5: Finalize operator/user instructions and commit evidence**

README must cover local setup, account provisioning, theme, upload support, preview limitations, authorization semantics, backup/restore, cleanup schedule and credential handling. Then commit only documentation evidence:

```bash
git add README.md docs/verification/2026-10-08-mvp.md
git commit -m "docs: record melon MVP acceptance"
git status --short --branch
```

Expected: clean branch and evidence-backed MVP completion; mobile-specific redesign, collaboration and other out-of-scope work remain unclaimed.
