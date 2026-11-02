# Melon Inspiration Concept Sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a designer select one report direction and generate a durable, coordinated design sketch, full-body fashion effect image, and front/back technical flat that continue processing after the browser closes.

**Architecture:** Add a dedicated `inspiration-concepts` domain with additive PostgreSQL tables for sets, references, leased tasks, outputs, and worker heartbeat. Route Handlers create/read/mutate durable state, while a single-concurrency Node.js worker submits and polls Qwen Image 3.0 Pro tasks, imports temporary results into private OSS, and advances the sketch-first dependency graph. Existing inspiration visuals provide validated external references; existing ownership, sharing, and private-resource patterns remain authoritative.

**Tech Stack:** Next.js 16.4.1 Route Handlers, React 19.3, TanStack Query 5, Radix Dialog/Tabs/Checkbox, TypeScript 6, Zod 4, Drizzle/PostgreSQL, Node.js 24, `ali-oss`, `sharp`, Qwen Image 3.0 Pro DashScope async API, Vitest, Playwright, systemd.

**Spec:** `docs/superpowers/specs/2026-11-02-melon-inspiration-concept-sets-design.md`

## Global Constraints

- Read the relevant Next.js 16.4.1 guides under `node_modules/next/dist/docs/` before changing Route Handlers or server behavior; do not rely on older Next.js conventions.
- Execute this plan in an isolated worktree created with `superpowers:using-git-worktrees`; the current `codex/ui-redesign` worktree contains unrelated user changes.
- Use test-driven development for every behavior change: red test, focused green test, then commit.
- Default to `qwen-image-3.0-pro`; output one image per task at `1536*2048` for sketch/effect and `2048*1536` for flat.
- Accept zero to three completed external `web_evidence` references from the current owner/report/active research-visual job. Never use `library_match`, arbitrary URLs, or generated assets as source references.
- Derivative requests contain the master sketch plus at most the first two selected external references because Qwen Image 3.0 accepts at most three input images.
- Every provider create, retry, and set create is idempotent by owner-scoped operation ID. Never automatically resubmit an ambiguous paid request.
- Provider task IDs, request IDs, prompts, brief snapshots, Base64 inputs, temporary result URLs, OSS keys, and owner IDs never enter browser DTOs or ordinary logs.
- Store generated results only in private OSS. Completed outputs remain readable when new generation is disabled.
- Allow one active set and at most three retained non-deleted sets per direction.
- Keep successful sibling outputs visible when one derivative fails. A sketch retry always creates a new set version.
- Do not save generated outputs to the material library in this release.
- Main web readiness must not depend on the concept worker.
- All provider tests are fake/offline by default. A billed real smoke requires an explicit environment flag and creates at most one three-image set.

---

## File Map

### New domain files

- `src/features/inspiration-concepts/contracts.ts`: strict mutations, DTOs, statuses, stable errors, and immutable brief schema.
- `src/features/inspiration-concepts/contracts.test.ts`: public-contract bounds and secrecy tests.
- `src/features/inspiration-concepts/test-fixtures.ts`: reusable set/task/output fixtures.
- `src/features/inspiration-concepts/reference-selector.ts`: deterministic default external-reference ranking.
- `src/features/inspiration-concepts/reference-selector.test.ts`: overlap/role/ordinal/fallback tests.
- `src/features/inspiration-concepts/brief.ts`: server-only brief snapshot builder.
- `src/features/inspiration-concepts/brief.test.ts`: direction authority and field-bound tests.
- `src/features/inspiration-concepts/prompts.ts`: fixed sketch/effect/flat prompt builders.
- `src/features/inspiration-concepts/prompts.test.ts`: stage requirements, ordering, and safety tests.
- `src/features/inspiration-concepts/qwen-image-protocol.ts`: provider request/response schemas and status mapping.
- `src/features/inspiration-concepts/qwen-image-protocol.test.ts`: provider fixtures and malformed-response tests.
- `src/features/inspiration-concepts/qwen-image-provider.ts`: async create/query HTTP adapter.
- `src/features/inspiration-concepts/qwen-image-provider.test.ts`: transport, timeout, status, and redaction tests.
- `src/features/inspiration-concepts/qwen-image-provider.real.test.ts`: opt-in billed smoke.
- `src/features/inspiration-concepts/image-input.ts`: private reference preprocessing to bounded data URLs.
- `src/features/inspiration-concepts/image-input.test.ts`: orientation, dimensions, size, and format tests.
- `src/features/inspiration-concepts/output-importer.ts`: safe temporary-result download, validation, normalization, and private write.
- `src/features/inspiration-concepts/output-importer.test.ts`: importer and compensation tests.
- `src/features/inspiration-concepts/object-keys.ts`: generated-output prefix and key validation.
- `src/features/inspiration-concepts/object-store.ts`: concept-scoped OSS put/get/list/delete adapter.
- `src/features/inspiration-concepts/object-store.test.ts`: scope and retry tests.
- `src/features/inspiration-concepts/repository.ts`: set/task/output queries, transactions, leases, heartbeat, and cleanup claims.
- `src/features/inspiration-concepts/service.ts`: authenticated create/list/retry/regenerate/delete behavior.
- `src/features/inspiration-concepts/service.integration.test.ts`: lifecycle, idempotency, limit, and isolation tests.
- `src/features/inspiration-concepts/worker.ts`: one-step task state machine and durable loop.
- `src/features/inspiration-concepts/worker.integration.test.ts`: lease, crash recovery, dependency, publication, and cleanup tests.
- `src/features/inspiration-concepts/api.ts`: parsed browser client methods.
- `src/features/inspiration-concepts/api.test.ts`: request/response client tests.
- `src/features/inspiration-concepts/query-keys.ts`: owner/report concept-set cache keys.
- `src/features/inspiration-concepts/resource-service.ts`: private/share output authorization and byte responses.
- `src/features/inspiration-concepts/resource-service.integration.test.ts`: owner/share/revocation/download tests.
- `src/features/inspiration-concepts/cleanup.ts`: orphan and soft-deleted object cleanup.
- `src/features/inspiration-concepts/cleanup.integration.test.ts`: cleanup age/scope/survivor tests.

### New schema, routes, scripts, UI, and operations files

- `src/lib/db/schema/inspiration-concepts.ts`: additive concept tables and enums.
- `src/lib/db/schema/inspiration-concepts.integration.test.ts`: database constraints and lease indexes.
- `src/app/api/inspiration-analyses/[analysisId]/concept-sets/route.ts`: list/create.
- `src/app/api/inspiration-analyses/[analysisId]/concept-sets/route.test.ts`: list/create route tests.
- `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/route.ts`: delete.
- `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/route.test.ts`: delete route tests.
- `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/regenerate/route.ts`: new-sketch version creation.
- `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/regenerate/route.test.ts`: regeneration route tests.
- `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/outputs/[outputKind]/retry/route.ts`: derivative retry.
- `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/outputs/[outputKind]/retry/route.test.ts`: retry route tests.
- `src/app/api/inspiration-concept-assets/[assetId]/route.ts`: private preview bytes.
- `src/app/api/inspiration-concept-assets/[assetId]/route.test.ts`: private preview tests.
- `src/app/api/inspiration-concept-assets/[assetId]/download/route.ts`: attachment response.
- `src/app/api/inspiration-concept-assets/[assetId]/download/route.test.ts`: download tests.
- `src/features/inspiration/inspiration-concept-drawer.tsx`: direction brief/reference confirmation UI.
- `src/features/inspiration/inspiration-concept-drawer.test.tsx`: selection and focus tests.
- `src/features/inspiration/inspiration-concept-section.tsx`: set tabs and three output slots.
- `src/features/inspiration/inspiration-concept-section.test.tsx`: progress, retry, delete, and stable-layout tests.
- `src/features/inspiration/inspiration-concept-controller.tsx`: React Query orchestration per direction.
- `src/features/inspiration/inspiration-concept-output-dialog.tsx`: large preview and download action.
- `scripts/run-inspiration-concept-worker.ts`: production worker entrypoint.
- `scripts/run-inspiration-concept-worker.test.ts`: env loading, shutdown, and sanitized failure tests.
- `scripts/cleanup-inspiration-concept-objects.ts`: scheduled cleanup CLI.
- `scripts/cleanup-inspiration-concept-objects.test.ts`: CLI safety tests.
- `scripts/check-inspiration-concept-worker.ts`: sanitized heartbeat and queue-status CLI.
- `scripts/check-inspiration-concept-worker.test.ts`: status CLI safety tests.
- `deploy/systemd/melon-inspiration-concept-worker.service`: durable worker unit.
- `deploy/systemd/melon-inspiration-concept-cleanup.service`: cleanup oneshot.
- `deploy/systemd/melon-inspiration-concept-cleanup.timer`: daily cleanup schedule.
- `tests/e2e/inspiration-concepts-fixtures.ts`: metadata/provider/byte fixtures.
- `tests/e2e/inspiration-concepts.spec.ts`: private, shared, recovery, and visual workflow.

### Existing files modified by the plan

- `.env.example`, `package.json`, `package-lock.json`
- `src/lib/http/app-error.ts`
- `src/lib/env/server.ts`, `src/lib/env/server.test.ts`
- `src/lib/env/production-readiness.ts`, `src/lib/env/production-readiness.test.ts`
- `src/lib/db/schema/index.ts`
- `src/lib/db/schema/inspiration-visuals.ts`, `inspiration-visuals.integration.test.ts`
- generated `drizzle/0012_*.sql`, snapshot, and `drizzle/meta/_journal.json`
- `src/features/inspiration-visuals/contracts.ts`, `contracts.test.ts`
- `src/features/inspiration-visuals/visual-repository.ts`
- `src/features/inspiration-visuals/visual-service.ts`, `visual-service.integration.test.ts`
- `src/features/inspiration-visuals/document-contracts.ts`, `document-composer.ts`, `document-composer.test.ts`
- `src/features/inspiration/inspiration-direction-section.tsx`
- `src/features/inspiration/inspiration-document.tsx`, `inspiration-document.test.tsx`
- `src/features/inspiration/inspiration-view.tsx`, `inspiration-view.test.tsx`
- `src/features/inspiration/share-service.ts`, `share-service.integration.test.ts`
- `src/features/inspiration/shared-inspiration-page.test.tsx`
- `src/features/inspiration/inspiration.module.css`
- `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.ts` and test
- `src/app/api/inspiration-analyses/[analysisId]/route.ts` and route/service deletion tests
- `scripts/check-production.ts`, `scripts/check-production.test.ts`
- `docs/operations/web-production.md`, `README.md`

---

### Task 1: Lock Public Contracts and Production Configuration

