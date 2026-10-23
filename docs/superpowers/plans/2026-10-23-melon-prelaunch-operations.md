# Melon Prelaunch Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production configuration fail closed and provide repeatable systemd deployment, maintenance scheduling, rollback, and target-host verification instructions.

**Architecture:** A pure readiness validator evaluates the already parsed server environment, while a thin CLI loads environment files and emits only safe error codes. systemd units run the standalone web process and existing idempotent maintenance commands from an atomic release symlink.

**Tech Stack:** TypeScript, Zod, Next.js standalone output, systemd, PostgreSQL/RDS, existing npm maintenance commands.

---

## File Map

- `src/lib/env/server.ts`, `server.test.ts`: parse explicit image-search release approval.
- `src/lib/env/production-readiness.ts`, `production-readiness.test.ts`: pure launch gate.
- `scripts/check-production.ts`, `check-production.test.ts`: safe CLI and output formatting.
- `package.json`, `package-lock.json`: expose `prod:check` and keep `tsx` available to production maintenance commands.
- `deploy/systemd/melon-web.service`: standalone web process.
- `deploy/systemd/melon-preview-cleanup.service/.timer`: five-minute cleanup.
- `deploy/systemd/melon-trash-cleanup.service/.timer`: daily trash cleanup.
- `deploy/systemd/melon-auth-cleanup.service/.timer`: daily auth-bucket cleanup.
- `src/features/storage/operations-doc.test.ts`: executable deployment-policy assertions.
- `docs/operations/web-production.md`: host preparation, release, migration, health, backup/restore, monitoring, rollback, and remaining gates.
- `README.md`: link the production guide and preflight command.

## Task 1: Add an explicit image-search release attestation

**Files:**
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing environment test**

Add:

```ts
it("requires explicit production approval when image search is enabled", () => {
  expect(() => parseServerEnv({
    ...validEnv,
    ...enabledImageSearchEnv,
    NODE_ENV: "production",
  })).toThrow(/release approval/i);

  expect(parseServerEnv({
    ...validEnv,
    ...enabledImageSearchEnv,
    NODE_ENV: "production",
    IMAGE_SEARCH_RELEASE_APPROVED: "true",
  }).IMAGE_SEARCH_RELEASE_APPROVED).toBe(true);
});
```

Development and test environments may keep approval false while exercising the feature locally.

- [ ] **Step 2: Run and verify the missing-gate failure**

```bash
npm test -- src/lib/env/server.test.ts
```

Expected: FAIL because production currently accepts enabled image search without the attestation.

- [ ] **Step 3: Parse and enforce the flag**

Add `IMAGE_SEARCH_RELEASE_APPROVED: optionalBoolean` and a production-only `superRefine` issue when image search is enabled without approval. Add to `.env.example`:

```dotenv
IMAGE_SEARCH_RELEASE_APPROVED=false
```

- [ ] **Step 4: Run tests and commit**

```bash
npm test -- src/lib/env/server.test.ts
git add .env.example src/lib/env/server.ts src/lib/env/server.test.ts
git commit -m "feat: gate production image search release"
```

## Task 2: Implement the production preflight validator

**Files:**
- Create: `src/lib/env/production-readiness.ts`
- Create: `src/lib/env/production-readiness.test.ts`
- Create: `scripts/check-production.ts`
- Create: `scripts/check-production.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing validator tests**

Define a complete valid production environment and mutate one property per case. Require stable error codes for development mode, non-HTTPS origin, origin path/query, test database, sample auth secret, untrusted proxy, fake OSS, long-term AccessKey, missing operator/contact/effective date, incomplete public-security filing pair, and unapproved image search.

```ts
expect(validateProductionReadiness(validProductionEnv)).toEqual([]);
expect(validateProductionReadiness({
  ...validProductionEnv,
  APP_ORIGIN: "http://app.example.test",
})).toContain("APP_ORIGIN_HTTPS_REQUIRED");
```

- [ ] **Step 2: Run and verify the missing-validator failure**

```bash
npm test -- src/lib/env/production-readiness.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure validator**

Export:

```ts
export type ProductionReadinessError =
  | "NODE_ENV_PRODUCTION_REQUIRED"
  | "APP_ORIGIN_HTTPS_REQUIRED"
  | "APP_ORIGIN_INVALID"
  | "PRODUCTION_DATABASE_REQUIRED"
  | "AUTH_SECRET_PLACEHOLDER"
  | "TRUSTED_PROXY_REQUIRED"
  | "REAL_OSS_REQUIRED"
  | "LONG_TERM_ACCESS_KEY_FORBIDDEN"
  | "SITE_OPERATOR_REQUIRED"
  | "SITE_CONTACT_REQUIRED"
  | "LEGAL_EFFECTIVE_DATE_REQUIRED"
  | "PUBLIC_SECURITY_FILING_INCOMPLETE"
  | "IMAGE_SEARCH_RELEASE_NOT_APPROVED";

export function validateProductionReadiness(
  env: ServerEnv,
): ProductionReadinessError[];
```

