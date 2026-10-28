# Inspiration Visual Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the visual-intelligence-board information architecture, durable visual job/asset model, and owner-scoped library palette matching without changing the existing `inspiration-analysis-v1` text result.

**Architecture:** Add an `inspiration-visuals` feature beside the existing inspiration feature. A completed analysis can create an idempotent `research_visuals` job; phase one extracts validated hex colors, calls the existing palette-search service, persists lightweight pattern references, and returns a browser-safe board DTO. The React workspace composes text and visual DTOs while the original analysis remains independently usable.

**Tech Stack:** Next.js 16.4.1 App Router, React 19.3, TypeScript 6, Zod 4, Drizzle ORM/PostgreSQL, TanStack Query 5, Radix Dialog, Vitest/Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-melon-inspiration-visual-board-design.md`

## Global Constraints

- Read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`, `12-images.md`, and `15-route-handlers.md` before editing components or route handlers.
- Preserve `inspiration-analysis-v1`; visual state lives only in the new tables and DTOs.
- Derive every `ownerId` from the authenticated session. A missing or cross-owner analysis/job/asset must be the same 404.
- A visual job may fail without changing the analysis row, share ID, title, or text result.
- Library matches store pattern references, never duplicate pattern objects or expose object keys/search scores.
- Use the existing palette-search service and existing image-search release gate. Do not invent RGB values for color names.
- Keep all feature styles in `src/features/inspiration/inspiration.module.css`; do not redesign the global shell.
- Use stable image dimensions and explicit aspect ratios at `1512x982` and `1280x800`.
- Run database tests only against a database name ending in `_test`.
- Follow TDD and commit after every task; never combine a red test and unrelated refactor in one commit.

---

## File Map

### New files

- `src/features/inspiration-visuals/contracts.ts`: strict mutation, job, asset, board, and warning schemas.
- `src/features/inspiration-visuals/contracts.test.ts`: DTO secrecy and boundary tests.
- `src/features/inspiration-visuals/test-fixtures.ts`: valid visual job and asset fixtures.
- `src/features/inspiration-visuals/library-matcher.ts`: color extraction and palette-search orchestration.
- `src/features/inspiration-visuals/library-matcher.test.ts`: color, deduplication, and graceful-degradation tests.
- `src/features/inspiration-visuals/visual-repository.ts`: tenant-scoped job/asset state transitions.
- `src/features/inspiration-visuals/visual-service.ts`: idempotency, completed-analysis guard, stale recovery, and board assembly.
- `src/features/inspiration-visuals/visual-service.integration.test.ts`: state, isolation, concurrency, and refresh tests.
- `src/features/inspiration-visuals/inspiration-visual-api.ts`: validated browser API.
- `src/features/inspiration-visuals/query-keys.ts`: TanStack Query keys scoped by owner and analysis.
- `src/features/inspiration/inspiration-workspace-header.tsx`: compact header plus history/new-research controls.
- `src/features/inspiration/inspiration-history-dialog.tsx`: accessible history drawer.
- `src/features/inspiration/inspiration-new-dialog.tsx`: focused research input dialog.
- `src/features/inspiration/inspiration-visual-board.tsx`: visual summary, palette, warnings, and library mosaic.
- `src/features/inspiration/inspiration-direction-list.tsx`: structured direction presentation and extension point for concepts.
- `src/lib/db/schema/inspiration-visuals.ts`: job/asset enums, tables, checks, and indexes.
- `src/lib/db/schema/inspiration-visuals.integration.test.ts`: database constraint tests.
- `src/app/api/inspiration-analyses/[analysisId]/visuals/route.ts`: authenticated GET/POST.
- `src/app/api/inspiration-analyses/[analysisId]/visuals/route.test.ts`: route contract and ownership tests.
- Generated migration: `drizzle/0009_melon_inspiration_visuals.sql` and `drizzle/meta/0009_snapshot.json`.

### Modified files