**Files:**
- Create: `src/features/inspiration-concepts/contracts.ts`
- Create: `src/features/inspiration-concepts/contracts.test.ts`
- Create: `src/features/inspiration-concepts/test-fixtures.ts`
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`
- Modify: `src/lib/env/production-readiness.ts`
- Modify: `src/lib/env/production-readiness.test.ts`
- Modify: `src/lib/http/app-error.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `conceptSetCreateMutationSchema`, `conceptRetryMutationSchema`, `conceptOutputKindSchema`, `conceptSetDtoSchema`, `publicConceptSetDtoSchema`, `inspirationConceptBriefSchema`, `ConceptSetDto`, `ConceptErrorCode`, and typed concept environment fields.
- Consumes: `publicOperationIdSchema`, `normalizedUuidSchema`, inspiration report schemas, and existing local-path/image-dimension conventions.

- [ ] **Step 1: Write failing contract tests**

Add tests that prove strict mutation parsing, direction `0..4`, zero-to-three unique references, `visualJobId` requirement when references exist, immutable brief bounds, exactly three named output slots, stable errors, local-only image paths, and absence of secret fields.

```ts
const create = {
  operationId: crypto.randomUUID(),
  directionIndex: 0,
  visualJobId: crypto.randomUUID(),
  referenceAssetIds: [crypto.randomUUID(), crypto.randomUUID()],
};
expect(conceptSetCreateMutationSchema.parse(create)).toEqual(create);
expect(conceptSetCreateMutationSchema.safeParse({ ...create, extra: true }).success).toBe(false);
expect(conceptSetCreateMutationSchema.safeParse({ ...create, visualJobId: null }).success).toBe(false);
expect(conceptSetCreateMutationSchema.safeParse({ ...create, referenceAssetIds: [] , visualJobId: null }).success).toBe(true);

const serialized = JSON.stringify(conceptSetDtoSchema.parse(conceptSetFixture));
for (const forbidden of ["ownerId", "objectKey", "providerTaskId", "providerRequestId", "briefSnapshot", "prompt", "temporaryImageUrl"]) {
  expect(serialized).not.toContain(forbidden);
}
```

- [ ] **Step 2: Run the focused tests to verify red**

Run:

```bash
npm test -- src/features/inspiration-concepts/contracts.test.ts src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts
```

Expected: FAIL because the concept contracts and configuration fields do not exist.

- [ ] **Step 3: Implement the strict public schemas**

Define the public input and error surface exactly once:

```ts
export const conceptOutputKindSchema = z.enum(["sketch", "effect", "flat"]);
export const conceptSetStatusSchema = z.enum(["queued", "generating", "partial", "completed", "failed"]);
export const conceptTaskPublicStatusSchema = z.enum(["queued", "generating", "failed"]);

export const conceptSetCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  directionIndex: z.number().int().min(0).max(4),
  visualJobId: normalizedUuidSchema.nullable(),
  referenceAssetIds: z.array(normalizedUuidSchema).max(3),
}).strict().superRefine((value, context) => {
  if (new Set(value.referenceAssetIds).size !== value.referenceAssetIds.length) {
    context.addIssue({ code: "custom", path: ["referenceAssetIds"], message: "duplicate reference" });
  }
  if (value.referenceAssetIds.length > 0 && value.visualJobId === null) {
    context.addIssue({ code: "custom", path: ["visualJobId"], message: "visual job is required" });
  }
});

export const conceptRetryMutationSchema = z.object({
  operationId: publicOperationIdSchema,
}).strict();

export const conceptErrorCodeSchema = z.enum([
  "INSPIRATION_CONCEPT_DISABLED",
  "INSPIRATION_CONCEPT_BUSY",
  "INSPIRATION_CONCEPT_LIMIT_REACHED",
  "INSPIRATION_CONCEPT_REFERENCES_STALE",
  "INSPIRATION_CONCEPT_REFERENCE_INVALID",
  "INSPIRATION_CONCEPT_REJECTED",
  "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
  "INSPIRATION_CONCEPT_TIMEOUT",
  "INSPIRATION_CONCEPT_IMPORT_FAILED",
  "INSPIRATION_CONCEPT_UNAVAILABLE",
]);

export const inspirationConceptBriefSchema = z.object({
  schemaVersion: z.literal("inspiration-concept-brief-v1"),
  report: z.object({
    headline: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(2_000),
    marketSignals: z.array(z.object({
      name: z.string().trim().min(1).max(80),
      rationale: z.string().trim().min(1).max(500),
      strength: z.enum(["high", "medium", "emerging"]),
    }).strict()).max(5),
  }).strict(),
  directionIndex: z.number().int().min(0).max(4),
  direction: inspirationPromptSchema,
  referenceAssetIds: z.array(normalizedUuidSchema).max(3),
  promptTemplateVersion: z.literal("inspiration-concept-prompts-v1"),
  model: z.literal("qwen-image-3.0-pro"),
  sizes: z.object({
    sketch: z.literal("1536*2048"),
    effect: z.literal("1536*2048"),
    flat: z.literal("2048*1536"),
  }).strict(),
}).strict();
```

Represent each slot as `{ kind, asset, task }`; completed task records are not exposed because the durable asset is authoritative:

```ts
export const conceptOutputAssetDtoSchema = z.object({
  id: normalizedUuidSchema,
  kind: conceptOutputKindSchema,
  title: z.string().trim().min(1).max(300),
  altText: z.string().trim().min(1).max(500),
  imageUrl: localPathSchema,
  width: z.number().int().min(1).max(2_048),
  height: z.number().int().min(1).max(2_048),
  createdAt: z.string().datetime(),
}).strict().superRefine((asset, context) => {
  const expected = asset.kind === "flat"
    ? { width: 2_048, height: 1_536 }
    : { width: 1_536, height: 2_048 };
  if (asset.width !== expected.width || asset.height !== expected.height) {
    context.addIssue({ code: "custom", message: "invalid concept output dimensions" });
  }
});

const slotSchema = z.object({
  kind: conceptOutputKindSchema,
  asset: conceptOutputAssetDtoSchema.nullable(),
  task: z.object({
    status: conceptTaskPublicStatusSchema,
    errorCode: conceptErrorCodeSchema.nullable(),
  }).strict().nullable(),
}).strict();

const conceptSetDtoBase = z.object({
  id: normalizedUuidSchema,
  directionIndex: z.number().int().min(0).max(4),
  version: z.number().int().min(1).max(2_147_483_647),
  status: conceptSetStatusSchema,
  slots: z.tuple([slotSchema, slotSchema, slotSchema]),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();

export const conceptSetDtoSchema = conceptSetDtoBase.superRefine(assertSlotOrderAndState);

function assertSlotOrderAndState(value: z.infer<typeof conceptSetDtoBase>, context: z.RefinementCtx) {
  const expected = ["sketch", "effect", "flat"] as const;
  value.slots.forEach((slot, index) => {
    if (slot.kind !== expected[index] || (slot.asset && slot.asset.kind !== slot.kind)) {
      context.addIssue({ code: "custom", path: ["slots", index], message: "invalid slot order" });
    }
  });
  const active = value.slots.some(({ task }) => task?.status === "queued" || task?.status === "generating");
  if ((value.status === "queued" || value.status === "generating") !== active) {
    context.addIssue({ code: "custom", path: ["status"], message: "invalid active set status" });
  }
}
```

Define the public projection explicitly; it contains only completed outputs and omits task state and errors:

```ts
export const publicConceptSetDtoSchema = z.object({
  id: normalizedUuidSchema,
  directionIndex: z.number().int().min(0).max(4),
  version: z.number().int().min(1).max(2_147_483_647),
  outputs: z.array(conceptOutputAssetDtoSchema).min(1).max(3),
  createdAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (new Set(value.outputs.map(({ kind }) => kind)).size !== value.outputs.length) {
    context.addIssue({ code: "custom", path: ["outputs"], message: "duplicate output kind" });
  }
});
```

Export `ConceptSetCreateMutation`, `ConceptRetryMutation`, `ConceptOutputKind`, `ConceptOutputAssetDto`, `ConceptSetDto`, `PublicConceptSetDto`, `InspirationConceptBrief`, and `ConceptErrorCode` from their schemas.

- [ ] **Step 4: Add concept environment parsing and production gates**

Extend `serverEnvSchema` with:

```ts
INSPIRATION_CONCEPT_IMAGES_ENABLED: optionalBoolean,
INSPIRATION_CONCEPT_RELEASE_APPROVED: optionalBoolean,
INSPIRATION_IMAGE_MODEL: z.enum(["qwen-image-3.0-pro"]).default("qwen-image-3.0-pro"),
INSPIRATION_CONCEPT_WORKER_ID: z.preprocess(
  blankToUndefined,
  z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/).default("concept-worker-1"),
),
```

When concept images are enabled, require `INSPIRATION_ENABLED`, the existing DashScope API key/workspace/native base URL, model `qwen-image-3.0-pro`, real OSS, and production release approval through `INSPIRATION_CONCEPT_RELEASE_APPROVED`. Add readiness error `INSPIRATION_CONCEPT_RELEASE_NOT_APPROVED`; invalid model strings fail environment parsing before readiness runs. Disabled mode must accept blank provider fields exactly as current inspiration-disabled tests do.

Extend `AppErrorCode` with the four new service codes not already present:

```ts
| "INSPIRATION_CONCEPT_REFERENCES_STALE"
| "INSPIRATION_CONCEPT_REFERENCE_INVALID"
| "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN"
| "INSPIRATION_CONCEPT_IMPORT_FAILED"
```

- [ ] **Step 5: Run focused tests to verify green**

Run:

```bash
npm test -- src/features/inspiration-concepts/contracts.test.ts src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts
npm run typecheck
```

Expected: PASS; browser DTO serialization contains none of the forbidden server fields.

- [ ] **Step 6: Commit contracts and configuration**

```bash
git add .env.example src/features/inspiration-concepts/contracts.ts src/features/inspiration-concepts/contracts.test.ts src/features/inspiration-concepts/test-fixtures.ts src/lib/env/server.ts src/lib/env/server.test.ts src/lib/env/production-readiness.ts src/lib/env/production-readiness.test.ts src/lib/http/app-error.ts
git commit -m "feat: define inspiration concept set contracts"
```

---

### Task 2: Add the Durable Concept Schema and Queue Repository

**Files:**
- Create: `src/lib/db/schema/inspiration-concepts.ts`
- Create: `src/lib/db/schema/inspiration-concepts.integration.test.ts`
- Create: `src/features/inspiration-concepts/repository.ts`
- Modify: `src/lib/db/schema/index.ts`
- Modify: `src/lib/db/schema/inspiration-visuals.ts`
- Modify: `src/lib/db/schema/inspiration-visuals.integration.test.ts`
- Generate: `drizzle/0012_melon_inspiration_concept_sets.sql`
- Generate: `drizzle/meta/0012_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Produces: Drizzle tables/enums, `createSetAndSketchTask`, `listSetsForAnalysis`, `findSetByOperation`, `createDerivativeRetry`, `claimNextTask`, `markTaskSubmitted`, `rescheduleTask`, `publishTaskOutput`, `failTask`, `claimDeletingSet`, `recordWorkerHeartbeat`, and row types.
- Consumes: Task 1 schemas/types, `inspirationAnalyses`, `inspirationVisualAssets`, and the shared `db` client.

- [ ] **Step 1: Write failing schema integration tests**

Test database enforcement, not only application behavior:

```ts
it("rejects a fourth retained set and concurrent active sets in service transactions", async () => {
  await seedCompletedAnalysis();
  await insertSet({ directionIndex: 0, version: 1, status: "completed" });
  await insertSet({ directionIndex: 0, version: 2, status: "completed" });
  await insertSet({ directionIndex: 0, version: 3, status: "completed" });
  await expect(createSetAndSketchTask(input)).rejects.toMatchObject({
    code: "INSPIRATION_CONCEPT_LIMIT_REACHED",
  });
});

