# Inspiration Concept Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a designer generate up to three durable AI concept images per research direction, review them inside the visual board, share completed concepts with an AI label, and explicitly save a generated concept as an independent library pattern.

**Architecture:** A POST creates an idempotent local `concept_image` job, validates the selected immutable direction, and submits one Qwen-Image asynchronous task. GET polls the provider and conditionally finalizes the local job; on provider success it immediately downloads the temporary PNG through the existing safe importer, stores it in private OSS, and inserts one generated asset. A separate idempotent service converts an owned completed concept into a normal ready pattern with server-generated preview/thumbnail assets.

**Tech Stack:** Next.js 16.4.1 Route Handlers, Node.js 24 `fetch`/Web Crypto, Qwen-Image 3.0 DashScope async API, Zod 4, Drizzle/PostgreSQL, `ali-oss`, `sharp`, TanStack Query 5, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-melon-inspiration-visual-board-design.md`

**Prerequisites:** Complete both `2026-10-29-melon-inspiration-visual-foundation.md` and `2026-10-29-melon-inspiration-web-evidence.md` first.

## Global Constraints

- Use the workspace-scoped `DASHSCOPE_NATIVE_BASE_URL`; model, endpoint hostname, workspace ID, and API key must stay in one region/workspace.
- Submit async creation to `${DASHSCOPE_NATIVE_BASE_URL}/services/aigc/image-generation/generation` with `X-DashScope-Async: enable`; poll `${DASHSCOPE_NATIVE_BASE_URL}/tasks/{taskId}`.
- Allow only `qwen-image-3.0` in this release. Map the product ratio `3:4` to `1536*2048`; request exactly one image.
- Build prompts only from the validated direction: title, direction, silhouette, palette, materials, and details. Never include web HTML, raw provider output, hidden fields, or private library object data.
- The fixed prompt requires an original fashion concept, no logo/brand, no recognizable public figure, no UI/text, and no claim that the concept is market evidence.
- Store provider task/request IDs only in database server fields. Never return the provider task ID, temporary result URL, object key, or raw rejection reason.
- Provider tasks/results expire after about 24 hours. On `SUCCEEDED`, import the image before marking the local job completed.
- Permit one pending concept per direction and at most three completed concepts per direction. Failed jobs do not consume the limit.
- Concurrent polls may both download, but only one conditional database completion may win; the loser must delete its just-written object.
- A concept failure affects only that direction. It cannot change the text report, research visual job, or concepts in other directions.
- “保存到图库” always creates independent pattern objects. Deleting the report/concept later cannot delete the saved pattern.
- Generated images always carry an “AI 生成” product label in report/share UI; do not represent them as web evidence or user-uploaded originals.
- Offline tests use a fake provider and fake object stores. The real smoke is opt-in and creates at most one billed image.

---

## File Map

### New files

- `src/features/inspiration-visuals/concept-contracts.ts`: concept create, poll, save, and error schemas.
- `src/features/inspiration-visuals/concept-contracts.test.ts`: strict input/output and secrecy tests.
- `src/features/inspiration-visuals/concept-prompt.ts`: deterministic server-only prompt builder.
- `src/features/inspiration-visuals/concept-prompt.test.ts`: field bounds and content-policy tests.
- `src/features/inspiration-visuals/qwen-image-protocol.ts`: async request/response parsers.
- `src/features/inspiration-visuals/qwen-image-protocol.test.ts`: provider fixture tests.
- `src/features/inspiration-visuals/qwen-image-provider.ts`: create/query HTTP adapter.
- `src/features/inspiration-visuals/qwen-image-provider.test.ts`: transport, timeout, status, and redaction tests.
- `src/features/inspiration-visuals/qwen-image-provider.real.test.ts`: one-image opt-in smoke.
- `src/features/inspiration-visuals/concept-service.ts`: creation, polling, limits, durable completion, and recovery.
- `src/features/inspiration-visuals/concept-service.integration.test.ts`: state/concurrency/isolation/lifecycle tests.
- `src/features/inspiration-visuals/concept-library-store.ts`: validated server-side writes to normal pattern object keys.
- `src/features/inspiration-visuals/concept-library-store.test.ts`: key scope and compensation tests.
- `src/features/inspiration-visuals/concept-library-service.ts`: idempotent pattern/asset import transaction.
- `src/features/inspiration-visuals/concept-library-service.integration.test.ts`: independent lifecycle and replay tests.
- `src/app/api/inspiration-analyses/[analysisId]/concepts/route.ts`: create concept job.
- `src/app/api/inspiration-analyses/[analysisId]/concepts/route.test.ts`: create route contract.
- `src/app/api/inspiration-analyses/[analysisId]/concepts/[jobId]/route.ts`: query/advance concept job.
- `src/app/api/inspiration-analyses/[analysisId]/concepts/[jobId]/route.test.ts`: poll route contract.
- `src/app/api/inspiration-analyses/[analysisId]/concepts/[assetId]/save-to-library/route.ts`: save concept.
- `src/app/api/inspiration-analyses/[analysisId]/concepts/[assetId]/save-to-library/route.test.ts`: save route contract.
- `src/features/inspiration/inspiration-concept-gallery.tsx`: per-direction concept states/actions.
- `src/features/inspiration/inspiration-concept-dialog.tsx`: large concept preview and save action.

### Modified files

- `src/lib/env/server.ts`: concept flag, model allowlist, and ratio.
- `src/lib/env/server.test.ts`: concept configuration tests.
- `src/lib/env/production-readiness.ts`: enabled model/endpoint checks.
- `src/lib/env/production-readiness.test.ts`: production gate cases.
- `.env.example`: disabled concept defaults.
- `src/features/inspiration-visuals/visual-repository.ts`: concept job/asset queries and conditional transitions.
- `src/features/inspiration-visuals/visual-service.ts`: board projection includes completed concepts and pending/failed jobs.
- `src/features/inspiration-visuals/visual-resource-service.ts`: generated concepts are owner/share-readable.
- `src/features/inspiration-visuals/contracts.ts`: board concept projection and save state.
- `src/features/inspiration-visuals/inspiration-visual-api.ts`: create/poll/save client calls.
- `src/features/inspiration-visuals/query-keys.ts`: per-job concept polling keys.
- `src/features/inspiration/inspiration-direction-list.tsx`: compose concept gallery per direction.
- `src/features/inspiration/inspiration-visual-board.tsx`: include concepts in summary when present.
- `src/features/inspiration/inspiration-view.test.tsx`: generation, polling, failure, retry, and save flows.
- `src/features/inspiration/shared-inspiration-page.tsx`: completed AI concepts with label.
- `src/features/inspiration/shared-inspiration-page.test.tsx`: public concept/read-only tests.
- `src/features/inspiration/inspiration.module.css`: concept grid and states.
- `src/lib/db/schema/inspiration-visuals.integration.test.ts`: concept/save constraints.
- `package.json` and lockfile: direct `sharp` dependency and real smoke script.
- `README.md`: model setup, billing warning, smoke, rollout, and rollback.
- `tests/e2e/inspiration-visuals-fixtures.ts`: add provider-state and saved-pattern fixtures.
- `tests/e2e/inspiration-visuals.spec.ts`: add concept generation/share/save lifecycle coverage.

---

### Task 1: Lock Concept Contracts and Configuration

**Files:**
- Create: `src/features/inspiration-visuals/concept-contracts.ts`
- Create: `src/features/inspiration-visuals/concept-contracts.test.ts`
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`
- Modify: `src/lib/env/production-readiness.ts`
- Modify: `src/lib/env/production-readiness.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: concept mutation/save schemas, stable errors, and typed model config.
- Consumes: visual job/asset contracts, operation ID, and normalized text helpers.

- [ ] **Step 1: Write failing contract tests**

Test strict create `{ operationId, directionIndex }`, direction bounds `0..4`, save `{ operationId, title? }`, title trim/NFC/1–160, generated asset same-origin `imageUrl`, and absence of provider IDs/URLs/object keys/owner IDs. Test all stable codes.

- [ ] **Step 2: Write failing configuration tests**

Disabled mode accepts blanks. Enabled mode requires `INSPIRATION_ENABLED`, API key/workspace/native base URL, model `qwen-image-3.0`, and ratio `3:4`. Reject other model strings and a workspace hostname mismatch.

- [ ] **Step 3: Run focused red tests**

Run: `npm test -- src/features/inspiration-visuals/concept-contracts.test.ts src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts`

Expected: FAIL because concept contracts/config do not exist.

- [ ] **Step 4: Implement exact public inputs and errors**

```ts
export const conceptCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  directionIndex: z.number().int().min(0).max(4),
}).strict();