- `src/lib/db/schema/index.ts`: export the visual schema.
- `src/test/database.ts`: truncate visual assets/jobs before analyses.
- `src/features/inspiration/inspiration-view.tsx`: compose header, dialogs, board, and text result.
- `src/features/inspiration/inspiration-result.tsx`: accept the new direction renderer without changing text semantics.
- `src/features/inspiration/shared-inspiration-page.tsx`: adopt the same refined reading hierarchy; no private library matches.
- `src/features/inspiration/inspiration.module.css`: desktop-first board, dialog, mosaic, and responsive rules.
- `src/features/inspiration/inspiration-view.test.tsx`: new layout and visual-state interactions.
- `src/features/inspiration/inspiration-result.test.tsx`: direction and long-content coverage.
- `tests/e2e/ui-shell.spec.ts`: desktop viewport and keyboard smoke coverage.

---

### Task 1: Lock Browser-Safe Visual Contracts

**Files:**
- Create: `src/features/inspiration-visuals/contracts.ts`
- Create: `src/features/inspiration-visuals/contracts.test.ts`
- Create: `src/features/inspiration-visuals/test-fixtures.ts`

**Interfaces:**
- Produces: `researchVisualMutationSchema`, `inspirationVisualJobDtoSchema`, `inspirationVisualBoardDtoSchema`, `libraryMatchAssetDtoSchema`, future-safe web/concept DTO variants, and inferred types.
- Consumes: `publicOperationIdSchema`, `paletteHexSchema`, and `hasNoNullByte`.

- [ ] **Step 1: Write failing strict-contract tests**

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  inspirationVisualBoardDtoSchema,
  libraryMatchAssetDtoSchema,
  researchVisualMutationSchema,
} from "./contracts";