it("claims one due task with a lease", async () => {
  const first = await claimNextTask({ workerId: "worker-a", now, leaseUntil });
  const second = await claimNextTask({ workerId: "worker-b", now, leaseUntil });
  expect(first?.id).toBe(taskId);
  expect(second).toBeUndefined();
});
```

Also cover owner/analysis/reference composite foreign keys, reference ordinals `0..2`, output kinds, task attempt uniqueness, active-task uniqueness, terminal state checks, expired leases, output replacement, deleting-set claims, and heartbeat upsert.

- [ ] **Step 2: Run the integration test to verify red**

Run:

```bash
npm run test:integration -- src/lib/db/schema/inspiration-concepts.integration.test.ts
```

Expected: FAIL because the schema and repository do not exist.

- [ ] **Step 3: Implement additive tables and tenant-safe keys**

Define enums and tables in `inspiration-concepts.ts`:

```ts
export const conceptOutputKinds = ["sketch", "effect", "flat"] as const;
export const conceptSetStatuses = ["queued", "generating", "partial", "completed", "failed", "deleting"] as const;
export const conceptTaskStatuses = ["queued", "submitting", "submitted", "completed", "failed"] as const;

export const inspirationConceptSets = pgTable("inspiration_concept_sets", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  analysisId: uuid("analysis_id").notNull(),
  operationId: uuid("operation_id").notNull(),
  directionIndex: integer("direction_index").notNull(),
  version: integer("version").notNull(),
  status: inspirationConceptSetStatusEnum("status").notNull(),
  briefSnapshot: jsonb("brief_snapshot").$type<InspirationConceptBrief>().notNull(),
  promptTemplateVersion: text("prompt_template_version").notNull(),
  model: text("model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("inspiration_concept_sets_owner_operation_unique").on(table.ownerId, table.operationId),
  unique("inspiration_concept_sets_analysis_direction_version_unique").on(table.analysisId, table.directionIndex, table.version),
  unique("inspiration_concept_sets_owner_id_unique").on(table.ownerId, table.id),
  unique("inspiration_concept_sets_owner_analysis_id_unique").on(table.ownerId, table.analysisId, table.id),
  uniqueIndex("inspiration_concept_sets_active_direction_unique")
    .on(table.analysisId, table.directionIndex)
    .where(sql`${table.status} in ('queued', 'generating') and ${table.deletedAt} is null`),
  check("inspiration_concept_sets_direction_check", sql`${table.directionIndex} between 0 and 4`),
  check("inspiration_concept_sets_version_check", sql`${table.version} >= 1`),
  check("inspiration_concept_sets_brief_check", sql`jsonb_typeof(${table.briefSnapshot}) = 'object'`),
]);

export const inspirationConceptReferences = pgTable("inspiration_concept_references", {
  ownerId: uuid("owner_id").notNull(),
  analysisId: uuid("analysis_id").notNull(),
  setId: uuid("set_id").notNull(),
  visualAssetId: uuid("visual_asset_id").notNull(),
  ordinal: integer("ordinal").notNull(),
}, (table) => [
  primaryKey({ columns: [table.setId, table.ordinal] }),
  unique("inspiration_concept_references_set_asset_unique").on(table.setId, table.visualAssetId),
  foreignKey({ columns: [table.ownerId, table.analysisId, table.setId], foreignColumns: [inspirationConceptSets.ownerId, inspirationConceptSets.analysisId, inspirationConceptSets.id] }).onDelete("cascade"),
  foreignKey({ columns: [table.ownerId, table.analysisId, table.visualAssetId], foreignColumns: [inspirationVisualAssets.ownerId, inspirationVisualAssets.analysisId, inspirationVisualAssets.id] }).onDelete("restrict"),
  check("inspiration_concept_references_ordinal_check", sql`${table.ordinal} between 0 and 2`),
]);