Compare `APP_ORIGIN` to `new URL(APP_ORIGIN).origin`, decode the database pathname, reject names ending `_test`, `_e2e`, or `_performance_test`, and check only presence/shape rather than printing values.

- [ ] **Step 4: Write failing CLI-runner tests**

Define and test:

```ts
export function formatProductionReadinessErrors(
  errors: ProductionReadinessError[],
): string;
```

Assert output contains only stable codes plus a fixed prefix, and does not contain the supplied `AUTH_SECRET`, database URL, AccessKey, internal token, or signed-like query strings.

- [ ] **Step 5: Implement the CLI**

`scripts/check-production.ts` loads Next environment files, dynamically imports `getServerEnv`, runs the validator, prints `Production preflight: PASS` on success, prints one code per line on failure, and sets `process.exitCode = 1`. Zod failures are reduced to field paths and generic issue messages without serializing input.

Add:

```json
"prod:check": "node --conditions=react-server --import tsx scripts/check-production.ts"
```

Move `tsx` from `devDependencies` to `dependencies` because production timers execute TypeScript maintenance commands after development packages are pruned.

- [ ] **Step 6: Run focused tests and a negative local smoke**

```bash
npm test -- src/lib/env/production-readiness.test.ts scripts/check-production.test.ts
NODE_ENV=development npm run prod:check
```

Expected: tests PASS; the smoke command exits non-zero with safe field/error codes and no secret values.

- [ ] **Step 7: Commit preflight**

```bash
git add package.json package-lock.json scripts/check-production.ts scripts/check-production.test.ts src/lib/env/production-readiness.ts src/lib/env/production-readiness.test.ts
git commit -m "feat: add production configuration preflight"
```

## Task 3: Add tested systemd units

**Files:**
- Create: `deploy/systemd/melon-web.service`
- Create: `deploy/systemd/melon-preview-cleanup.service`
- Create: `deploy/systemd/melon-preview-cleanup.timer`
- Create: `deploy/systemd/melon-trash-cleanup.service`
- Create: `deploy/systemd/melon-trash-cleanup.timer`
- Create: `deploy/systemd/melon-auth-cleanup.service`
- Create: `deploy/systemd/melon-auth-cleanup.timer`
- Modify: `src/features/storage/operations-doc.test.ts`

- [ ] **Step 1: Write failing deployment-policy tests**

Extend `operations-doc.test.ts` to read the seven files and assert:

```ts
expect(webUnit).toMatch(/User=melon/);
expect(webUnit).toMatch(/EnvironmentFile=\/etc\/melon\/web\.env/);
expect(webUnit).toMatch(/WorkingDirectory=\/opt\/melon\/current/);
expect(webUnit).toMatch(/HOSTNAME=127\.0\.0\.1/);
expect(webUnit).toMatch(/ExecStartPre=.*npm run prod:check/);
expect(webUnit).toMatch(/ExecStart=.*\.next\/standalone\/server\.js/);
expect(webUnit).toMatch(/ExecStartPost=.*\/api\/health\/ready/);
expect(webUnit).toMatch(/Restart=on-failure/);
expect(webUnit).toMatch(/NoNewPrivileges=true/);
expect(previewTimer).toMatch(/OnUnitActiveSec=5min/);
expect(trashTimer).toMatch(/OnCalendar=daily/);
expect(authTimer).toMatch(/OnCalendar=daily/);
```

Assert each cleanup service is `Type=oneshot`, uses `/etc/melon/web.env`, runs its exact npm command, has a timeout, and never embeds a credential-like value.

- [ ] **Step 2: Run and verify missing-unit failures**

```bash
npm test -- src/features/storage/operations-doc.test.ts
```

Expected: FAIL with missing systemd files.

- [ ] **Step 3: Implement `melon-web.service`**

Use this contract:

```ini
[Unit]
Description=Melon web application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=melon
Group=melon
EnvironmentFile=/etc/melon/web.env
Environment=NODE_ENV=production
Environment=HOSTNAME=127.0.0.1
Environment=PORT=3000
WorkingDirectory=/opt/melon/current
ExecStartPre=/usr/bin/npm run prod:check
ExecStart=/usr/bin/node /opt/melon/current/.next/standalone/server.js
ExecStartPost=/bin/sh -ec 'for attempt in $$(seq 1 60); do /usr/bin/curl -fsS http://127.0.0.1:3000/api/health/ready >/dev/null && exit 0; sleep 1; done; exit 1'
Restart=on-failure
RestartSec=5s
TimeoutStartSec=120s
TimeoutStopSec=30s
MemoryMax=2G
TasksMax=256
UMask=0077
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Implement cleanup services and timers**

Each service uses `User=melon`, `Group=melon`, the shared environment file and working directory, `Type=oneshot`, `PrivateTmp=true`, `ProtectSystem=full`, `ProtectHome=true`, and `NoNewPrivileges=true`. Commands are exactly `npm run preview:cleanup`, `npm run trash:cleanup`, and `npm run auth:cleanup`.

Preview timer:

```ini
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true
Unit=melon-preview-cleanup.service
```

Trash and auth timers use `OnCalendar=daily`, `RandomizedDelaySec=30m`, and `Persistent=true`.

- [ ] **Step 5: Run policy tests and commit**

```bash
npm test -- src/features/storage/operations-doc.test.ts
git add deploy/systemd src/features/storage/operations-doc.test.ts
git commit -m "ops: add web and maintenance services"
```

## Task 4: Write the executable production runbook

**Files:**
- Create: `docs/operations/web-production.md`
- Modify: `README.md`
- Modify: `src/features/storage/operations-doc.test.ts`

- [ ] **Step 1: Write failing runbook policy assertions**

Require the document to contain exact sections or commands for: Node 24; `melon` user; `/opt/melon/releases` and atomic `/opt/melon/current`; root-owned `0600` environment file; official `npm ci`; full verification; `prod:check`; recoverable PostgreSQL backup and restore drill; migration while image search is off; standalone static/public copying; `npm prune --omit=dev`; systemd install/verify/enable; loopback checks; TLS/proxy header boundary; six-month logs; timer alerts; release rollback; non-rollback of migrations; and the remaining OSS/RAM/ECS/100-image gates.

- [ ] **Step 2: Run and verify the missing-document failure**

```bash
npm test -- src/features/storage/operations-doc.test.ts
```

Expected: FAIL because `docs/operations/web-production.md` is missing.

- [ ] **Step 3: Write the runbook with exact release commands**

Include a release skeleton using an explicit release identifier rather than an unsafe broad path:

```bash
release_id=20261023T160000Z
release_dir=/opt/melon/releases/$release_id
sudo install -d -o melon -g melon -m 0750 "$release_dir"
sudo -u melon npm ci --prefix "$release_dir"
sudo -u melon npm run build --prefix "$release_dir"
sudo -u melon install -d "$release_dir/.next/standalone/.next"
sudo -u melon cp -R "$release_dir/.next/static" "$release_dir/.next/standalone/.next/static"
sudo -u melon npm prune --omit=dev --prefix "$release_dir"
sudo ln -sfn "$release_dir" /opt/melon/current
```

Document copying `public` only when the directory exists, running migrations before pruning development tools, validating backups before migration, installing all systemd units, running `systemd-analyze verify`, and checking `systemctl list-timers`.

State that the reverse proxy must overwrite rather than append trusted client-IP headers before `AUTH_TRUST_PROXY=true`, force HTTPS, and be the only public path to port 3000.

- [ ] **Step 4: Link the runbook from README**

Add a production deployment paragraph near the existing operations links and show:

```bash
npm run prod:check
```

- [ ] **Step 5: Run policy tests and commit**

```bash
npm test -- src/features/storage/operations-doc.test.ts
git add README.md docs/operations/web-production.md src/features/storage/operations-doc.test.ts
git commit -m "docs: add web production runbook"
```

## Task 5: Verify all prelaunch hardening

- [ ] **Step 1: Run the full Node verification suite**

```bash
npm audit --omit=dev --registry=https://registry.npmjs.org
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
git diff --check
```

Expected: every command exits 0. Record exact pass/skip counts; do not convert intentional real-service skips into success claims for external gates.

- [ ] **Step 2: Verify the production configuration fails closed locally**

Run with the current non-production environment:

```bash
npm run prod:check
```

Expected: non-zero exit with safe missing/invalid configuration codes and no secret values. A successful production preflight requires the real deployment environment and is not claimed locally.

- [ ] **Step 3: Inspect the complete branch**

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only intentional branch commits, a clean worktree, and no whitespace failures.