describe("inspiration visual contracts", () => {
  it("accepts only an operation ID for research refresh", () => {
    const input = { operationId: randomUUID() };
    expect(researchVisualMutationSchema.parse(input)).toEqual(input);
    expect(() => researchVisualMutationSchema.parse({ ...input, ownerId: randomUUID() })).toThrow();
  });

  it("keeps library matches free of owner, score, and object key fields", () => {
    const parsed = libraryMatchAssetDtoSchema.parse({
      id: randomUUID(), kind: "library_match", ordinal: 0,
      directionIndex: null, title: "雨后花园", altText: "绿色植物图案",
      imageUrl: `/api/assets/${randomUUID()}/view`,
      libraryHref: `/library?selected=${randomUUID()}`,
      patternId: randomUUID(), palette: ["#66805E", "#D7D1BD"],
    });
    expect(parsed).not.toHaveProperty("ownerId");
    expect(parsed).not.toHaveProperty("distance");
    expect(parsed).not.toHaveProperty("objectKey");
  });

  it("rejects pending/failed assets and private matches in public output", () => {
    expect(() => inspirationVisualBoardDtoSchema.parse({
      activeJob: null, refreshJob: null, webEvidence: [], libraryMatches: [],
      concepts: [], unknown: true,
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `npm test -- src/features/inspiration-visuals/contracts.test.ts`

Expected: FAIL because `./contracts` does not exist.

- [ ] **Step 3: Implement strict schemas and discriminated assets**

Use exact browser-facing shapes; URLs must be same-origin paths except the source-page URL:

```ts
const localPath = z.string().regex(/^\/(?!\/)[^\0]{1,2047}$/);
const display = (max: number) => z.string().trim().min(1).max(max).refine(hasNoNullByte);

export const researchVisualMutationSchema = z.object({
  operationId: publicOperationIdSchema,
}).strict();

export const visualWarningSchema = z.enum([
  "INSPIRATION_WEB_VISUALS_DISABLED", "INSPIRATION_WEB_VISUALS_UNAVAILABLE",
  "INSPIRATION_LIBRARY_MATCH_DISABLED", "INSPIRATION_LIBRARY_MATCH_EMPTY",
  "INSPIRATION_LIBRARY_MATCH_UNAVAILABLE",
]);

export const visualJobErrorCodeSchema = z.enum([
  "INSPIRATION_VISUALS_BUSY", "INSPIRATION_VISUALS_UNAVAILABLE",
  "INSPIRATION_VISUALS_EMPTY", "INSPIRATION_VISUALS_INTERRUPTED",
  "INSPIRATION_CONCEPT_DISABLED", "INSPIRATION_CONCEPT_LIMIT_REACHED",
  "INSPIRATION_CONCEPT_BUSY", "INSPIRATION_CONCEPT_REJECTED",
  "INSPIRATION_CONCEPT_TIMEOUT", "INSPIRATION_CONCEPT_UNAVAILABLE",
]);

export const libraryMatchAssetDtoSchema = z.object({
  id: z.string().uuid(), kind: z.literal("library_match"),
  ordinal: z.number().int().nonnegative(), directionIndex: z.number().int().min(0).max(4).nullable(),
  title: display(160), altText: display(300), imageUrl: localPath,
  libraryHref: localPath, patternId: z.string().uuid(),
  palette: z.array(paletteHexSchema).max(5),
}).strict();

export const inspirationVisualJobDtoSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["research_visuals", "concept_image"]),
  directionIndex: z.number().int().min(0).max(4).nullable(),
  status: z.enum(["pending", "completed", "failed"]),
  errorCode: visualJobErrorCodeSchema.nullable(), warnings: z.array(visualWarningSchema).max(5),
  createdAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
}).strict().superRefine((job, context) => {
  const valid = job.status === "pending"
    ? job.completedAt === null && job.errorCode === null
    : job.status === "completed"
      ? job.completedAt !== null && job.errorCode === null
      : job.completedAt !== null && job.errorCode !== null;
  if (!valid) context.addIssue({ code: "custom", message: "invalid visual job state" });
});
```

Also define strict `webEvidenceAssetDtoSchema` and `generatedConceptAssetDtoSchema` now so phases two and three extend behavior without changing the board envelope. Their `imageUrl` remains a local resource path; no provider URL, object key, owner ID, provider task ID, request ID, or search distance is permitted.

Define `inspirationVisualBoardDtoSchema` as `{ activeJob, refreshJob, webEvidence, libraryMatches, concepts }`. `activeJob` is the latest completed research job, while `refreshJob` is the latest pending/failed refresh. Define a separate `publicInspirationVisualBoardDtoSchema` containing only `webEvidence` and `concepts`; it must omit `libraryMatches` entirely rather than returning an empty private field.

- [ ] **Step 4: Add cross-field tests**

Test that completed jobs require `completedAt`, failed jobs require a stable public error, direction indices are `0..4`, palette colors are uppercase, arrays are bounded (8 web, 20 library total, 15 concepts), and every schema strips nothing because all objects are strict.

- [ ] **Step 5: Run and commit contracts**

Run: `npm test -- src/features/inspiration-visuals/contracts.test.ts`

Expected: PASS.

```bash
git add src/features/inspiration-visuals/contracts.ts src/features/inspiration-visuals/contracts.test.ts src/features/inspiration-visuals/test-fixtures.ts
git commit -m "feat: define inspiration visual contracts"
```

---

### Task 2: Add the Visual Job and Asset State Model

**Files:**
- Create: `src/lib/db/schema/inspiration-visuals.ts`
- Create: `src/lib/db/schema/inspiration-visuals.integration.test.ts`
- Modify: `src/lib/db/schema/index.ts`
- Modify: `src/test/database.ts`
- Generate: `drizzle/0009_*.sql`
- Generate: `drizzle/meta/0009_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `inspirationVisualJobs`, `inspirationVisualAssets`, their enums, and `$inferSelect` row types.
- Consumes: `users`, `inspirationAnalyses`, and `patterns`.

- [ ] **Step 1: Write failing database constraint tests**

Cover owner-operation uniqueness, the expression partial unique index for a null overview direction, job state checks, kind/direction checks, asset-kind checks, stable ordering, and cascade deletion. Explicitly prove two owners can reuse an operation UUID.

- [ ] **Step 2: Run the integration test before migration**

Run: `npm run test:integration -- src/lib/db/schema/inspiration-visuals.integration.test.ts`

Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Implement the Drizzle schema**

The critical indexes/checks must compile to these semantics:

```ts
unique("inspiration_visual_jobs_owner_operation_unique").on(table.ownerId, table.operationId),
uniqueIndex("inspiration_visual_jobs_target_pending_unique")
  .on(table.analysisId, table.kind, sql`coalesce(${table.directionIndex}, -1)`)
  .where(sql`${table.status} = 'pending'`),
check("inspiration_visual_jobs_target_check", sql`(
  (${table.kind} = 'research_visuals' and ${table.directionIndex} is null)
  or (${table.kind} = 'concept_image' and ${table.directionIndex} between 0 and 4)
)`),
check("inspiration_visual_jobs_state_check", sql`(
  (${table.status} = 'pending' and ${table.completedAt} is null and ${table.errorCode} is null)
  or (${table.status} = 'completed' and ${table.completedAt} is not null and ${table.errorCode} is null)
  or (${table.status} = 'failed' and ${table.completedAt} is not null and ${table.errorCode} is not null)
)`),
```

Use one asset check that enforces:

- `web_evidence`: source page/site/query, object key, content type, width, and height are present; `patternId` is null.
- `library_match`: `patternId` is present and object/source fields are null.
- `generated_concept`: direction, object key, content type, width, and height are present.
- save fields are null unless kind is `generated_concept`.

Add `(job_id, kind, ordinal)` unique, `(owner_id, save_operation_id)` partial unique, owner/analysis indexes, a cascading pattern FK for `library_match`, and `saved_pattern_id ON DELETE SET NULL`.

- [ ] **Step 4: Generate and inspect migration 0009**

Run: `npm run db:generate -- --name=melon_inspiration_visuals`

Expected: one new migration. Inspect it for `coalesce(direction_index, -1)`, all checks, FK delete actions, and no changes to `inspiration_analyses.result`.

- [ ] **Step 5: Migrate the explicit test database and run constraints**

```bash
DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_test npm run db:migrate
npm run test:integration -- src/lib/db/schema/inspiration-visuals.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit schema and migration**

```bash
git add src/lib/db/schema/inspiration-visuals.ts src/lib/db/schema/inspiration-visuals.integration.test.ts src/lib/db/schema/index.ts src/test/database.ts drizzle
git commit -m "feat: persist inspiration visual jobs"
```

---

### Task 3: Match the Analysis Palette to the Owner's Library

**Files:**
- Create: `src/features/inspiration-visuals/library-matcher.ts`
- Create: `src/features/inspiration-visuals/library-matcher.test.ts`

**Interfaces:**
- Produces: `extractResearchPalettes(result)` and `matchLibraryPatterns(input, dependencies?)`.
- Consumes: validated `InspirationAnalysisResult`, `searchPatternsByPalette`, and `imageSearchFiltersSchema.parse({})`.

- [ ] **Step 1: Write failing pure and orchestration tests**

Test uppercase valid `colorHint` extraction, exact-hex direction palette extraction, no guessing from `"鼠尾草绿"`, five-color caps, overview dedupe to eight, direction caps to three, cross-tenant input propagation, and conversion of no-index/unavailable errors into warnings rather than job failure.

- [ ] **Step 2: Run the test and verify missing exports**

Run: `npm test -- src/features/inspiration-visuals/library-matcher.test.ts`

Expected: FAIL because `library-matcher.ts` does not exist.

- [ ] **Step 3: Implement deterministic extraction and matching**

```ts
export function extractResearchPalettes(result: InspirationAnalysisResult) {
  const overview = unique(result.dimensions.colors.flatMap((item) =>
    item.colorHint && paletteHexSchema.safeParse(item.colorHint).success ? [item.colorHint] : [],
  )).slice(0, 5);
  const directions = result.inspirationPrompts.map((prompt) =>
    unique(prompt.palette.filter((value) => paletteHexSchema.safeParse(value).success)).slice(0, 5),
  );
  return { overview, directions };
}
```

Call `searchPatternsByPalette` once for overview and once for each non-empty direction using fresh UUID request IDs, `imageSearchFiltersSchema.parse({})`, the authenticated owner, and the caller signal. Do not surface `distance`. Map only ready, non-trashed patterns with a thumbnail/preview asset into candidate records. Use global per-job ordinals even when `directionIndex` differs.

- [ ] **Step 4: Verify graceful degradation**

Run: `npm test -- src/features/inspiration-visuals/library-matcher.test.ts src/features/palette-search/palette-search-service.test.ts`

Expected: PASS, including existing palette-search regressions.

- [ ] **Step 5: Commit the matcher**

```bash
git add src/features/inspiration-visuals/library-matcher.ts src/features/inspiration-visuals/library-matcher.test.ts
git commit -m "feat: match inspiration colors to library"
```

---

### Task 4: Implement Idempotent Research Visual State Transitions

**Files:**
- Create: `src/features/inspiration-visuals/visual-repository.ts`
- Create: `src/features/inspiration-visuals/visual-service.ts`
- Create: `src/features/inspiration-visuals/visual-service.integration.test.ts`

**Interfaces:**
- Produces: `createResearchVisuals`, `getInspirationVisualBoard`, and tenant-scoped repository functions.
- Consumes: `requireOwnedInspiration`, `matchLibraryPatterns`, visual contracts, and the new tables.

- [ ] **Step 1: Write failing service integration tests**

Cover: completed-analysis guard; operation replay; operation mismatch; one pending job per target; owner isolation; stale research jobs become `INSPIRATION_VISUALS_INTERRUPTED`; successful refresh becomes active; failed refresh leaves the previous completed job active; library partial success; no assets becomes `INSPIRATION_VISUALS_EMPTY`; deleted/trashed pattern references disappear on reads.

- [ ] **Step 2: Run the integration test and confirm missing service**

Run: `npm run test:integration -- src/features/inspiration-visuals/visual-service.integration.test.ts`

Expected: FAIL because service/repository modules do not exist.

- [ ] **Step 3: Implement repository primitives**

Implement exact owner-scoped functions:

```ts
createPendingResearchJob(input)
findJobByOperation(ownerId, operationId)
findLatestCompletedResearchJob(ownerId, analysisId)
findLatestResearchRefreshJob(ownerId, analysisId)
completeResearchJob(ownerId, jobId, assets, completedAt)
failPendingJob(ownerId, jobId, errorCode, completedAt)
failStaleResearchJobs(ownerId, analysisId, cutoff)
listVisibleAssets(ownerId, jobId)
```

`completeResearchJob` must insert assets and conditionally update `pending -> completed` in one transaction. Reads join active patterns and assets so trashed/deleted patterns or missing thumbnails never appear.

- [ ] **Step 4: Implement orchestration and replay checks**

The service must validate that the analysis is `completed`, parse its stored result, create/replay the job, and call the matcher outside a database transaction. A replay is legal only for the same analysis, kind, and null direction. Convert matcher empty/no-index states to warnings. If at least one library asset exists, complete; otherwise fail the visual job and throw an `AppError` whose details contain only the validated `jobId`.

Board assembly chooses the latest completed job for `activeJob` and independently returns the newest pending/failed refresh as `refreshJob`. Never erase the active job during refresh.

- [ ] **Step 5: Run state and original-analysis regression tests**

```bash
npm run test:integration -- src/features/inspiration-visuals/visual-service.integration.test.ts src/features/inspiration/analysis-service.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit state transitions**

```bash
git add src/features/inspiration-visuals/visual-repository.ts src/features/inspiration-visuals/visual-service.ts src/features/inspiration-visuals/visual-service.integration.test.ts
git commit -m "feat: orchestrate inspiration visual refresh"
```

---

### Task 5: Expose Authenticated Visual GET and POST Routes

**Files:**
- Create: `src/app/api/inspiration-analyses/[analysisId]/visuals/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/visuals/route.test.ts`
- Create: `src/features/inspiration-visuals/inspiration-visual-api.ts`
- Create: `src/features/inspiration-visuals/query-keys.ts`

**Interfaces:**
- Produces: authenticated GET/POST routes and `inspirationVisualApi.get/create`.
- Consumes: `requireApiUser`, `assertSameOrigin`, `readInspirationMutation`, and service functions.

- [ ] **Step 1: Write failing route tests**

Test unauthenticated access, malformed UUID, invalid/additional JSON fields, cross-origin POST, owner forwarding, `201` for a new job, replay response, and stable JSON error redaction.

- [ ] **Step 2: Run route tests before implementation**

Run: `npm test -- 'src/app/api/inspiration-analyses/[analysisId]/visuals/route.test.ts'`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement Next 16 route handlers**

```ts
export const GET = withRoute<InspirationRouteContext>(async (_request, context) => {
  const user = await requireApiUser();
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context!.params);
  return Response.json(await getInspirationVisualBoard({ ownerId: user.id, analysisId }));
});

export const POST = withRoute<InspirationRouteContext>(async (request, context) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context!.params);
  const mutation = await readInspirationMutation(researchVisualMutationSchema, request);
  return Response.json(await createResearchVisuals({ ownerId: user.id, analysisId, ...mutation }), { status: 201 });
});
```

- [ ] **Step 4: Implement the validated browser client and keys**

Use `/api/inspiration-analyses/${encodeURIComponent(id)}/visuals`; parse every response with `inspirationVisualBoardDtoSchema`. Keys must be `['owner', ownerId, 'inspiration', 'detail', analysisId, 'visuals']` so deleting an analysis can remove the whole detail subtree.

- [ ] **Step 5: Run route and contract tests**

Run: `npm test -- 'src/app/api/inspiration-analyses/[analysisId]/visuals/route.test.ts' src/features/inspiration-visuals/contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the API**

```bash
git add 'src/app/api/inspiration-analyses/[analysisId]/visuals' src/features/inspiration-visuals/inspiration-visual-api.ts src/features/inspiration-visuals/query-keys.ts
git commit -m "feat: expose inspiration visual refresh api"
```

---

### Task 6: Rebuild the Authenticated Workspace as a Visual Intelligence Board

**Files:**
- Create: `src/features/inspiration/inspiration-workspace-header.tsx`
- Create: `src/features/inspiration/inspiration-history-dialog.tsx`
- Create: `src/features/inspiration/inspiration-new-dialog.tsx`
- Create: `src/features/inspiration/inspiration-visual-board.tsx`
- Create: `src/features/inspiration/inspiration-direction-list.tsx`
- Modify: `src/features/inspiration/inspiration-view.tsx`
- Modify: `src/features/inspiration/inspiration-result.tsx`
- Modify: `src/features/inspiration/inspiration.module.css`
- Modify: `src/features/inspiration/inspiration-view.test.tsx`
- Modify: `src/features/inspiration/inspiration-result.test.tsx`

**Interfaces:**
- Produces: desktop-first board, history/new-research dialogs, library mosaic, and visual refresh interaction.
- Consumes: existing analysis API plus `inspirationVisualApi` and visual query keys.

- [ ] **Step 1: Add failing interaction tests**

Test: empty state opens the research form; selected report hides the large permanent form; history opens in a named dialog and closes with Escape; new research returns focus; a newly completed text analysis automatically starts one visual job; completed old reports do not auto-backfill and instead show “补充视觉素材”; pending visual refresh retains old mosaic; library tile has accessible image text and `/library?selected=<id>`; visual failure leaves text headings visible; refresh operation IDs are stable per click and new on retry.

- [ ] **Step 2: Run component tests before refactor**

Run: `npm test -- src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/inspiration-result.test.tsx`

Expected: FAIL on the new interaction assertions.

- [ ] **Step 3: Extract dialogs and compact header**

Use Radix Dialog for history and new-research surfaces. Keep the existing rename/share/delete dialogs. Header controls use Lucide icons with visible labels only for the clear commands “历史” and “新建调研”; icon-only maintenance actions retain tooltips.

- [ ] **Step 4: Add the visual query and refresh mutation**

Enable the visual query only for a selected completed analysis. After the create-analysis mutation returns a newly completed analysis, generate one operation UUID and start its visual POST without blocking text rendering; ordinary history/detail loads must never auto-backfill old reports. On POST success, write the returned board DTO into cache. On failure, invalidate the visual key but do not invalidate or remove the text detail. Poll every five seconds only while `refreshJob.status === 'pending'`.

- [ ] **Step 5: Implement the board layout**

Render in this order: report header, visual summary, headline/summary/confidence, market signals, dimension tabs, direction list, library matches, sources. Library tiles use existing `/api/assets/:id/view` URLs with fixed `aspect-ratio`; link to `/library?selected=...`. Do not render empty image slots or nested cards.

CSS acceptance values:

```css
.report { max-width: 1180px; margin-inline: auto; }
.visualMosaic { display: grid; grid-template-columns: minmax(0, 1.7fr) repeat(2, minmax(160px, .65fr)); gap: 10px; }
.visualTile { min-width: 0; aspect-ratio: 4 / 3; overflow: hidden; border-radius: 6px; }
.visualTile img { width: 100%; height: 100%; object-fit: cover; }
@media (max-width: 900px) { .visualMosaic { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
```

Keep letter spacing `0`; do not scale type with viewport width. At `1280x800`, header plus a visible portion of the next report section must fit without horizontal scrolling.

- [ ] **Step 6: Run component and accessibility tests**

Run: `npm test -- src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/inspiration-result.test.tsx src/features/inspiration/shared-inspiration-page.test.tsx`

Expected: PASS with no duplicate dialog names or missing image alt text.

- [ ] **Step 7: Commit the workspace rebuild**

```bash
git add src/features/inspiration/inspiration-workspace-header.tsx src/features/inspiration/inspiration-history-dialog.tsx src/features/inspiration/inspiration-new-dialog.tsx src/features/inspiration/inspiration-visual-board.tsx src/features/inspiration/inspiration-direction-list.tsx src/features/inspiration/inspiration-view.tsx src/features/inspiration/inspiration-result.tsx src/features/inspiration/inspiration.module.css src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/inspiration-result.test.tsx
git commit -m "feat: rebuild inspiration visual workspace"
```

---

### Task 7: Verify Desktop Quality and Phase-One Release Safety

**Files:**
- Modify: `tests/e2e/ui-shell.spec.ts`
- Modify: `README.md` only if the visual refresh behavior needs operator documentation.

**Interfaces:**
- Produces: screenshot and keyboard regression coverage.
- Consumes: phase-one UI and the existing Playwright fixture stack.

- [ ] **Step 1: Add failing E2E assertions**

Seed one completed report and palette-indexed patterns. Assert no horizontal overflow at `1512x982` and `1280x800`, history/new dialogs restore focus, library links contain `selected`, and disabling image search leaves the complete text report readable without a dead primary button.

- [ ] **Step 2: Run the focused browser test**

Run: `npm run test:e2e -- tests/e2e/ui-shell.spec.ts --project=chromium`

Expected: FAIL until fixture/UI gaps are closed.

- [ ] **Step 3: Fix only phase-one acceptance gaps and rerun all gates**

```bash
npm test -- src/features/inspiration src/features/inspiration-visuals 'src/app/api/inspiration-analyses/[analysisId]/visuals/route.test.ts'
npm run test:integration -- src/lib/db/schema/inspiration-visuals.integration.test.ts src/features/inspiration-visuals/visual-service.integration.test.ts
npm run typecheck
npm run lint
npm run build
npm run test:e2e -- tests/e2e/ui-shell.spec.ts --project=chromium
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Inspect real screenshots**

Start `npm run dev -- --port 3212`; capture `1512x982`, `1280x800`, and `390x844`. Verify image/text overlap, long Chinese titles, the maximum eight library matches, dialog focus, and that no tile changes grid geometry while loading.

- [ ] **Step 5: Commit verification coverage**

```bash
git add tests/e2e/ui-shell.spec.ts README.md
git commit -m "test: verify inspiration visual foundation"
```

---

## Phase-One Acceptance Checklist

- [ ] Existing completed reports render without database migration of their result JSON.
- [ ] An old report can create one idempotent research visual job.
- [ ] Valid report colors match only the current owner's active library patterns.
- [ ] No color guessing, search distance, owner ID, object key, or provider field reaches the browser.
- [ ] A failed/empty visual refresh never hides or mutates the text report.
- [ ] A previous completed mosaic stays visible during a refresh and after a failed refresh.
- [ ] History and new-research surfaces are keyboard accessible and no longer consume permanent report width.
- [ ] The page is stable at `1512x982`, `1280x800`, tablet, and phone sizes.
- [ ] Unit, integration, typecheck, lint, build, and focused E2E commands pass.