export const inspirationConceptTasks = pgTable("inspiration_concept_tasks", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  setId: uuid("set_id").notNull(),
  operationId: uuid("operation_id").notNull(),
  outputKind: inspirationConceptOutputKindEnum("output_kind").notNull(),
  attempt: integer("attempt").notNull(),
  status: inspirationConceptTaskStatusEnum("status").notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  providerTaskId: text("provider_task_id"),
  providerRequestId: text("provider_request_id"),
  errorCode: text("error_code"),
  submitStartedAt: timestamp("submit_started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, conceptTaskConstraints);

export const inspirationConceptOutputs = pgTable("inspiration_concept_outputs", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  analysisId: uuid("analysis_id").notNull(),
  setId: uuid("set_id").notNull(),
  sourceTaskId: uuid("source_task_id").notNull(),
  outputKind: inspirationConceptOutputKindEnum("output_kind").notNull(),
  title: text("title").notNull(),
  altText: text("alt_text").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, conceptOutputConstraints);

export const inspirationConceptWorkerHeartbeats = pgTable("inspiration_concept_worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
```

Define `conceptTaskConstraints` in the same file with unique `(owner_id, operation_id)`, unique `(set_id, output_kind, attempt)`, unique `(owner_id, set_id, id)`, a composite `(owner_id, set_id)` foreign key, one partial unique index for statuses `queued`, `submitting`, or `submitted`, attempt/status/lease/provider-length checks, and a due-task index on `(status, available_at, lease_until)`. Define `conceptOutputConstraints` with composite `(owner_id, analysis_id, set_id)` and `(owner_id, set_id, source_task_id)` foreign keys, unique `(set_id, output_kind)`, display/storage/dimension checks, `content_type = 'image/png'`, and exact dimensions by kind. Add set-status/completion/deletion checks and add `unique(ownerId, analysisId, id)` to `inspiration_visual_assets` so the reference relation can use a composite foreign key. The migration is additive; do not delete or rewrite existing `concept_image` jobs or `generated_concept` assets.

- [ ] **Step 4: Implement short transactional repository primitives**

Keep provider and OSS I/O out of repository transactions. Use explicit compare-and-set transitions:

```ts
export async function claimNextTask(input: ClaimInput) {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(inspirationConceptTasks)
      .where(and(
        inArray(inspirationConceptTasks.status, ["queued", "submitted"]),
        lte(inspirationConceptTasks.availableAt, input.now),
        or(isNull(inspirationConceptTasks.leaseUntil), lt(inspirationConceptTasks.leaseUntil, input.now)),
      ))
      .orderBy(asc(inspirationConceptTasks.availableAt), asc(inspirationConceptTasks.createdAt), asc(inspirationConceptTasks.id))
      .limit(1).for("update", { skipLocked: true });
    if (!candidate) return undefined;
    const [claimed] = await tx.update(inspirationConceptTasks).set({
      leaseOwner: input.workerId,
      leaseUntil: input.leaseUntil,
      updatedAt: input.now,
    }).where(eq(inspirationConceptTasks.id, candidate.id)).returning();
    return claimed;
  });
}
```

`publishTaskOutput` must lock the task/set, upsert one current output per kind, return any superseded object key for compensation, mark the task completed, enqueue missing derivative tasks when `outputKind === "sketch"`, and derive the set status in one transaction.

`createSetAndSketchTask` must serialize version allocation even when a direction has no existing rows. Acquire the same transaction-scoped PostgreSQL advisory lock derived from validated `analysisId` that research-visual completion uses, then count non-deleted sets for the direction, reject count three, reject an active set, allocate `coalesce(max(version), 0) + 1`, and insert the set/references/sketch task. Map the active/version unique constraints to stable busy/limit errors after rereading the winning rows. The shared analysis lock ensures a visual refresh cannot retire source evidence between active-job validation and reference insertion.

- [ ] **Step 5: Generate and inspect the migration**

Run:

```bash
npm run db:generate -- --name melon_inspiration_concept_sets
```

Inspect `drizzle/0012_melon_inspiration_concept_sets.sql` and assert in the schema test that the journal references it. Verify the SQL includes composite foreign keys, partial active indexes, JSON object checks, task state checks, and no destructive statement against existing inspiration data.

- [ ] **Step 6: Run schema/repository tests to verify green**

Run:

```bash
npm run test:integration -- src/lib/db/schema/inspiration-concepts.integration.test.ts src/lib/db/schema/inspiration-visuals.integration.test.ts
npm run typecheck
```

Expected: PASS, including two concurrent claimers and tenant-isolation constraints.

- [ ] **Step 7: Commit schema and queue foundation**

```bash
git add src/lib/db/schema/inspiration-concepts.ts src/lib/db/schema/inspiration-concepts.integration.test.ts src/lib/db/schema/inspiration-visuals.ts src/lib/db/schema/inspiration-visuals.integration.test.ts src/lib/db/schema/index.ts src/features/inspiration-concepts/repository.ts drizzle/0012_melon_inspiration_concept_sets.sql drizzle/meta/0012_snapshot.json drizzle/meta/_journal.json
git commit -m "feat: add durable inspiration concept queue"
```

---

### Task 3: Build Reference Ranking, Frozen Briefs, and Stage Prompts

**Files:**
- Create: `src/features/inspiration-concepts/reference-selector.ts`
- Create: `src/features/inspiration-concepts/reference-selector.test.ts`
- Create: `src/features/inspiration-concepts/brief.ts`
- Create: `src/features/inspiration-concepts/brief.test.ts`
- Create: `src/features/inspiration-concepts/prompts.ts`
- Create: `src/features/inspiration-concepts/prompts.test.ts`

**Interfaces:**
- Produces: `selectDefaultConceptReferences`, `buildInspirationConceptBrief`, `buildSketchPrompt`, `buildEffectPrompt`, and `buildFlatPrompt`.
- Consumes: Task 1 contracts, `InspirationAnalysisResult`, `WebEvidenceAssetDto`, and validated selected direction indexes.

- [ ] **Step 1: Write failing reference and brief tests**

Cover source overlap before role, product before evidence for equal overlap, ordinal/ID stable ties, report-level fallback, unique maximum three, no mutation, selected-direction authority, NFC normalization, deterministic bounds, and omission of URLs/private fields.

```ts
expect(selectDefaultConceptReferences({
  direction: result.inspirationPrompts[0]!,
  assets: [fallbackHero, overlappingEvidence, overlappingProduct, duplicateProduct],
}).map(({ id }) => id)).toEqual([
  overlappingProduct.id,
  overlappingEvidence.id,
  fallbackHero.id,
]);

const brief = buildInspirationConceptBrief({ result, directionIndex: 0, referenceAssetIds });
expect(brief).toMatchObject({
  schemaVersion: "inspiration-concept-brief-v1",
  directionIndex: 0,
  direction: result.inspirationPrompts[0],
  model: "qwen-image-3.0-pro",
});
expect(JSON.stringify(brief)).not.toMatch(/https?:|objectKey|ownerId|provider/i);
```

- [ ] **Step 2: Write failing prompt tests**

Assert stable ordering, a fixed `MAX_PROMPT_CODE_POINTS = 3_600` conservative bound below the provider's recommended 4,500-token ceiling, all direction fields, report context subordinate to the direction, explicit reference roles, and stage-specific output rules.

```ts
const sketch = buildSketchPrompt(brief);
expect(sketch).toContain("1536x2048");
expect(sketch).toContain("原创服装设计草图");
expect(sketch).toContain(brief.direction.silhouette);

const effect = buildEffectPrompt(brief);
expect(effect).toContain("图1是已完成的主设计草图");
expect(effect).toContain("数字模特全身棚拍");

const flat = buildFlatPrompt(brief);
expect(flat).toContain("正面与背面并列");
expect(flat).toContain("不要模特、场景、文字、尺寸标注");
```

- [ ] **Step 3: Run focused tests to verify red**

Run:

```bash
npm test -- src/features/inspiration-concepts/reference-selector.test.ts src/features/inspiration-concepts/brief.test.ts src/features/inspiration-concepts/prompts.test.ts
```

Expected: FAIL because the pure builders do not exist.

- [ ] **Step 4: Implement deterministic ranking and immutable brief creation**

Use score tuples rather than an unstable weighted sum:

```ts
const rank = (asset: WebEvidenceAssetDto, sources: Set<number>) => [
  asset.sourceIndexes.some((index) => sources.has(index)) ? 0 : 1,
  asset.role === "product" ? 0 : asset.role === "evidence" ? 1 : 2,
  asset.ordinal,
  asset.id,
] as const;
```

The brief builder parses the report result, validates `directionIndex < inspirationPrompts.length`, copies bounded report context and the exact selected direction, stores only reference IDs, and returns a deep-frozen value parsed by `inspirationConceptBriefSchema`.

- [ ] **Step 5: Implement three independent fixed prompt builders**

Use one shared sanitized brief formatter and three explicit templates. Do not build derivative prompts by string replacement over the sketch prompt. Export:

```ts
export function buildSketchPrompt(brief: InspirationConceptBrief): string;
export function buildEffectPrompt(brief: InspirationConceptBrief): string;
export function buildFlatPrompt(brief: InspirationConceptBrief): string;
```

Each builder performs Unicode-safe truncation after required fixed clauses are reserved. The fixed clauses include originality, no brand/logo/watermark, no recognizable public figure, no UI, and no claim that the output is market evidence.

- [ ] **Step 6: Run focused tests to verify green**

Run:

```bash
npm test -- src/features/inspiration-concepts/reference-selector.test.ts src/features/inspiration-concepts/brief.test.ts src/features/inspiration-concepts/prompts.test.ts
npm run typecheck
```

Expected: PASS with deterministic snapshots across repeated calls.

- [ ] **Step 7: Commit pure concept planning logic**

```bash
git add src/features/inspiration-concepts/reference-selector.ts src/features/inspiration-concepts/reference-selector.test.ts src/features/inspiration-concepts/brief.ts src/features/inspiration-concepts/brief.test.ts src/features/inspiration-concepts/prompts.ts src/features/inspiration-concepts/prompts.test.ts
git commit -m "feat: build coordinated concept prompts"
```

---

### Task 4: Implement the Qwen Image Adapter and Safe Image Pipeline

**Files:**
- Create: `src/features/inspiration-concepts/qwen-image-protocol.ts`
- Create: `src/features/inspiration-concepts/qwen-image-protocol.test.ts`
- Create: `src/features/inspiration-concepts/qwen-image-provider.ts`
- Create: `src/features/inspiration-concepts/qwen-image-provider.test.ts`
- Create: `src/features/inspiration-concepts/image-input.ts`
- Create: `src/features/inspiration-concepts/image-input.test.ts`
- Create: `src/features/inspiration-concepts/output-importer.ts`
- Create: `src/features/inspiration-concepts/output-importer.test.ts`
- Create: `src/features/inspiration-concepts/object-keys.ts`
- Create: `src/features/inspiration-concepts/object-store.ts`
- Create: `src/features/inspiration-concepts/object-store.test.ts`
- Modify: `src/features/inspiration-visuals/safe-image-fetch.ts`
- Modify: `src/features/inspiration-visuals/safe-image-fetch.test.ts`
- Modify: `src/features/inspiration-visuals/image-sniffer.ts`
- Modify: `src/features/inspiration-visuals/image-sniffer.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `QwenImageProvider.createTask`, `QwenImageProvider.queryTask`, `prepareConceptInput`, `importConceptOutput`, `conceptOutputObjectKey`, and `ConceptObjectStore`.
- Consumes: Task 3 prompts, server provider config, existing remote-address checks, private OSS credentials, and Task 1 output kinds.

- [ ] **Step 1: Write failing protocol and provider tests**

Use captured fixtures matching the official DashScope async create/query shapes. Cover create pending, query pending/running/succeeded/rejected/failed/canceled/unknown, mismatched task IDs, empty/multiple outputs, malformed or oversized JSON, HTTP failure, caller abort, timeout, and redaction.

```ts
expect(buildQwenImageRequest({
  kind: "sketch",
  prompt: "prompt",
  images: ["data:image/webp;base64,AAAA"],
})).toEqual({
  model: "qwen-image-3.0-pro",
  input: { messages: [{ role: "user", content: [
    { image: "data:image/webp;base64,AAAA" },
    { text: "prompt" },
  ] }] },
  parameters: {
    n: 1,
    size: "1536*2048",
    prompt_extend: true,
    watermark: false,
    negative_prompt: expect.any(String),
  },
});

await expect(provider.createTask(input)).rejects.toMatchObject({
  code: "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
  definitelyNotAccepted: false,
});
expect(JSON.stringify(caught)).not.toMatch(/sk-|data:image|TemporarySignature|private-result/i);
```

- [ ] **Step 2: Write failing image and object-store tests**

Cover PNG/JPEG/WebP/GIF first-frame inputs, EXIF rotation, 2048-pixel bounding, ten-megabyte provider input ceiling, invalid bytes, decompression/pixel limit, exact output dimensions, concept-key scope, OSS credential refresh, list pagination, delete batching, and write-then-database-failure compensation.

```ts
const prepared = await prepareConceptInput({
  bytes: rotatedJpeg,
  contentType: "image/jpeg",
});
expect(prepared).toMatch(/^data:image\/webp;base64,/);
const decoded = Buffer.from(prepared.split(",", 2)[1]!, "base64");
expect(await sharp(decoded).metadata()).toMatchObject({ width: 1200, height: 800 });

expect(conceptOutputObjectKey({ ownerId, analysisId, setId, outputKind: "flat", outputId }))
  .toBe(`users/${ownerId}/inspiration/${analysisId}/concept-sets/${setId}/flat/${outputId}.png`);
```

- [ ] **Step 3: Run the focused tests to verify red**

Run:

```bash
npm test -- src/features/inspiration-concepts/qwen-image-protocol.test.ts src/features/inspiration-concepts/qwen-image-provider.test.ts src/features/inspiration-concepts/image-input.test.ts src/features/inspiration-concepts/output-importer.test.ts src/features/inspiration-concepts/object-store.test.ts
```

Expected: FAIL because the provider and image pipeline do not exist; `sharp` is not a declared direct dependency.

- [ ] **Step 4: Install the declared image processor**

Run:

```bash
npm install sharp
```

Expected: `sharp` appears in `dependencies`, and the lockfile records the platform packages without unrelated dependency upgrades.

- [ ] **Step 5: Implement strict protocol parsing and transport**

Expose a provider-only union; temporary URLs cannot satisfy any public schema:

```ts
export type QwenImageTaskState =
  | { state: "pending"; taskId: string; requestId: string }
  | { state: "succeeded"; taskId: string; requestId: string; temporaryImageUrl: string }
  | { state: "rejected"; taskId: string; requestId: string }
  | { state: "failed"; taskId: string; requestId: string };

export interface QwenImageProvider {
  createTask(input: {
    kind: ConceptOutputKind;
    prompt: string;
    images: readonly string[];
    signal: AbortSignal;
  }): Promise<{ taskId: string; requestId: string }>;
  queryTask(input: { taskId: string; signal: AbortSignal }): Promise<QwenImageTaskState>;
}
```

Create uses `${nativeBaseUrl}/services/aigc/image-generation/generation`, `Authorization`, JSON content type, and `X-DashScope-Async: enable`. Query uses `${nativeBaseUrl}/tasks/${encodeURIComponent(taskId)}`. Both use `cache: "no-store"`, `redirect: "error"`, bounded JSON, and explicit deadlines. Non-2xx responses are never parsed into public details.

Classify a validated provider rejection before task creation as `definitelyNotAccepted: true`. Network abort, timeout, or malformed success after request transmission is `definitelyNotAccepted: false`; the worker must treat it as an ambiguous paid submission.

- [ ] **Step 6: Implement bounded image preparation and output import**

Refactor `fetchRemoteImage` and `sniffImage` to accept internal limit objects while preserving their existing defaults. Concept output import uses a 16 MiB byte cap and 40 MP decoded-pixel cap, requires provider PNG, and checks the exact expected dimensions before durable publication.

Reference inputs use:

```ts
const bytes = await sharp(source, { animated: false, limitInputPixels: 40_000_000 })
  .rotate()
  .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
  .webp({ quality: 90, effort: 4 })
  .toBuffer();
if (bytes.byteLength > 10 * 1024 * 1024) throw conceptUnavailable();
return `data:image/webp;base64,${bytes.toString("base64")}`;
```

`importConceptOutput` downloads through the safe fetcher, validates and normalizes to PNG, writes one concept-scoped key, and returns `{ asset, writtenKey }`. It deletes `writtenKey` before rethrowing if any post-write validation fails.

- [ ] **Step 7: Run provider and image regression tests to verify green**

Run:

```bash
npm test -- src/features/inspiration-concepts/qwen-image-protocol.test.ts src/features/inspiration-concepts/qwen-image-provider.test.ts src/features/inspiration-concepts/image-input.test.ts src/features/inspiration-concepts/output-importer.test.ts src/features/inspiration-concepts/object-store.test.ts src/features/inspiration-visuals/safe-image-fetch.test.ts src/features/inspiration-visuals/image-sniffer.test.ts
npm run typecheck
```

Expected: PASS; tests make no network or OSS calls.

- [ ] **Step 8: Commit provider and safe image pipeline**

```bash
git add package.json package-lock.json src/features/inspiration-concepts/qwen-image-protocol.ts src/features/inspiration-concepts/qwen-image-protocol.test.ts src/features/inspiration-concepts/qwen-image-provider.ts src/features/inspiration-concepts/qwen-image-provider.test.ts src/features/inspiration-concepts/image-input.ts src/features/inspiration-concepts/image-input.test.ts src/features/inspiration-concepts/output-importer.ts src/features/inspiration-concepts/output-importer.test.ts src/features/inspiration-concepts/object-keys.ts src/features/inspiration-concepts/object-store.ts src/features/inspiration-concepts/object-store.test.ts src/features/inspiration-visuals/safe-image-fetch.ts src/features/inspiration-visuals/safe-image-fetch.test.ts src/features/inspiration-visuals/image-sniffer.ts src/features/inspiration-visuals/image-sniffer.test.ts
git commit -m "feat: add qwen concept image pipeline"
```

---

### Task 5: Implement Concept Set Lifecycle Services

**Files:**
- Create: `src/features/inspiration-concepts/service.ts`
- Create: `src/features/inspiration-concepts/service.integration.test.ts`
- Modify: `src/features/inspiration-concepts/repository.ts`
- Modify: `src/features/inspiration-visuals/visual-repository.ts`

**Interfaces:**
- Produces: `createConceptSet`, `listConceptSets`, `retryConceptDerivative`, `regenerateConceptSet`, `deleteConceptSet`, and `toConceptSetDto`.
- Consumes: Tasks 1-3 contracts/brief/reference ranking, Task 2 repository primitives, owned completed analyses, and active research-visual assets.

- [ ] **Step 1: Write failing lifecycle integration tests**

Cover feature disabled, incomplete report, invalid direction, empty references, stale visual job, non-web/library/other-owner references, operation replay/mismatch, active-set conflict, three-version limit, concurrent creates, listing order, derivative retry with/without current output, sketch retry rejection, regenerate copying references into a new version, soft delete, cross-owner 404, and DTO secrecy.

```ts
const created = await createConceptSet({
  ownerId,
  analysisId,
  operationId,
  directionIndex: 0,
  visualJobId,
  referenceAssetIds: [productAssetId, evidenceAssetId],
});
expect(created).toMatchObject({ directionIndex: 0, version: 1, status: "queued" });
expect(created.slots.map(({ kind }) => kind)).toEqual(["sketch", "effect", "flat"]);

await expect(createConceptSet({ ...input, ownerId: otherOwnerId }))
  .rejects.toMatchObject({ code: "INSPIRATION_NOT_FOUND", status: 404 });
```

- [ ] **Step 2: Run the service integration test to verify red**

Run:

```bash
npm run test:integration -- src/features/inspiration-concepts/service.integration.test.ts
```

Expected: FAIL because lifecycle services do not exist.

- [ ] **Step 3: Implement create and list without provider I/O**

`createConceptSet` must:

1. parse all input;
2. require an owned completed analysis;
3. validate the direction against `result.inspirationPrompts.length`;
4. require the supplied visual job to equal `findLatestCompletedResearchJob` when references exist;
5. inside the shared analysis-locked transaction, reload every selected asset in request order and require owned completed `web_evidence` rows from that still-active visual job;
6. build the frozen brief;
7. call `createSetAndSketchTask` in one short transaction;
8. return the queued DTO immediately.

Use operation replay before expensive validation only after confirming the replayed set belongs to the requested analysis and identical mutation target. A reused operation ID with different analysis, direction, visual job, or references returns `OPERATION_ID_REUSED`.

`listConceptSets` returns direction ascending, version descending, and exactly three ordered slots per set. It derives set state from current outputs and current non-terminal/latest-failed tasks rather than trusting stale client state.

- [ ] **Step 4: Implement retries, regeneration, and deletion**

```ts
export async function retryConceptDerivative(input: {
  ownerId: string;
  analysisId: string;
  setId: string;
  outputKind: "effect" | "flat";
  operationId: string;
}): Promise<ConceptSetDto>;

export async function regenerateConceptSet(input: {
  ownerId: string;
  analysisId: string;
  setId: string;
  operationId: string;
}): Promise<ConceptSetDto>;
```

Retry creates one queued task and leaves any current asset untouched. Regenerate calls the same internal create transaction with copied direction/reference identities and a fresh brief snapshot/model/template version. Delete marks the set `deleting`, sets `deletedAt`, cancels only locally queued tasks, and returns `{ id, deleted: true }`; the worker performs external object cleanup.

- [ ] **Step 5: Run lifecycle and visual-repository regression tests**

Run:

```bash
npm run test:integration -- src/features/inspiration-concepts/service.integration.test.ts src/features/inspiration-visuals/visual-service.integration.test.ts
npm test -- src/features/inspiration-visuals/visual-service.test.ts
npm run typecheck
```

Expected: PASS; no service test calls the provider.

- [ ] **Step 6: Commit lifecycle services**

```bash
git add src/features/inspiration-concepts/service.ts src/features/inspiration-concepts/service.integration.test.ts src/features/inspiration-concepts/repository.ts src/features/inspiration-visuals/visual-repository.ts
git commit -m "feat: manage inspiration concept sets"
```

---

### Task 6: Build the Durable Concept Worker and systemd Unit

**Files:**
- Create: `src/features/inspiration-concepts/worker.ts`
- Create: `src/features/inspiration-concepts/worker.integration.test.ts`
- Create: `scripts/run-inspiration-concept-worker.ts`
- Create: `scripts/run-inspiration-concept-worker.test.ts`
- Create: `deploy/systemd/melon-inspiration-concept-worker.service`
- Modify: `src/features/inspiration-concepts/repository.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `advanceConceptWorkerOnce`, `runConceptWorker`, worker CLI, heartbeat, crash recovery, derivative scheduling, and soft-delete cleanup.
- Consumes: Tasks 2-4 repository/provider/prompts/image pipeline and Task 5 set semantics.

- [ ] **Step 1: Write failing worker integration tests**

Cover single-claim concurrency, queued submission, provider pending backoff, provider rejection, safe HTTP non-acceptance, ambiguous create timeout, crash in `submitting`, submitted-task lease recovery, 30-minute timeout, sketch import and exactly two derivative tasks, effect/flat input order, parallel provider-side submissions, output replacement, losing publication cleanup, partial/completed/failed derivation, SIGTERM stop, heartbeat, and deleting-set object cleanup.

```ts
const first = advanceConceptWorkerOnce(dependencies("worker-a"));
const second = advanceConceptWorkerOnce(dependencies("worker-b"));
const outcomes = await Promise.all([first, second]);
expect(outcomes.filter(({ state }) => state === "advanced")).toHaveLength(1);
expect(provider.createTask).toHaveBeenCalledTimes(1);

provider.queryTask.mockResolvedValue({
  state: "succeeded",
  taskId: providerTaskId,
  requestId: providerRequestId,
  temporaryImageUrl: "https://dashscope-result.example.test/result.png?Expires=1",
});
await advanceConceptWorkerOnce(dependencies("worker-a"));
expect(await listTasks(setId)).toMatchObject([
  { outputKind: "sketch", status: "completed" },
  { outputKind: "effect", status: "queued" },
  { outputKind: "flat", status: "queued" },
]);
```

- [ ] **Step 2: Run worker tests to verify red**

Run:

```bash
npm run test:integration -- src/features/inspiration-concepts/worker.integration.test.ts
npm test -- scripts/run-inspiration-concept-worker.test.ts
```

Expected: FAIL because the worker engine and entrypoint do not exist.

- [ ] **Step 3: Implement one bounded state transition per claim**

```ts
export async function advanceConceptWorkerOnce(deps: WorkerDependencies) {
  await deps.repository.failExpiredSubmittingTasks(deps.now());
  const deleting = await deps.repository.claimDeletingSet(deps.workerId, deps.now(), deps.leaseUntil());
  if (deleting) return cleanupDeletingSet(deleting, deps);
  const task = await deps.repository.claimNextTask({
    workerId: deps.workerId,
    now: deps.now(),
    leaseUntil: deps.leaseUntil(),
  });
  if (!task) return { state: "idle" as const };
  return task.status === "queued"
    ? submitTask(task, deps)
    : pollTask(task, deps);
}
```

Before create, transition queued to `submitting` and commit. A provider error with `definitelyNotAccepted: true` may fail with rejected/unavailable. Any uncertain create failure, or an expired `submitting` lease without stored provider ID, becomes `INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN` and is never automatically resubmitted.

For `submitted` tasks, map pending to a bounded jittered `availableAt`, terminal failures to stable errors, and success to `importConceptOutput` followed by `publishTaskOutput`. Delete a just-written key when publication loses a race or throws.

- [ ] **Step 4: Build exact stage inputs**

For sketch, load zero to three ordered reference objects and call `buildSketchPrompt`. For derivatives, require the current sketch output, then load at most references `0` and `1`:

```ts
const inputs = outputKind === "sketch"
  ? await prepareReferences(references.slice(0, 3))
  : await prepareReferences([masterSketch, ...references.slice(0, 2)]);
const prompt = outputKind === "sketch"
  ? buildSketchPrompt(brief)
  : outputKind === "effect"
    ? buildEffectPrompt(brief)
    : buildFlatPrompt(brief);
```

Never read a key from request JSON. Every object key comes from an owned repository row and is revalidated by `ConceptObjectStore`.

- [ ] **Step 5: Implement the long-running loop and CLI**

`runConceptWorker` records heartbeat every 30 seconds, executes one claim at a time, sleeps one second when idle, and uses an abort signal for shutdown. `scripts/run-inspiration-concept-worker.ts` loads `.env` with `@next/env`, resolves real services only after configuration validation, handles `SIGTERM`/`SIGINT`, closes PostgreSQL, and prints only fixed safe messages.

Emit structured redacted events containing only set ID, local task ID, output kind, attempt, state transition, queue age, stage duration, validated byte/dimension counts, and stable error category. Never include full prompts, provider request/task IDs, result URLs, input data URLs, OSS keys, or owner IDs.

Add:

```json
{
  "scripts": {
    "inspiration:concept-worker": "node --conditions=react-server --import tsx scripts/run-inspiration-concept-worker.ts"
  }
}
```

The systemd unit runs as `melon`, reads `/etc/melon/web.env`, starts after network, uses `/opt/melon/current`, restarts on failure, and sets `MemoryMax=768M`, `TasksMax=128`, `UMask=0077`, `PrivateTmp=true`, `PrivateDevices=true`, `ProtectSystem=full`, `ProtectHome=true`, and `NoNewPrivileges=true`.

- [ ] **Step 6: Run worker and shutdown tests to verify green**

Run:

```bash
npm run test:integration -- src/features/inspiration-concepts/worker.integration.test.ts
npm test -- scripts/run-inspiration-concept-worker.test.ts
npm run typecheck
systemd-analyze verify deploy/systemd/melon-inspiration-concept-worker.service
```

Expected: tests pass; run `systemd-analyze` on Linux and record it as a target-host gate when unavailable on macOS.

- [ ] **Step 7: Commit the worker**

```bash
git add src/features/inspiration-concepts/worker.ts src/features/inspiration-concepts/worker.integration.test.ts src/features/inspiration-concepts/repository.ts scripts/run-inspiration-concept-worker.ts scripts/run-inspiration-concept-worker.test.ts deploy/systemd/melon-inspiration-concept-worker.service package.json package-lock.json
git commit -m "feat: run inspiration concepts in background"
```

---

### Task 7: Expose Set Mutations, Browser Clients, and Private Output Bytes

**Files:**
- Create: `src/app/api/inspiration-analyses/[analysisId]/concept-sets/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concept-sets/route.test.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/route.test.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/regenerate/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/regenerate/route.test.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/outputs/[outputKind]/retry/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/outputs/[outputKind]/retry/route.test.ts`
- Create: `src/app/api/inspiration-concept-assets/[assetId]/route.ts`
- Create: `src/app/api/inspiration-concept-assets/[assetId]/route.test.ts`
- Create: `src/app/api/inspiration-concept-assets/[assetId]/download/route.ts`
- Create: `src/app/api/inspiration-concept-assets/[assetId]/download/route.test.ts`
- Create: `src/features/inspiration-concepts/api.ts`
- Create: `src/features/inspiration-concepts/api.test.ts`
- Create: `src/features/inspiration-concepts/query-keys.ts`
- Create: `src/features/inspiration-concepts/resource-service.ts`
- Create: `src/features/inspiration-concepts/resource-service.integration.test.ts`

**Interfaces:**
- Produces: authenticated HTTP surface, `fetchConceptSets`, `createConceptSetRequest`, `retryConceptOutputRequest`, `regenerateConceptSetRequest`, `deleteConceptSetRequest`, and owned output streaming/download.
- Consumes: Task 5 services, Task 1 schemas, `requireApiUser`, `assertSameOrigin`, `withRoute`, and Task 4 object store.

- [ ] **Step 1: Read the repository's Next.js guides and write failing route tests**

Read completely:

```bash
sed -n '1,260p' node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
sed -n '1,240p' node_modules/next/dist/docs/01-app/02-guides/backend-for-frontend.md
```

Then test unauthenticated access, malformed params, strict bodies, same-origin mutation checks, owner forwarding, `201` create, `200` replay/list/retry/regenerate, `204` for an owned live or already-soft-deleted set, 404 after hard cleanup or for cross-owner/nonexistent sets, preview headers, attachment headers, and output bytes never redirecting to OSS.

- [ ] **Step 2: Run route/client tests to verify red**

Run:

```bash
npm test -- 'src/app/api/inspiration-analyses/[analysisId]/concept-sets/route.test.ts' 'src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/route.test.ts' 'src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/regenerate/route.test.ts' 'src/app/api/inspiration-analyses/[analysisId]/concept-sets/[setId]/outputs/[outputKind]/retry/route.test.ts' 'src/app/api/inspiration-concept-assets/[assetId]/route.test.ts' 'src/app/api/inspiration-concept-assets/[assetId]/download/route.test.ts' src/features/inspiration-concepts/api.test.ts
npm run test:integration -- src/features/inspiration-concepts/resource-service.integration.test.ts
```

Expected: FAIL because routes/client/resource service do not exist.

- [ ] **Step 3: Implement thin Route Handlers**

Follow the existing visual route pattern:

```ts
export const POST = withRoute(async (request, context: InspirationRouteContext) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const { analysisId } = parseInspirationRequest(inspirationParamsSchema, await context.params);
  const mutation = await readInspirationMutation(conceptSetCreateMutationSchema, request);
  return Response.json(await createConceptSet({ ownerId: user.id, analysisId, ...mutation }), { status: 201 });
});
```

All dynamic params use strict UUID/output-kind schemas. GET is uncached. No route accepts `ownerId`, provider identifiers, prompts, object keys, or URLs.

- [ ] **Step 4: Implement owner-authorized preview and download responses**

`authorizeOwnedConceptResource` looks up a non-deleted output through the owned set, reads the object, confirms stored/actual content type equality, and returns bytes. Preview sets `Cache-Control: private, no-store`, `Content-Security-Policy: sandbox`, and `X-Content-Type-Options: nosniff`. Download additionally sets a sanitized server-created filename such as `柔和通勤-方案01-服装效果图.png` via RFC 5987 `filename*` encoding.

- [ ] **Step 5: Implement parsed browser methods and query keys**

```ts
export const inspirationConceptKeys = {
  all: (ownerId: string) => ["inspiration-concepts", ownerId] as const,
  analysis: (ownerId: string, analysisId: string) => ["inspiration-concepts", ownerId, analysisId] as const,
};