export const conceptSaveMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  title: z.string().trim().transform((value) => value.normalize("NFC"))
    .pipe(z.string().min(1).max(160).refine(hasNoNullByte)).optional(),
}).strict();

export const conceptErrorCodeSchema = z.enum([
  "INSPIRATION_CONCEPT_DISABLED", "INSPIRATION_CONCEPT_LIMIT_REACHED",
  "INSPIRATION_CONCEPT_BUSY", "INSPIRATION_CONCEPT_REJECTED",
  "INSPIRATION_CONCEPT_TIMEOUT", "INSPIRATION_CONCEPT_UNAVAILABLE",
]);
```

Define a strict save response `{ patternId, libraryHref, saved: true }`. Extend the generated concept DTO with nullable `savedPatternId` and `libraryHref`, but never `saveOperationId`.

- [ ] **Step 5: Implement configuration and readiness gates**

```ts
INSPIRATION_CONCEPT_IMAGES_ENABLED: optionalBoolean,
INSPIRATION_IMAGE_MODEL: z.enum(["qwen-image-3.0"]).default("qwen-image-3.0"),
INSPIRATION_IMAGE_SIZE: z.enum(["3:4"]).default("3:4"),
```

When enabled, require the core inspiration provider config and reject native URLs whose workspace hostname differs from `DASHSCOPE_WORKSPACE_ID`. Add an `.env.example` billing comment and keep the flag false by default.

- [ ] **Step 6: Run and commit contracts/config**

```bash
npm test -- src/features/inspiration-visuals/concept-contracts.test.ts src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts
git add src/features/inspiration-visuals/concept-contracts* src/lib/env/server.ts src/lib/env/server.test.ts src/lib/env/production-readiness* .env.example
git commit -m "feat: define concept image contracts"
```

---

### Task 2: Build the Fixed Concept Prompt and Qwen Async Adapter

**Files:**
- Create: `src/features/inspiration-visuals/concept-prompt.ts`
- Create: `src/features/inspiration-visuals/concept-prompt.test.ts`
- Create: `src/features/inspiration-visuals/qwen-image-protocol.ts`
- Create: `src/features/inspiration-visuals/qwen-image-protocol.test.ts`
- Create: `src/features/inspiration-visuals/qwen-image-provider.ts`
- Create: `src/features/inspiration-visuals/qwen-image-provider.test.ts`

**Interfaces:**
- Produces: `buildConceptPrompt`, `QwenImageProvider.create/query`, and validated provider states.
- Consumes: one validated `InspirationPrompt` and typed server config.

- [ ] **Step 1: Write failing prompt tests**

Test deterministic ordering, Unicode-safe truncation, maximum 1,600 code points, no URL/HTML/object metadata, all six direction fields, and fixed clauses for original design, no logo, no public figure, no text/UI, garment-centered 3:4 composition, and no market-evidence claim.

- [ ] **Step 2: Write failing provider fixture tests**

Cover create PENDING; query PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN; missing/mismatched task ID; multiple/empty results; content rejection; malformed/oversized JSON; create/query timeouts; and error/log redaction of key and full result URL.

- [ ] **Step 3: Run red tests**

Run: `npm test -- src/features/inspiration-visuals/concept-prompt.test.ts src/features/inspiration-visuals/qwen-image-protocol.test.ts src/features/inspiration-visuals/qwen-image-provider.test.ts`

Expected: FAIL because modules are absent.

- [ ] **Step 4: Implement the fixed request**

```ts
export function buildQwenImageCreateRequest(prompt: string) {
  return {
    model: "qwen-image-3.0",
    input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
    parameters: {
      n: 1, size: "1536*2048", prompt_extend: true, watermark: false,
      negative_prompt: "品牌标志，文字，水印，界面元素，可识别名人，低清晰度，肢体畸形，重复服装",
    },
  } as const;
}
```

Create headers include `Authorization`, JSON content type, and `X-DashScope-Async: enable`. Query uses Authorization only. Parse JSON through the existing bounded JSON utility with a 1 MiB cap.

- [ ] **Step 5: Implement status mapping**

Return a provider-only union:

```ts
type QwenImageTask =
  | { state: "pending"; taskId: string; requestId: string }
  | { state: "succeeded"; taskId: string; requestId: string; temporaryImageUrl: string }
  | { state: "rejected"; taskId: string; requestId: string }
  | { state: "failed"; taskId: string; requestId: string };