export async function fetchConceptSets(analysisId: string, signal?: AbortSignal): Promise<ConceptSetDto[]>;
export async function createConceptSetRequest(analysisId: string, input: ConceptSetCreateMutation): Promise<ConceptSetDto>;
export async function retryConceptOutputRequest(analysisId: string, setId: string, kind: "effect" | "flat", input: ConceptRetryMutation): Promise<ConceptSetDto>;
export async function regenerateConceptSetRequest(analysisId: string, setId: string, input: ConceptRetryMutation): Promise<ConceptSetDto>;
export async function deleteConceptSetRequest(analysisId: string, setId: string): Promise<void>;
```

Every JSON response is parsed before entering the query cache. Error bodies are handled through the existing safe API error utility.

- [ ] **Step 6: Run route/client/resource tests to verify green**

Run the commands from Step 2 again, then:

```bash
npm run typecheck
```

Expected: PASS; preview/download tests assert no `Location` header and no secret identifier in failures.

- [ ] **Step 7: Commit the HTTP surface**

```bash
git add 'src/app/api/inspiration-analyses/[analysisId]/concept-sets' 'src/app/api/inspiration-concept-assets' src/features/inspiration-concepts/api.ts src/features/inspiration-concepts/api.test.ts src/features/inspiration-concepts/query-keys.ts src/features/inspiration-concepts/resource-service.ts src/features/inspiration-concepts/resource-service.integration.test.ts
git commit -m "feat: expose inspiration concept sets"
```

---

### Task 8: Compose Concept Sets into Private and Shared Reports

**Files:**
- Modify: `src/features/inspiration-visuals/contracts.ts`
- Modify: `src/features/inspiration-visuals/contracts.test.ts`
- Modify: `src/features/inspiration-visuals/visual-repository.ts`
- Modify: `src/features/inspiration-visuals/visual-service.ts`
- Modify: `src/features/inspiration-visuals/visual-service.integration.test.ts`
- Modify: `src/features/inspiration-visuals/document-contracts.ts`
- Modify: `src/features/inspiration-visuals/document-composer.ts`
- Modify: `src/features/inspiration-visuals/document-composer.test.ts`
- Modify: `src/features/inspiration/share-service.ts`
- Modify: `src/features/inspiration/share-service.integration.test.ts`
- Modify: `src/features/inspiration-concepts/resource-service.ts`
- Modify: `src/features/inspiration-concepts/resource-service.integration.test.ts`
- Modify: `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.ts`
- Modify: `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts`
- Modify: `src/features/inspiration/analysis-service.integration.test.ts`

**Interfaces:**
- Produces: private direction `conceptSets`, public completed-output projection, `conceptGenerationAvailable`, unified shared byte authorization, and report-deletion cleanup.
- Consumes: Task 1 private/public set DTOs, Task 5 list services, Task 7 resource authorization, and existing document/share composition.

- [ ] **Step 1: Write failing document and share tests**

Test direction-only attachment, version descending order, maximum three sets per direction, private task state retained, public task/error/reference state removed, only completed assets shared, correct share-local image paths, disabled generation preserving old sets, revoked shares returning 404, and report deletion removing both visual and concept object keys while preserving unrelated library objects.

```ts
const document = composeInspirationDocument({
  result,
  sources,
  conceptSets: [setForDirection1, setForDirection0Version2, setForDirection0Version1],
});
expect(document.directions[0]!.conceptSets.map(({ version }) => version)).toEqual([2, 1]);
expect(document.directions[1]!.conceptSets.map(({ id }) => id)).toEqual([setForDirection1.id]);

expect(shared.document.directions[0]!.conceptSets[0]!.outputs).toHaveLength(2);
const publicJson = JSON.stringify(shared.document);
for (const forbidden of ["task", "errorCode", "referenceAssetIds", "brief", "provider", "/api/"]) {
  expect(publicJson).not.toContain(forbidden);
}
```

- [ ] **Step 2: Run document/share tests to verify red**

Run:

```bash
npm test -- src/features/inspiration-visuals/contracts.test.ts src/features/inspiration-visuals/document-composer.test.ts 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts'
npm run test:integration -- src/features/inspiration-visuals/visual-service.integration.test.ts src/features/inspiration/share-service.integration.test.ts src/features/inspiration-concepts/resource-service.integration.test.ts src/features/inspiration/analysis-service.integration.test.ts
```

Expected: FAIL because report contracts do not carry concept sets and shared resource lookup only understands legacy visual assets.

- [ ] **Step 3: Extend the private board and document contracts additively**

Add `conceptGenerationAvailable: boolean` to the private visual board. Keep legacy `conceptJobs` and `concepts` fields readable during migration, but new writes and UI use `conceptSets`.

Add to each private document direction:

```ts
conceptSets: z.array(conceptSetDtoSchema).max(3),
```

Add to each public direction:

```ts
conceptSets: z.array(publicConceptSetDtoSchema).max(3),
```

`composeInspirationDocument` validates every set direction, groups by direction, sorts version descending, and rejects duplicate set/output IDs. `composePublicInspirationDocument` rewrites each completed output to `/share/inspiration/${shareId}/assets/${assetId}` and explicitly rebuilds public objects field by field.

- [ ] **Step 4: Load private and public sets without leaking generation state**

The analysis-level private concept query calls `listConceptSets({ ownerId, analysisId })` once and passes that parsed result into private document composition and the direction controllers. `getSharedInspirationPage` calls a repository projection that returns non-deleted sets and completed outputs only; it never calls the private DTO builder and never loads task/provider fields into the public object graph.

`conceptGenerationAvailable` is `true` only when the server feature flag and core inspiration feature are both enabled. Disabling it hides new paid actions but does not filter completed sets or bytes.

- [ ] **Step 5: Unify shared byte authorization and report deletion cleanup**

Implement `authorizeSharedInspirationResource` in the concept resource service:

```ts
export async function authorizeSharedInspirationResource(input: {
  shareId: string;
  assetId: string;
}) {
  const concept = await findSharedConceptOutput(input);
  if (concept) return readConceptObject(concept);
  return authorizeSharedVisualResource(input);
}
```

Both misses collapse to the same 404. Update the shared asset route to call this one function.

Make research-visual completion acquire the same analysis advisory lock as concept-set creation. After publishing the new visual job, list superseded research keys that are not referenced by any non-deleted concept set and delete only that list; never reuse the pre-refresh unconditional key snapshot.

Before deleting an analysis, snapshot authorized visual keys and concept-output keys, commit the owned analysis deletion, and then best-effort delete both key lists. A foreign, pending, or concurrently deleted analysis must not reach storage deletion. Keep the scheduled orphan cleanup as the fallback for external deletion failure.

- [ ] **Step 6: Run document/share/deletion tests to verify green**

Run the commands from Step 2 again, then:

```bash
npm run typecheck
```

Expected: PASS; public JSON and error serialization contain no private task or provider fields.

- [ ] **Step 7: Commit report composition and sharing**

```bash
git add src/features/inspiration-visuals/contracts.ts src/features/inspiration-visuals/contracts.test.ts src/features/inspiration-visuals/visual-repository.ts src/features/inspiration-visuals/visual-service.ts src/features/inspiration-visuals/visual-service.integration.test.ts src/features/inspiration-visuals/document-contracts.ts src/features/inspiration-visuals/document-composer.ts src/features/inspiration-visuals/document-composer.test.ts src/features/inspiration/share-service.ts src/features/inspiration/share-service.integration.test.ts src/features/inspiration-concepts/resource-service.ts src/features/inspiration-concepts/resource-service.integration.test.ts 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.ts' 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts' src/features/inspiration/analysis-service.integration.test.ts
git commit -m "feat: include concept sets in inspiration reports"
```

---

### Task 9: Build the Direction-Level Generation and Review UI

**Files:**
- Create: `src/features/inspiration/inspiration-concept-drawer.tsx`
- Create: `src/features/inspiration/inspiration-concept-drawer.test.tsx`
- Create: `src/features/inspiration/inspiration-concept-section.tsx`
- Create: `src/features/inspiration/inspiration-concept-section.test.tsx`
- Create: `src/features/inspiration/inspiration-concept-controller.tsx`
- Create: `src/features/inspiration/inspiration-concept-output-dialog.tsx`
- Modify: `src/features/inspiration/inspiration-direction-section.tsx`
- Modify: `src/features/inspiration/inspiration-document.tsx`
- Modify: `src/features/inspiration/inspiration-document.test.tsx`
- Modify: `src/features/inspiration/inspiration-view.tsx`
- Modify: `src/features/inspiration/inspiration-view.test.tsx`
- Modify: `src/features/inspiration/shared-inspiration-page.test.tsx`
- Modify: `src/features/inspiration/inspiration.module.css`

**Interfaces:**
- Produces: `InspirationConceptController`, `InspirationConceptDrawer`, `InspirationConceptSection`, and `InspirationConceptOutputDialog`.
- Consumes: Tasks 3 and 7 selector/client/query keys, Task 8 private document/availability fields, Lucide icons, Radix Dialog/Checkbox/Tabs/DropdownMenu, and existing evidence-image behavior.

- [ ] **Step 1: Write failing drawer and section component tests**

Cover hidden action when disabled, direction summary, deterministic default references, deselection to zero, maximum three, cost notice, submit payload, focus trap/escape/return focus, one active set disabling create, three retained sets disabling create, ordered version tabs, fixed slot labels, queued/generating/failed/completed states, sibling preservation, derivative retry, sketch regeneration wording, idempotent delete, output preview/download, and AI labels.

```tsx
render(<InspirationConceptDrawer {...props} />);
expect(screen.getAllByRole("checkbox")).toHaveLength(3);
expect(screen.getAllByRole("checkbox").every((node) => (node as HTMLButtonElement).dataset.state === "checked")).toBe(true);
await user.click(screen.getByRole("checkbox", { name: /参考：棉麻细节/ }));
await user.click(screen.getByRole("button", { name: "生成整套成图" }));
expect(props.onGenerate).toHaveBeenCalledWith({
  visualJobId: props.activeVisualJobId,
  referenceAssetIds: [firstId, thirdId],
});