```

Map `DataInspectionFailed` and equivalent content-policy outcomes to rejected. Map CANCELED/UNKNOWN to failed. The temporary URL type must remain in the provider module and never be accepted by a public schema.

- [ ] **Step 6: Run and commit provider code**

```bash
npm test -- src/features/inspiration-visuals/concept-prompt.test.ts src/features/inspiration-visuals/qwen-image-protocol.test.ts src/features/inspiration-visuals/qwen-image-provider.test.ts
git add src/features/inspiration-visuals/concept-prompt* src/features/inspiration-visuals/qwen-image-*
git commit -m "feat: integrate qwen concept tasks"
```

---

### Task 3: Create, Poll, and Durably Complete Concept Jobs

**Files:**
- Create: `src/features/inspiration-visuals/concept-service.ts`
- Create: `src/features/inspiration-visuals/concept-service.integration.test.ts`
- Modify: `src/features/inspiration-visuals/visual-repository.ts`
- Modify: `src/features/inspiration-visuals/visual-service.ts`
- Modify: `src/features/inspiration-visuals/contracts.ts`
- Modify: `src/lib/db/schema/inspiration-visuals.integration.test.ts`

**Interfaces:**
- Produces: `createConceptJob`, `getAndAdvanceConceptJob`, concept board projection.
- Consumes: core analysis ownership, prompt/provider, safe image fetch, visual object store, and visual tables.

- [ ] **Step 1: Write failing integration tests**

Cover completed-analysis requirement; exact direction validation against result length; feature disabled; per-direction pending uniqueness; three-success limit; operation replay/mismatch; owner isolation; provider-create failure; PENDING/RUNNING; rejection; unknown; timeout; success import; provider URL expiry; concurrent success polls; OSS-write then DB-failure compensation; and board sorting by direction/creation.

- [ ] **Step 2: Run the red integration suite**

Run: `npm run test:integration -- src/features/inspiration-visuals/concept-service.integration.test.ts`

Expected: FAIL because concept service functions do not exist.

- [ ] **Step 3: Implement local-first task creation**

Within a short transaction, lock/read the completed analysis, validate `directionIndex < result.inspirationPrompts.length`, count completed concepts, enforce no pending job, and create/replay the local job. Outside the transaction, call `provider.create`. Then conditionally write `providerTaskId/providerRequestId` while status is pending.

If provider creation fails, mark the local job failed. If the provider accepted a task but the DB update loses its compare-and-set, best-effort cancel the provider task if the provider supports cancellation; otherwise record only stable operational telemetry. Never issue a second provider create for the same operation ID.

- [ ] **Step 4: Implement poll and durable completion**

On GET, read the owned job. Completed/failed jobs return directly. A pending job without provider ID older than three minutes becomes unavailable/interrupted. Otherwise query the provider:

- PENDING/RUNNING: return pending; if still pending after 30 minutes, mark timeout.
- REJECTED: conditionally mark `INSPIRATION_CONCEPT_REJECTED`.
- FAILED/UNKNOWN: conditionally mark unavailable or timeout based on age.
- SUCCEEDED: call the safe importer for the provider URL, require PNG and expected pixel bounds, write `users/{ownerId}/inspiration/{analysisId}/concepts/{assetId}.png`, then run one transaction that changes pending to completed and inserts the generated asset.

If another poll already completed the job, delete the losing object and return the winner. If the transaction fails, delete the just-written object before throwing.

- [ ] **Step 5: Add board projection and recovery**

Return completed concept assets plus the newest pending/failed job per direction. Do not include temporary URLs. Analysis deletion uses the web-plan lifecycle wrapper and therefore cleans concept object keys too. A saved pattern is not in that prefix and is unaffected.

- [ ] **Step 6: Run integration/regression tests and commit**

```bash
npm run test:integration -- src/features/inspiration-visuals/concept-service.integration.test.ts src/features/inspiration-visuals/visual-service.integration.test.ts src/lib/db/schema/inspiration-visuals.integration.test.ts
git add src/features/inspiration-visuals/concept-service* src/features/inspiration-visuals/visual-repository.ts src/features/inspiration-visuals/visual-service.ts src/features/inspiration-visuals/contracts.ts src/lib/db/schema/inspiration-visuals.integration.test.ts
git commit -m "feat: persist inspiration concept images"
```

---

### Task 4: Expose Concept Create, Poll, and Client APIs

**Files:**
- Create: `src/app/api/inspiration-analyses/[analysisId]/concepts/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concepts/route.test.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concepts/[jobId]/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concepts/[jobId]/route.test.ts`
- Modify: `src/features/inspiration-visuals/inspiration-visual-api.ts`
- Modify: `src/features/inspiration-visuals/query-keys.ts`

**Interfaces:**
- Produces: authenticated create/poll routes and browser methods.
- Consumes: concept contracts, `requireApiUser`, same-origin enforcement, and concept service.

- [ ] **Step 1: Write failing route tests**

Test unauthenticated, malformed analysis/job IDs, strict body, cross-origin create, owner forwarding, `202` pending response, completed replay, stable 404 across owner, and GET query advancing only the requested job.

- [ ] **Step 2: Run red route tests**

```bash
npm test -- 'src/app/api/inspiration-analyses/[analysisId]/concepts/route.test.ts' 'src/app/api/inspiration-analyses/[analysisId]/concepts/[jobId]/route.test.ts'
```

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement handlers**

POST uses `assertSameOrigin`, parses `conceptCreateMutationSchema`, and returns `202`. GET has no body, validates both UUID params, and is uncached by default. Both derive owner from `requireApiUser`; neither accepts an owner/task ID in query or JSON.

- [ ] **Step 4: Add browser client and polling keys**

Methods: `createConcept(analysisId, input)`, `pollConcept(analysisId, jobId, signal)`. Parse responses using the visual board/job DTOs. Query keys include owner, analysis, `concept`, and job ID. Poll delays are `2s, 3s, 5s, 8s, 10s` and then 10 seconds; stop immediately on completed/failed or component unmount.

- [ ] **Step 5: Run and commit routes**

```bash
npm test -- 'src/app/api/inspiration-analyses/[analysisId]/concepts/route.test.ts' 'src/app/api/inspiration-analyses/[analysisId]/concepts/[jobId]/route.test.ts'
git add 'src/app/api/inspiration-analyses/[analysisId]/concepts' src/features/inspiration-visuals/inspiration-visual-api.ts src/features/inspiration-visuals/query-keys.ts
git commit -m "feat: expose concept image jobs"
```

---

### Task 5: Render Per-Direction Concept Generation and Sharing

**Files:**
- Create: `src/features/inspiration/inspiration-concept-gallery.tsx`
- Create: `src/features/inspiration/inspiration-concept-dialog.tsx`
- Modify: `src/features/inspiration/inspiration-direction-list.tsx`
- Modify: `src/features/inspiration/inspiration-visual-board.tsx`
- Modify: `src/features/inspiration/inspiration-view.test.tsx`
- Modify: `src/features/inspiration/shared-inspiration-page.tsx`
- Modify: `src/features/inspiration/shared-inspiration-page.test.tsx`
- Modify: `src/features/inspiration/inspiration.module.css`
- Modify: `src/features/inspiration-visuals/visual-resource-service.ts`
- Modify: `src/features/inspiration-visuals/visual-resource-service.integration.test.ts`

**Interfaces:**
- Produces: direction-local generate/retry/loading/gallery UX and public completed concept display.
- Consumes: concept API/query state and owner/share visual byte routes.

- [ ] **Step 1: Add failing component/resource tests**

Test hidden action when disabled; one direction loading without blocking others; retry creates a new operation ID; completed image shows “AI 生成”; exactly three disables generation with an explanation; rejection has a local error; refresh restores persisted images; dialog focus/escape; share includes completed concepts only; revoked share bytes 404.

- [ ] **Step 2: Run red tests**

```bash
npm test -- src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/shared-inspiration-page.test.tsx
npm run test:integration -- src/features/inspiration-visuals/visual-resource-service.integration.test.ts
```

- [ ] **Step 3: Implement direction-local state**

Each direction receives its completed assets and newest job. Create mutation writes pending state into the visual-board cache, then starts the job query. On terminal state, invalidate the board once. Do not put a global spinner over the report or disable unrelated direction buttons.

- [ ] **Step 4: Implement concept presentation**

Use a fixed 3:4 grid with no nested cards. Each image has an always-visible “AI 生成” label and alt text derived from the direction title, not provider output. The dialog repeats the label and offers only close/save-to-library; it does not show provider metadata.

- [ ] **Step 5: Extend owner/share resource authorization**

Allow completed `generated_concept` rows in the same opaque resource routes from phase two. Share DTO includes completed concepts and excludes pending/failed jobs, provider error codes, and saved-library metadata that could reveal private patterns.

- [ ] **Step 6: Run and commit UI/share changes**

```bash
npm test -- src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/shared-inspiration-page.test.tsx
npm run test:integration -- src/features/inspiration-visuals/visual-resource-service.integration.test.ts
git add src/features/inspiration/inspiration-concept* src/features/inspiration/inspiration-direction-list.tsx src/features/inspiration/inspiration-visual-board.tsx src/features/inspiration/shared-inspiration-page* src/features/inspiration/inspiration.module.css src/features/inspiration-visuals/visual-resource-service*
git commit -m "feat: present inspiration concept images"
```

---

### Task 6: Save a Concept as an Independent Library Pattern

**Files:**
- Create: `src/features/inspiration-visuals/concept-library-store.ts`
- Create: `src/features/inspiration-visuals/concept-library-store.test.ts`
- Create: `src/features/inspiration-visuals/concept-library-service.ts`
- Create: `src/features/inspiration-visuals/concept-library-service.integration.test.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concepts/[assetId]/save-to-library/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concepts/[assetId]/save-to-library/route.test.ts`
- Modify: `src/features/inspiration-visuals/inspiration-visual-api.ts`
- Modify: `src/features/inspiration/inspiration-concept-dialog.tsx`
- Modify: `package.json`
- Modify: lockfile.

**Interfaces:**
- Produces: idempotent concept-to-pattern import, route/client, and saved UI state.
- Consumes: visual object reader, normal pattern object-key builders, `sharp`, pattern/assets/change log/operations, and visual-search enqueue.

- [ ] **Step 1: Install the proven image processor**

Run: `npm install sharp`

Expected: direct `sharp` dependency and lockfile update. Do not rely on an undeclared transitive Next.js copy.

- [ ] **Step 2: Write failing store/service tests**

Cover owned completed generated asset only; web/library/pending/other-owner 404; default and custom title; source PNG plus 1600px preview and 640px thumbnail WebP; SHA-256; ready pattern; change sequence/log; visual-search enqueue; operation replay/mismatch; concurrent saves; OSS write/DB failure cleanup; saved pattern deletion then re-save; and report deletion preserving saved pattern bytes/rows.

- [ ] **Step 3: Implement a pattern-key-scoped writer**

Define `ConceptLibraryStore.putPatternObject/getVisualObject/deletePatternObjects`. The Alibaba implementation may share client construction with `visual-object-store.ts`, but each public method validates its own key family. It must never accept an arbitrary key from a route/body.

- [ ] **Step 4: Generate the three library assets**

Read the owned concept PNG, verify its hash, then create:

```ts
const preview = await sharp(source).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
const thumbnail = await sharp(source).rotate().resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
```

Generate independent pattern/source/preview/thumbnail UUIDs and canonical keys with `storageObjectKey`. Write all three before the DB transaction; retain the key list for compensation.

- [ ] **Step 5: Implement the idempotent transaction**

Lock the visual asset and recheck owner/kind/completed state. If `savedPatternId` still points to an existing owned pattern, return it and delete this attempt's temporary objects. Reject an operation ID already attached to another asset. Otherwise insert a ready pattern and three assets, increment owner change sequence, enqueue visual search for the preview, write change log/operation result, and set `savedPatternId/saveOperationId` on the visual asset in one transaction.

If the transaction fails or loses a race, delete all objects written by the losing attempt. The saved pattern object prefix is independent from the analysis prefix, so report deletion cannot reach it.

- [ ] **Step 6: Implement and test the route/client/UI**

POST requires session, same origin, analysis/asset UUIDs, and strict save mutation. Return `201` for a new pattern and `200` for replay if the service exposes that distinction; both bodies use `conceptSaveResultSchema`. On success update the concept asset cache and change the action to “在图库中查看”.

- [ ] **Step 7: Run and commit the full save flow**

```bash
npm test -- src/features/inspiration-visuals/concept-library-store.test.ts 'src/app/api/inspiration-analyses/[analysisId]/concepts/[assetId]/save-to-library/route.test.ts' src/features/inspiration/inspiration-view.test.tsx
npm run test:integration -- src/features/inspiration-visuals/concept-library-service.integration.test.ts
npm run typecheck
git add src/features/inspiration-visuals/concept-library* 'src/app/api/inspiration-analyses/[analysisId]/concepts/[assetId]/save-to-library' src/features/inspiration-visuals/inspiration-visual-api.ts src/features/inspiration/inspiration-concept-dialog.tsx package.json package-lock.json
git commit -m "feat: save concept images to library"
```

---

### Task 7: Run Real Smoke, E2E, Visual QA, and Release Gates

**Files:**
- Create: `src/features/inspiration-visuals/qwen-image-provider.real.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/e2e/inspiration-visuals-fixtures.ts`
- Modify: `tests/e2e/inspiration-visuals.spec.ts`

**Interfaces:**
- Produces: explicit billed smoke, full workflow coverage, and operator rollout instructions.
- Consumes: the finished concept feature.

- [ ] **Step 1: Add one opt-in real test**

Add `test:inspiration:concept-real` guarded by `RUN_REAL_INSPIRATION_CONCEPT_TESTS=1`. It creates one 3:4 `qwen-image-3.0` task, polls with bounded backoff, imports the resulting PNG to a temporary visual key, validates dimensions/content type, deletes the smoke object, and never prints the result URL or key.

- [ ] **Step 2: Add failing E2E coverage**

With a fake provider, test create -> pending -> completed, refresh persistence, local rejection/retry, three-image limit, share label, save-to-library, open saved pattern, delete report, and confirm the saved pattern remains. Test two simultaneous browser sessions cannot view each other's concepts.

- [ ] **Step 3: Run offline gates**

```bash
npm test -- src/features/inspiration src/features/inspiration-visuals 'src/app/api/inspiration-analyses/[analysisId]/concepts'
npm run test:integration -- src/features/inspiration-visuals/concept-service.integration.test.ts src/features/inspiration-visuals/concept-library-service.integration.test.ts src/features/inspiration-visuals/visual-resource-service.integration.test.ts
npm run typecheck
npm run lint
npm run build
npm run test:e2e -- tests/e2e/inspiration-visuals.spec.ts --project=chromium
git diff --check
```

Expected: every command exits 0 without a provider call.

- [ ] **Step 4: Run the explicit real smoke once**

Run: `RUN_REAL_INSPIRATION_CONCEPT_TESTS=1 npm run test:inspiration:concept-real`

Expected: one task reaches succeeded, persists/validates/deletes its smoke object, and exits 0. If credentials/model access are unavailable, keep the feature flag false and record the stable failure code; do not bypass the gate.

- [ ] **Step 5: Inspect target viewports and pixels**

At `1512x982`, `1280x800`, `768x1024`, and `390x844`, inspect zero/one/three concepts, longest Chinese direction text, pending/rejected states, dialog, and saved action. Confirm no overlaps, layout shift, blank images, clipped labels, or horizontal overflow. Verify each rendered concept has non-uniform canvas pixels and the correct 3:4 frame.

- [ ] **Step 6: Document rollout and rollback**

README must state billing, model/region/workspace alignment, opt-in smoke, release order, and rollback: set `INSPIRATION_CONCEPT_IMAGES_ENABLED=false`; existing completed images remain readable/shareable, while generation buttons disappear.

- [ ] **Step 7: Commit verification and docs**

```bash
git add src/features/inspiration-visuals/qwen-image-provider.real.test.ts package.json README.md tests/e2e/inspiration-visuals-fixtures.ts tests/e2e/inspiration-visuals.spec.ts
git commit -m "test: verify inspiration concept workflow"
```

---

## Concept Image Acceptance Checklist

- [ ] Each click creates at most one billed provider task and replay never creates another.
- [ ] Only a valid direction of an owned completed analysis can create a task.
- [ ] Every direction has at most one pending and at most three completed images.
- [ ] Provider pending/rejection/failure/unknown/timeout states map to stable local states.
- [ ] Temporary provider URLs are imported before completion and never enter browser DTOs/logs.
- [ ] Concurrent poll/database failures clean up losing/orphan objects.
- [ ] Generated images persist across refresh, show “AI 生成”, and remain direction-local.
- [ ] Active shares show completed concepts only; revocation immediately blocks byte routes.
- [ ] Saving creates source/preview/thumbnail assets, visual-search work, and an independent ready pattern.
- [ ] Repeated/concurrent save requests create exactly one pattern; report deletion does not delete it.
- [ ] Feature-off mode hides generation actions without affecting existing text, library matches, or completed images.
- [ ] Offline tests incur no provider cost; the one-image real smoke is explicit and passes before enablement.