render(<InspirationConceptSection sets={[partialSet]} {...actions} />);
expect(screen.getByText("设计草图")).toBeVisible();
expect(screen.getByText("服装效果图")).toBeVisible();
expect(screen.getByText("服装款式图")).toBeVisible();
expect(screen.getByRole("button", { name: "重试服装效果图" })).toBeEnabled();
```

- [ ] **Step 2: Write failing view integration tests**

Use MSW/fetch fixtures to test create -> query polling -> sketch -> derivatives -> completed, page reload, feature-off history, report switching, local API failure, mutation deduplication, cache invalidation, deletion, shared read-only output, and no global report spinner.

- [ ] **Step 3: Run UI tests to verify red**

Run:

```bash
npm test -- src/features/inspiration/inspiration-concept-drawer.test.tsx src/features/inspiration/inspiration-concept-section.test.tsx src/features/inspiration/inspiration-document.test.tsx src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/shared-inspiration-page.test.tsx
```

Expected: FAIL because concept UI components do not exist.

- [ ] **Step 4: Implement the right-side confirmation panel**

Use Radix Dialog with the existing overlay, a right-anchored content surface, `Checkbox.Root`, and stable reference thumbnails. `selectDefaultConceptReferences` runs only when the drawer opens or the report/visual job changes; it must not reselect an image the user deliberately unchecked during the same open session.

The primary command calls:

```ts
onGenerate({
  operationId: crypto.randomUUID(),
  directionIndex,
  visualJobId: selectedIds.length > 0 ? activeVisualJobId : null,
  referenceAssetIds: selectedIds,
});
```

Show `将生成 3 张 AI 图片，预计费用以百炼账单为准` as the only billing copy. Do not display raw model settings or instructions inside the product UI.

- [ ] **Step 5: Implement set tabs and stable three-slot results**

Use Radix Tabs for `方案 01` through `方案 03`. Slots use explicit aspect-ratio wrappers (`3 / 4`, `3 / 4`, `4 / 3`) and fixed min sizes so progress/error labels cannot resize the report. Use `Sparkles`, `Download`, `RefreshCw`, `Trash2`, and `MoreHorizontal` Lucide icons with accessible labels/tooltips.

If a completed asset and a retry task coexist, render the completed image with a small `正在重新生成` status; never replace it with a skeleton. The output dialog uses the existing evidence-dialog focus and media-failure patterns and offers only close/download.

- [ ] **Step 6: Isolate React Query orchestration in the controller**

The controller owns one analysis-level query and mutations; it does not create one polling query per slot.

```ts
const query = useQuery({
  queryKey: inspirationConceptKeys.analysis(ownerId, analysisId),
  queryFn: ({ signal }) => fetchConceptSets(analysisId, signal),
  refetchInterval: ({ state }) => hasActiveConceptTask(state.data) ? 3_000 : false,
});
```

Create/retry/regenerate mutations insert the returned set into cache, then invalidate once. Delete removes the set optimistically and restores on error. Report switching cancels old concept queries. The direction component receives plain data/actions and remains render-focused.

- [ ] **Step 7: Add restrained desktop-first styling**

Keep the report unframed; individual output figures may be repeated items with radius no greater than 8px. At report widths above 900px use three columns with the flat allowed a wider internal image; at narrower widths use two then one column without horizontal scroll. Keep letter spacing at zero, use the existing neutral palette, and avoid gradients, decorative cards, or nested cards.

- [ ] **Step 8: Run UI tests and accessibility checks to verify green**

Run:

```bash
npm test -- src/features/inspiration/inspiration-concept-drawer.test.tsx src/features/inspiration/inspiration-concept-section.test.tsx src/features/inspiration/inspiration-document.test.tsx src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/shared-inspiration-page.test.tsx
npm run typecheck
```

Expected: PASS; tests verify focus return, keyboard actions, stable geometry, and zero provider/external URLs in the DOM.

- [ ] **Step 9: Commit the product UI**

```bash
git add src/features/inspiration/inspiration-concept-drawer.tsx src/features/inspiration/inspiration-concept-drawer.test.tsx src/features/inspiration/inspiration-concept-section.tsx src/features/inspiration/inspiration-concept-section.test.tsx src/features/inspiration/inspiration-concept-controller.tsx src/features/inspiration/inspiration-concept-output-dialog.tsx src/features/inspiration/inspiration-direction-section.tsx src/features/inspiration/inspiration-document.tsx src/features/inspiration/inspiration-document.test.tsx src/features/inspiration/inspiration-view.tsx src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/shared-inspiration-page.test.tsx src/features/inspiration/inspiration.module.css
git commit -m "feat: add inspiration concept set workspace"
```

---

### Task 10: Add Cleanup, Operational Status, and Production Runbooks

**Files:**
- Create: `src/features/inspiration-concepts/cleanup.ts`
- Create: `src/features/inspiration-concepts/cleanup.integration.test.ts`
- Create: `scripts/cleanup-inspiration-concept-objects.ts`
- Create: `scripts/cleanup-inspiration-concept-objects.test.ts`
- Create: `scripts/check-inspiration-concept-worker.ts`
- Create: `scripts/check-inspiration-concept-worker.test.ts`
- Create: `deploy/systemd/melon-inspiration-concept-cleanup.service`
- Create: `deploy/systemd/melon-inspiration-concept-cleanup.timer`
- Modify: `src/features/inspiration-concepts/repository.ts`
- Modify: `src/features/inspiration-concepts/object-store.ts`
- Modify: `src/features/inspiration-concepts/object-store.test.ts`
- Modify: `scripts/check-production.ts`
- Modify: `scripts/check-production.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/operations/web-production.md`

**Interfaces:**
- Produces: `cleanupInspirationConceptObjects`, `getConceptWorkerStatus`, safe CLIs, daily systemd cleanup, rollout/rollback instructions, and production diagnostics.
- Consumes: Task 2 repository age/status queries, Task 4 scoped object listing, Task 6 heartbeat, and Task 1 production readiness.

- [ ] **Step 1: Write failing cleanup and status tests**

Cover soft-deleted set cleanup, terminal-set orphan keys older than 24 hours, active-set prefix exclusion, known current/superseded output handling, superseded research evidence retained while referenced and removed after the final set deletion, cross-owner scope, list/delete failure, dry run, deterministic counts, worker heartbeat fresh/stale, queue counts, oldest age, and sanitized CLI output.

```ts
const result = await cleanupInspirationConceptObjects({
  now,
  orphanAgeMs: 24 * 60 * 60 * 1000,
  dryRun: false,
  repository,
  store,
});
expect(result).toEqual({ scannedSets: 2, deletedObjects: 3, deletedSets: 1, skippedActiveSets: 1 });
expect(store.delete).not.toHaveBeenCalledWith(expect.arrayContaining([activeObjectKey, currentOutputKey]));

expect(await getConceptWorkerStatus({ now, staleAfterMs: 90_000 })).toMatchObject({
  healthy: true,
  counts: { queued: 0, submitting: 0, submitted: 1, failed: 0 },
});
```

- [ ] **Step 2: Run cleanup/status tests to verify red**

Run:

```bash
npm run test:integration -- src/features/inspiration-concepts/cleanup.integration.test.ts
npm test -- scripts/cleanup-inspiration-concept-objects.test.ts scripts/check-inspiration-concept-worker.test.ts src/features/inspiration-concepts/object-store.test.ts scripts/check-production.test.ts
```

Expected: FAIL because cleanup/status commands do not exist.

- [ ] **Step 3: Implement conservative prefix cleanup**

Never scan or delete the whole bucket. The repository returns only concept sets that are `deleting` or terminal and older than the orphan threshold. For each validated set prefix, list keys, subtract current output keys, and delete only remaining keys. Active queued/generating sets are skipped even if their timestamps look stale; task recovery owns them. In a separate database query, list superseded research evidence keys with zero non-deleted concept references and delete only those validated research-prefix keys.

After every object for a deleting set is gone, hard-delete that set and its rows in a transaction. A failed list/delete leaves the set soft-deleted for the next run.

- [ ] **Step 4: Implement safe CLIs and systemd timer**

Add scripts:

```json
{
  "scripts": {
    "inspiration:concept-cleanup": "node --conditions=react-server --import tsx scripts/cleanup-inspiration-concept-objects.ts",
    "inspiration:concept-status": "node --conditions=react-server --import tsx scripts/check-inspiration-concept-worker.ts"
  }
}
```

Cleanup accepts only `--dry-run` or no arguments. Status prints bounded JSON containing heartbeat age, safe status, counts, and oldest queue age; it never prints database URLs, task/provider IDs, prompts, object keys, or owner IDs. The timer runs daily with `Persistent=true`, randomized delay, the same hardened service settings, and `/etc/melon/web.env`.

- [ ] **Step 5: Extend production checks and runbooks**

`prod:check` fails when concept generation is enabled without release approval, Pro model, matching workspace URLs, real OSS, or required worker ID. It does not require a live heartbeat because web startup must remain independent.

Document exact release order:

1. database backup/restore evidence;
2. additive migration with flag false;
3. web/worker/timer install and `systemd-analyze verify`;
4. worker heartbeat/status with empty queue;
5. controlled account smoke;
6. OSS/share/download/restart/billing verification;
7. enable UI.

Document rollback: disable the flag first, let submitted tasks import or record and stop the worker, revert web release, retain additive tables/objects, and never run destructive downgrade SQL during an incident.

Document the approved Beijing list-price estimate without hard-coding it into application logic: maximum-reference input cost `9 × 0.02 CNY = 0.18 CNY`, Pro 2K output cost `3 × 0.50 CNY = 1.50 CNY`, estimated set total `1.68 CNY` before retries or promotions. Link the official pricing page and require operators to recheck the configured workspace region and current account price before enablement.

- [ ] **Step 6: Run operational tests to verify green**

Run:

```bash
npm run test:integration -- src/features/inspiration-concepts/cleanup.integration.test.ts
npm test -- scripts/cleanup-inspiration-concept-objects.test.ts scripts/check-inspiration-concept-worker.test.ts src/features/inspiration-concepts/object-store.test.ts scripts/check-production.test.ts
npm run typecheck
systemd-analyze verify deploy/systemd/melon-inspiration-concept-worker.service deploy/systemd/melon-inspiration-concept-cleanup.service deploy/systemd/melon-inspiration-concept-cleanup.timer
```

Expected: tests pass; target-host verification remains mandatory if local macOS lacks systemd.

- [ ] **Step 7: Commit operations and cleanup**

```bash
git add src/features/inspiration-concepts/cleanup.ts src/features/inspiration-concepts/cleanup.integration.test.ts src/features/inspiration-concepts/repository.ts src/features/inspiration-concepts/object-store.ts src/features/inspiration-concepts/object-store.test.ts scripts/cleanup-inspiration-concept-objects.ts scripts/cleanup-inspiration-concept-objects.test.ts scripts/check-inspiration-concept-worker.ts scripts/check-inspiration-concept-worker.test.ts scripts/check-production.ts scripts/check-production.test.ts deploy/systemd/melon-inspiration-concept-cleanup.service deploy/systemd/melon-inspiration-concept-cleanup.timer package.json package-lock.json README.md docs/operations/web-production.md
git commit -m "ops: harden inspiration concept generation"
```

---

### Task 11: Add Real Smoke, End-to-End Coverage, Visual QA, and Release Gates

**Files:**
- Create: `src/features/inspiration-concepts/qwen-image-provider.real.test.ts`
- Create: `tests/e2e/inspiration-concepts-fixtures.ts`
- Create: `tests/e2e/inspiration-concepts.spec.ts`
- Modify: `tests/e2e/environment.ts`
- Modify: `tests/e2e/prepare.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/operations/web-production.md`

**Interfaces:**
- Produces: opt-in billed provider verification, full browser workflow, screenshots, and final release evidence.
- Consumes: the completed feature from Tasks 1-10.

- [ ] **Step 1: Add a gated three-stage real-provider test**

The test is skipped unless `RUN_REAL_INSPIRATION_CONCEPT_TESTS=1`. It builds a small fixed fashion brief, creates one sketch, waits with bounded backoff, uses that sketch plus at most two local fixture references for effect and flat, validates all three results, and deletes all smoke objects. It never logs prompts, URLs, keys, Base64, or credentials.

Add:

```json
{
  "scripts": {
    "test:inspiration:concept-real": "RUN_REAL_INSPIRATION_CONCEPT_TESTS=1 vitest run src/features/inspiration-concepts/qwen-image-provider.real.test.ts"
  }
}
```

- [ ] **Step 2: Write E2E fixtures and failing browser tests**

Use metadata/database fixtures and intercepted local image bytes; browser requests to external origins remain forbidden. Cover:

- choose a direction and inspect three default references;
- deselect references and submit exactly one set;
- queued -> sketch -> derivative -> complete state projection;
- close/reopen page and recover server state;
- partial derivative failure and local retry while sibling/current output stays visible;
- new sketch creates `方案 02`;
- third retained set allowed and fourth blocked;
- delete one set;
- download headers and nonblank image bytes;
- shared report contains only completed AI-labeled outputs and no controls;
- revoked share and cross-tenant output return 404;
- feature disabled hides paid actions while completed images remain.

- [ ] **Step 3: Run focused E2E tests to verify initial red, then green**

Run before fixture/UI completion and expect failing assertions, then rerun after the fixtures match the finished contracts:

```bash
E2E_METADATA_ONLY=1 npm run test:e2e -- tests/e2e/inspiration-concepts.spec.ts --project=chromium
```

Expected final result: PASS with zero external browser requests and zero page/console errors.

- [ ] **Step 4: Run the complete offline verification matrix**

Run:

```bash
npm test -- src/features/inspiration-concepts src/features/inspiration src/features/inspiration-visuals 'src/app/api/inspiration-analyses/[analysisId]/concept-sets' 'src/app/api/inspiration-concept-assets' 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts' scripts/run-inspiration-concept-worker.test.ts scripts/cleanup-inspiration-concept-objects.test.ts scripts/check-inspiration-concept-worker.test.ts scripts/check-production.test.ts
npm run test:integration -- src/lib/db/schema/inspiration-concepts.integration.test.ts src/features/inspiration-concepts/service.integration.test.ts src/features/inspiration-concepts/worker.integration.test.ts src/features/inspiration-concepts/resource-service.integration.test.ts src/features/inspiration-concepts/cleanup.integration.test.ts src/features/inspiration/share-service.integration.test.ts src/features/inspiration/analysis-service.integration.test.ts
npm run typecheck
npm run lint
npm run build
E2E_METADATA_ONLY=1 npm run test:e2e -- tests/e2e/inspiration-concepts.spec.ts --project=chromium
git diff --check
```

Expected: every command exits 0 without a provider call.

- [ ] **Step 5: Perform desktop-first visual QA**

Capture owner and shared screenshots at `1512x982`, `1440x900`, `768x1024`, and `390x844`. At each viewport inspect zero, queued, partial, completed, retrying, three-version, drawer, and output-dialog states. Assert:

- no overlap or horizontal overflow;
- report reading measure remains stable;
- labels/buttons fit without negative letter spacing or viewport-scaled fonts;
- slot aspect ratios remain 3:4, 3:4, and 4:3;
- failed/loading text does not resize the grid;
- every completed image decodes with non-zero natural dimensions and non-uniform pixels;
- focus is visible and returns to the invoking control after every dialog closes.

- [ ] **Step 6: Run the explicit billed smoke in a controlled environment**

Run:

```bash
RUN_REAL_INSPIRATION_CONCEPT_TESTS=1 npm run test:inspiration:concept-real
```

Then deploy with the flag false and perform one internal-account production set. Restart the worker after sketch submission and verify both derivatives still finish. Inspect the three durable assets, private/download/share routes, worker status, sanitized logs, and actual DashScope bill. If any check fails, keep the feature flag false.

- [ ] **Step 7: Commit final verification assets and documentation**

```bash
git add src/features/inspiration-concepts/qwen-image-provider.real.test.ts tests/e2e/inspiration-concepts-fixtures.ts tests/e2e/inspiration-concepts.spec.ts tests/e2e/environment.ts tests/e2e/prepare.ts package.json package-lock.json README.md docs/operations/web-production.md
git commit -m "test: verify inspiration concept set workflow"
```

---

## Final Acceptance Checklist

- [ ] A completed report direction proposes zero to three external references and never proposes a private library image.
- [ ] One create action returns a durable queued set without waiting for provider work.
- [ ] The worker continues after the browser closes and resumes expired safe leases after restart.
- [ ] Ambiguous paid submissions are never automatically resubmitted.
- [ ] Sketch publication happens before exactly one effect and one flat task are created.
- [ ] Derivative inputs are master sketch plus at most two selected references in deterministic order.
- [ ] Output sizes are `1536x2048`, `1536x2048`, and `2048x1536` with Qwen Image 3.0 Pro.
- [ ] A derivative retry preserves the current completed image until replacement publication succeeds.
- [ ] A sketch retry creates a new version and leaves the old set unchanged.
- [ ] Each direction has at most one active and three retained sets under concurrent requests.
- [ ] Provider temporary URLs are imported before completion and never appear in DTOs, HTML, logs, screenshots, or test artifacts.
- [ ] Preview/download/share bytes are owner/capability authorized, private, nosniff, and never OSS redirects.
- [ ] Shared reports show completed outputs only, label every output `AI 生成`, and expose no task controls or private fields.
- [ ] Deleting a set/report and scheduled orphan cleanup cannot delete another owner, active set, library asset, or unrelated OSS prefix.
- [ ] Disabling generation prevents new paid tasks while preserving text research, the material library, existing reports, and completed concept images.
- [ ] Main web readiness stays healthy when the concept worker is stopped.
- [ ] Offline unit, integration, route, UI, build, lint, and Playwright gates pass without provider billing.
- [ ] The explicit three-stage real smoke and one controlled production set pass before enabling the UI.
