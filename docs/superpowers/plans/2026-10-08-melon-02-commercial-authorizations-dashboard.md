# melon Commercial Authorizations and Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-pattern commercial authorization history, exclusive/buyout rules, commercial library filters, and a real-time revenue dashboard without turning melon into an order or CRM system.

**Architecture:** Store normalized `AuthorizationField` and `Authorization` rows in PostgreSQL. Every authorization mutation locks its `Pattern`, validates `commercialVersion`, applies rules in one transaction, appends a change event, and invalidates live queries. Dashboard responses are computed from indexed PostgreSQL queries; no JSON business store or aggregate table is introduced.

**Tech Stack:** Existing phase-01 Next.js/React/PostgreSQL stack plus React Hook Form, Zod resolver, and Recharts for accessible charts.

---

## Prerequisite and File Map

Start only after the phase-01 gate is green. Preserve its domain boundaries:

```text
drizzle/                                      # Authorization migration and system-field seed
src/app/api/authorization-fields/             # Read/create/archive custom fields
src/app/api/patterns/[patternId]/authorizations/
src/app/api/authorizations/[authorizationId]/ # Edit/void/restore
src/app/api/dashboard/authorizations/          # Aggregate read model
src/app/(workspace)/dashboard/                 # Dashboard page
src/features/authorizations/                   # Rules, transactions, inspector and forms
src/features/analytics/                        # Date ranges, aggregate queries and charts
src/features/library/                          # Commercial summaries and filters
src/features/patterns/                         # Trash/restore/permanent-delete integration
src/lib/db/schema/authorizations.ts
src/test/fixtures/authorization-seed.ts
tests/e2e/commercial-authorizations.spec.ts
tests/e2e/dashboard.spec.ts
```

## Task 1: Add Authorization Tables and the Fixed Field Dictionary

**Files:**
- Create: `src/lib/db/schema/authorizations.ts`
- Modify: `src/lib/db/schema/index.ts`, `src/test/database.ts`
- Create: `src/features/authorizations/system-fields.ts`
- Test: `src/lib/db/schema/authorizations.integration.test.ts`
- Generate: authorization migration and system-field seed under `drizzle/`

- [x] **Step 1: Write failing schema tests**

Assert the important database invariants directly:

```ts
await expect(insertAuthorization({ kind: "global_buyout", fieldId: systemFieldId })).rejects.toThrow();
await expect(insertAuthorization({ kind: "standard", fieldId: null })).rejects.toThrow();
await expect(insertSecondActiveBuyout(patternId)).rejects.toThrow();
await expect(insertSecondActiveExclusive(patternId, systemFieldId)).rejects.toThrow();
await expect(insertDuplicateOperation(ownerId, operationId)).rejects.toThrow();
```

Also prove two ordinary active authorizations may share one pattern/field, archived fields remain referentially valid, and `priceFen=0n` is valid while `-1n` is rejected. Run and expect missing-table failure.

- [x] **Step 2: Define exact enums, rows, and indexes**

```ts
export const authorizationScopes = ["system", "custom"] as const;
export const authorizationFieldStatuses = ["active", "archived"] as const;
export const authorizationKinds = ["standard", "field_exclusive", "global_buyout"] as const;
export const authorizationStatuses = ["active", "void"] as const;
export const authorizationScopeEnum = pgEnum("authorization_scope", authorizationScopes);
export const authorizationFieldStatusEnum = pgEnum("authorization_field_status", authorizationFieldStatuses);
export const authorizationKindEnum = pgEnum("authorization_kind", authorizationKinds);
export const authorizationStatusEnum = pgEnum("authorization_status", authorizationStatuses);
```

`authorizationFields` contains UUID, nullable owner, scope, name, normalized name, status, created/updated/archived timestamps. Add a check tying `system` to `ownerId is null` and `custom` to `ownerId is not null`, a global unique system normalized name, and a user-scoped custom normalized-name unique index across active and archived rows.

Define the authorization row explicitly:

```ts
export const authorizations = pgTable("authorizations", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  patternId: uuid("pattern_id").notNull().references(() => patterns.id),
  operationId: uuid("operation_id").notNull(),
  kind: authorizationKindEnum("kind").notNull(),
  fieldId: uuid("field_id").references(() => authorizationFields.id),
  fieldNameSnapshot: text("field_name_snapshot"),
  licenseeName: text("licensee_name").notNull(),
  priceFen: bigint("price_fen", { mode: "bigint" }).notNull(),
  authorizedOn: date("authorized_on", { mode: "string" }).notNull(),
  note: text("note"),
  status: authorizationStatusEnum("status").notNull().default("active"),
  version: integer("version").notNull().default(0),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Use a composite `(ownerId, patternId)` foreign key so an authorization can never pair one owner with another owner's pattern. Add a check tying global buyout to null field and other kinds to non-null field, `priceFen >= 0`, `(ownerId, operationId)` uniqueness, the four approved query indexes, one active buyout per pattern, and one active field-exclusive row per pattern/field. The pattern foreign key remains intact because deleted patterns survive as sync tombstones; the permanent-deletion service explicitly removes authorization rows. Ordinary UI operations never hard-delete one authorization.

- [x] **Step 3: Seed the twelve immutable system fields**

Define this exact ordered list in code and use deterministic UUID constants in a reviewed data migration:

```ts
export const SYSTEM_AUTHORIZATION_FIELDS = [
  "家居服", "日用百货", "口水巾", "家纺床品", "服装服饰", "婴童用品",
  "箱包鞋帽", "文具纸品", "餐厨用品", "家居装饰", "包装礼品", "数码配件",
] as const;
```

The migration uses `insert ... on conflict do nothing`; it never renames or deletes existing field rows during application startup.

- [x] **Step 4: Generate, inspect, migrate, and commit**

```bash
npm run db:generate
git diff -- drizzle src/lib/db/schema src/features/authorizations/system-fields.ts
npm run db:migrate
npm run test:integration -- src/lib/db/schema/authorizations.integration.test.ts
npm run typecheck
git add drizzle src/lib/db/schema src/features/authorizations/system-fields.ts src/test/database.ts
git commit -m "feat: add authorization data model"
```

Expected: all database constraints pass and the database contains exactly twelve system fields.

## Task 2: Implement Money, Date, Field, and Commercial-State Rules

**Files:**
- Create: `src/features/authorizations/contracts.ts`, `money.ts`, `dates.ts`, `commercial-state.ts`
- Create: `src/features/authorizations/field-service.ts`, `field-repository.ts`
- Test: `src/features/authorizations/money.test.ts`, `dates.test.ts`, `commercial-state.test.ts`
- Test: `src/features/authorizations/field-service.integration.test.ts`

- [x] **Step 1: Write failing pure-rule tests**

```ts
expect(parseRmbToFen("0")).toBe(0n);
expect(parseRmbToFen("0.1")).toBe(10n);
expect(parseRmbToFen("12.34")).toBe(1234n);
expect(() => parseRmbToFen("1.234")).toThrow("AUTHORIZATION_PRICE_INVALID");
expect(formatFen(1234n)).toBe("12.34");
expect(resolveCommercialState(["standard", "field_exclusive"])).toBe("field_exclusive");
expect(resolveCommercialState(["standard", "global_buyout"])).toBe("global_buyout");
```

Date tests use an injected server date and reject future `authorizedOn`. Field tests prove trimmed, case-insensitive uniqueness against both custom and system names and prove archive is idempotent.

- [x] **Step 2: Implement integer-only RMB parsing**

```ts
export function parseRmbToFen(input: string): bigint {
  const normalized = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(normalized)) throw new AppError("AUTHORIZATION_PRICE_INVALID", 400);
  const [yuan, fraction = ""] = normalized.split(".");
  return BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function formatFen(value: bigint): string {
  const yuan = value / 100n;
  const fen = (value % 100n).toString().padStart(2, "0");
  return `${yuan}.${fen}`;
}
```

Never convert `priceFen` through JavaScript `number`; API DTOs serialize it as a decimal string.

- [x] **Step 3: Implement field normalization and archive service**

Custom names trim to 1–32 characters and normalize with Unicode NFKC plus locale-independent lowercase. Create checks active and archived custom rows plus system rows before insert. Archive accepts only an owned custom row, sets status/archived time, appends a change event, and leaves historical authorizations untouched.

```ts
export function normalizeAuthorizationFieldName(input: string): { name: string; normalizedName: string } {
  const name = input.trim().normalize("NFKC");
  if (name.length < 1 || name.length > 32) throw new AppError("AUTHORIZATION_FIELD_NAME_INVALID", 400);
  return { name, normalizedName: name.toLocaleLowerCase("und") };
}
```

- [x] **Step 4: Implement commercial-state priority**

```ts
export type CommercialState = "unlicensed" | "standard" | "field_exclusive" | "global_buyout";
export function resolveCommercialState(kinds: AuthorizationKind[]): CommercialState {
  if (kinds.includes("global_buyout")) return "global_buyout";
  if (kinds.includes("field_exclusive")) return "field_exclusive";
  if (kinds.includes("standard")) return "standard";
  return "unlicensed";
}
```

Only active authorizations feed this function.

- [x] **Step 5: Verify and commit the rule layer**

```bash
npm test -- src/features/authorizations/money.test.ts src/features/authorizations/dates.test.ts src/features/authorizations/commercial-state.test.ts
npm run test:integration -- src/features/authorizations/field-service.integration.test.ts
npm run typecheck
git add src/features/authorizations
git commit -m "feat: add authorization field and money rules"
```

## Task 3: Implement Transactional Authorization Mutations

**Files:**
- Create: `src/features/authorizations/authorization-repository.ts`
- Create: `src/features/authorizations/authorization-service.ts`
- Test: `src/features/authorizations/authorization-service.integration.test.ts`
- Test: `src/features/authorizations/authorization-concurrency.integration.test.ts`

- [x] **Step 1: Write failing rule-matrix tests**

Cover each row of this matrix:

| Existing active state | Requested write | Result |
| --- | --- | --- |
| none | standard | accept |
| same-field standard | standard | accept |
| same-field exclusive | any same-field kind | `AUTHORIZATION_FIELD_LOCKED` |
| other-field exclusive | standard in a different field | accept |
| global buyout | any new kind | `PATTERN_BOUGHT_OUT` |
| same-field history before exclusive | exclusive without confirmation | `AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED` |
| any history before buyout | buyout without confirmation | `AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED` |
| trashed/deleted/non-ready pattern | any mutation | `PATTERN_NOT_ACTIVE` |

Edit tests exclude the current row from self-conflict, void is idempotent, void releases restrictions, and restore reruns all checks. A stale authorization `version` or pattern `commercialVersion` returns `AUTHORIZATION_STATE_CHANGED`.

```ts
it.each([
  ["same_field_exclusive", "standard", "AUTHORIZATION_FIELD_LOCKED"],
  ["global_buyout", "standard", "PATTERN_BOUGHT_OUT"],
  ["trashed", "standard", "PATTERN_NOT_ACTIVE"],
])("rejects %s + %s", async (fixture, kind, code) => {
  await expect(runAuthorizationCase(fixture, kind)).rejects.toMatchObject({ code });
});
```

- [x] **Step 2: Implement the shared locked mutation transaction**

All create/edit/void/restore methods call one internal boundary:

```ts
async function withLockedCommercialState<T>(input: CommercialMutationKey, run: (context: LockedCommercialContext) => Promise<T>) {
  return db.transaction(async (tx) => {
    const pattern = await lockOwnedPattern(tx, input.ownerId, input.patternId);
    if (!pattern) throw new AppError("NOT_FOUND", 404);
    if (pattern.status !== "ready") throw new AppError("PATTERN_NOT_ACTIVE", 409);
    return run({ tx, pattern });
  });
}
```

`lockOwnedPattern` issues `select ... for update`. Before starting, the public service returns any stored `(ownerId, operationId)` replay result. Create/edit/restore compare `pattern.commercialVersion` immediately after locking. Void first loads the owned row: if already void, it returns the current DTO without a version comparison or new change event; otherwise it compares both versions. A successful transaction validates the rule matrix, writes the authorization, increments `commercialVersion`, claims operation ID, obtains `changeSeq`, writes `ChangeLog`, then returns an exact DTO.

- [x] **Step 3: Implement create and edit semantics**

Create validates active field ownership, date, amount, history confirmation and kind/field shape. Edit first checks record `version`, then validates the proposed full row against the active set excluding its own ID. Changing field updates `fieldNameSnapshot`; changing kind to global buyout sets `fieldId=null` and snapshot null.

```ts
const proposed = {
  ...current,
  ...patch,
  fieldId: patch.kind === "global_buyout" ? null : patch.fieldId,
  fieldNameSnapshot: patch.kind === "global_buyout" ? null : selectedField.name,
};
await assertAuthorizationSetIsValid({ proposed, active: activeRows.filter((row) => row.id !== current.id), historyConfirmed });
```

- [x] **Step 4: Implement void and restore semantics**

Void changes active to void and sets `voidedAt`; an already-void record returns its current DTO without a second change event. Restore validates the archived field is still selectable, reruns exclusivity and buyout rules, sets active and clears `voidedAt`. A conflict returns `AUTHORIZATION_RESTORE_CONFLICT` without mutation.

```ts
if (record.status === "void") return toAuthorizationDto(record);
assertExpectedVersions(record, pattern, input);
const next = action === "void"
  ? { status: "void" as const, voidedAt: now }
  : { status: "active" as const, voidedAt: null };
```

- [x] **Step 5: Prove serialization under concurrency and commit**

Run two database connections with barriers so a standard grant and buyout target the same version concurrently. Assert only the transaction that acquires a valid state commits and no illegal final set exists.

```bash
npm run test:integration -- src/features/authorizations/authorization-service.integration.test.ts src/features/authorizations/authorization-concurrency.integration.test.ts
npm run typecheck
npm run lint
git add src/features/authorizations
git commit -m "feat: enforce authorization transactions"
```

## Task 4: Expose Authorization and Field APIs

**Files:**
- Create: `src/app/api/authorization-fields/route.ts`
- Create: `src/app/api/authorization-fields/[fieldId]/route.ts`
- Create: `src/app/api/patterns/[patternId]/authorizations/route.ts`
- Create: `src/app/api/authorizations/[authorizationId]/route.ts`
- Create: `src/app/api/authorizations/[authorizationId]/void/route.ts`
- Create: `src/app/api/authorizations/[authorizationId]/restore/route.ts`
- Test: `src/app/api/authorization-fields/route.test.ts`
- Test: `src/app/api/patterns/[patternId]/authorizations/route.test.ts`
- Test: `src/app/api/authorizations/[authorizationId]/route.test.ts`

- [x] **Step 1: Write failing transport and authorization tests**

Test 401 without a session, 400 for invalid money/date/type/field combinations, 404 for cross-owner IDs, 409 for every stable business code, and 200 replay for duplicate operation IDs. Assert a request body containing `ownerId` cannot redirect ownership.

Use this create payload in the happy-path test:

```ts
const payload = {
  operationId: crypto.randomUUID(),
  commercialVersion: 0,
  kind: "standard",
  fieldId: systemFieldId,
  licenseeName: "示例客户",
  priceYuan: "1280.00",
  authorizedOn: "2026-10-08",
  note: "首批授权",
  historyConfirmed: false,
};
```

- [x] **Step 2: Implement Zod transport schemas and DTO conversion**

Create and edit transport schemas accept `priceYuan` as a string, parse on the server, and never accept `priceFen` from the browser. DTOs return `priceFen` and aggregate money as base-10 strings plus display-ready yuan strings. Dates remain `YYYY-MM-DD` strings, not midnight timestamps.

```ts
export const authorizationInputSchema = z.object({
  operationId: z.string().uuid(),
  commercialVersion: z.number().int().nonnegative(),
  version: z.number().int().nonnegative().optional(),
  kind: z.enum(["standard", "field_exclusive", "global_buyout"]),
  fieldId: z.string().uuid().nullable(),
  licenseeName: z.string().trim().min(1).max(100),
  priceYuan: z.string(),
  authorizedOn: z.iso.date(),
  note: z.string().max(1000).nullable().default(null),
  historyConfirmed: z.boolean().default(false),
});
```

- [x] **Step 3: Implement thin authenticated handlers**

Every handler uses `requireUser`, validates path params and body, delegates to one service method, and returns stable error JSON through `withRoute`. List history uses cursor pagination ordered by `authorizedOn desc, createdAt desc, id desc` and supports `includeVoid=false` by default.

```ts
export const POST = withRoute(async (request: Request, context: RouteContext) => {
  const user = await requireUser();
  const { patternId } = patternParams.parse(await context.params);
  const input = authorizationInputSchema.parse(await request.json());
  return Response.json(await createAuthorization({ ownerId: user.id, patternId, input }), { status: 201 });
});
```

- [x] **Step 4: Verify and commit the API surface**

```bash
npm test -- src/app/api/authorization-fields src/app/api/patterns/'[patternId]'/authorizations src/app/api/authorizations
npm run typecheck
npm run lint
git add src/app/api/authorization-fields src/app/api/patterns/'[patternId]'/authorizations src/app/api/authorizations
git commit -m "feat: expose authorization APIs"
```

Expected: all transport tests pass and no response contains a JavaScript `bigint`.

## Task 5: Build Authorization Fields Settings and the Pattern Inspector

**Files:**
- Create: `src/features/authorizations/api.ts`, `query-keys.ts`
- Create: `src/features/authorizations/field-settings.tsx`, `authorization-tab.tsx`
- Create: `src/features/authorizations/authorization-form.tsx`, `authorization-row.tsx`
- Create: `src/features/authorizations/history-confirmation.tsx`, `money-input.tsx`
- Modify: `src/features/library/inspector.tsx`
- Create: `src/app/(workspace)/settings/page.tsx`
- Test: `src/features/authorizations/field-settings.test.tsx`
- Test: `src/features/authorizations/authorization-form.test.tsx`, `authorization-tab.test.tsx`

- [ ] **Step 1: Install form dependencies and write failing component tests**

```bash
npm install react-hook-form @hookform/resolvers
```

Test the segmented kind control, conditional field combobox, RMB precision, future-date rejection, required customer, optional 1,000-character note, create-custom-field command, second confirmation and stale-version refresh. Assert void records are hidden until the “显示作废记录” switch is enabled.

- [ ] **Step 2: Implement field settings**

Show system fields with a lock icon and custom fields with an archive action. Creation trims and previews the normalized name; archive uses a confirmation dialog that states historical records remain. Archived fields are absent from new forms but can still appear in history snapshots.

```tsx
return fields.map((field) => (
  <div key={field.id} className="field-row">
    {field.scope === "system" ? <Lock aria-label="系统领域" /> : null}
    <span>{field.name}</span>
    {field.scope === "custom" ? <IconButton label="归档领域" onClick={() => confirmArchive(field)}><Archive /></IconButton> : null}
  </div>
));
```

- [ ] **Step 3: Implement the authorization form**

Use a three-segment control for ordinary/exclusive/buyout. Ordinary and exclusive render a searchable field combobox; buyout removes it from form values. `MoneyInput` retains the user's decimal string and submits only after server-compatible validation. The form receives `commercialVersion` and record `version`, generates an operation ID once per submission intent, and reuses it on network retry.

```ts
const formSchema = authorizationInputSchema.superRefine((value, context) => {
  if (value.kind === "global_buyout" && value.fieldId !== null) context.addIssue({ code: "custom", path: ["fieldId"], message: "买断不选择领域" });
  if (value.kind !== "global_buyout" && value.fieldId === null) context.addIssue({ code: "custom", path: ["fieldId"], message: "请选择授权领域" });
});
```

When the server returns `AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED`, open a dialog listing existing effective count and recent records. Resubmit the same values and operation intent with `historyConfirmed=true` only after explicit confirmation. A stale-state response closes confirmation, refetches the whole tab and requires a new user action.

- [ ] **Step 4: Add inspector tabs and mutation behavior**

Use Radix Tabs with “基本信息” and “商业授权”. The commercial tab renders status, lifetime effective income, effective count, add action and paged history. Edit/void/restore live in each row menu. Mutations invalidate pattern detail, active library lists, authorization history and dashboard keys only after success; there is no optimistic commercial write.

```ts
await Promise.all([
  queryClient.invalidateQueries({ queryKey: queryKeys.pattern(patternId) }),
  queryClient.invalidateQueries({ queryKey: ["patterns"] }),
  queryClient.invalidateQueries({ queryKey: authorizationKeys.history(patternId) }),
  queryClient.invalidateQueries({ queryKey: ["authorization-dashboard"] }),
]);
```

- [ ] **Step 5: Verify accessibility and commit**

```bash
npm test -- src/features/authorizations/field-settings.test.tsx src/features/authorizations/authorization-form.test.tsx src/features/authorizations/authorization-tab.test.tsx
npm run typecheck
npm run lint
git add package.json package-lock.json src/features/authorizations src/features/library/inspector.tsx src/app/'(workspace)'/settings
git commit -m "feat: add authorization management UI"
```

Expected: all operations work by keyboard, form errors focus their fields, and commercial state is never conveyed by color alone.

## Task 6: Add Commercial Summaries and Library Filters

**Files:**
- Modify: `src/features/patterns/contracts.ts`, `pattern-repository.ts`, `pattern-service.ts`
- Modify: `src/features/library/query-state.ts`, `library-toolbar.tsx`, `pattern-card.tsx`
- Test: `src/features/patterns/commercial-summary.integration.test.ts`
- Test: `src/features/library/commercial-filters.test.tsx`

- [ ] **Step 1: Write failing summary and filter tests**

Seed unlicensed, standard, exclusive and bought-out patterns plus void rows. Assert one summary per pattern with priority `buyout > exclusive > standard > unlicensed`, effective count, and integer-string revenue. Filter by one commercial state and one field ID; void rows must not match.

The component test round-trips this URL:

```text
/library?commercialState=field_exclusive&authorizationField=00000000-0000-4000-8000-000000000003
```

- [ ] **Step 2: Extend the list query without N+1 requests**

Join one grouped authorization subquery by `(ownerId, patternId)` that computes active count, total `priceFen`, flags for each kind, and distinct active field IDs. Keep `ownerId` as the first index/predicate. Commercial field filtering uses active authorization rows; card summaries never trigger per-card API calls.

```sql
select pattern_id,
       count(*) as authorization_count,
       sum(price_fen) as revenue_fen,
       bool_or(kind = 'global_buyout') as has_buyout,
       bool_or(kind = 'field_exclusive') as has_exclusive
from authorizations
where owner_id = $1 and status = 'active'
group by pattern_id
```

- [ ] **Step 3: Render restrained status and metrics**

Pattern cards display at most one status icon/text plus effective count and formatted income. Use neutral gray for unlicensed and the semantic standard/exclusive/buyout tokens. Do not cover or tint the artwork. Add select-menu filters for commercial state and field, using system/custom field names rather than free text.

```ts
const statusPresentation = {
  unlicensed: { label: "未授权", color: "var(--text-muted)" },
  standard: { label: "普通授权", color: "var(--status-standard)" },
  field_exclusive: { label: "领域独占", color: "var(--status-exclusive)" },
  global_buyout: { label: "全局买断", color: "var(--status-buyout)" },
} satisfies Record<CommercialState, { label: string; color: string }>;
```

- [ ] **Step 4: Verify pagination stability and commit**

```bash
npm run test:integration -- src/features/patterns/commercial-summary.integration.test.ts
npm test -- src/features/library/commercial-filters.test.tsx src/features/library/query-state.test.ts
npm run typecheck
npm run lint
git add src/features/patterns src/features/library
git commit -m "feat: add commercial library summaries"
```

Expected: a 50-card page uses one list query, cursor pagination remains stable, and commercial filters persist in the URL.

## Task 7: Implement Indexed Dashboard Aggregates

**Files:**
- Create: `src/features/analytics/contracts.ts`, `date-ranges.ts`
- Create: `src/features/analytics/dashboard-repository.ts`, `dashboard-service.ts`
- Create: `src/app/api/dashboard/authorizations/route.ts`
- Test: `src/features/analytics/date-ranges.test.ts`
- Test: `src/features/analytics/dashboard-service.integration.test.ts`
- Test: `src/app/api/dashboard/authorizations/route.test.ts`

- [ ] **Step 1: Write failing date-range and aggregate tests**

Freeze today at `2026-10-08` and assert:

```ts
expect(resolveRange({ preset: "current_year" }, today)).toMatchObject({ start: "2026-01-01", end: "2026-10-08", compareStart: "2025-01-01", compareEnd: "2025-10-08" });
expect(resolveRange({ preset: "all_time" }, today).comparison).toBeNull();
expect(resolveTrendGranularity({ start: "2026-09-01", end: "2026-10-08" })).toBe("day");
```

Seed data across boundaries and assert income, count including zero-price records, distinct patterns, average, prior-period delta, trend buckets, field ranking, current state buckets and top patterns. Void rows are excluded; trashed patterns remain in period metrics/rankings but not current status; permanently deleted rows are absent.

- [ ] **Step 2: Define an integer-safe response contract**

```ts
export type DashboardDto = {
  range: { start: string | null; end: string; comparison: { start: string; end: string } | null };
  metrics: { revenueFen: string; count: number; patternCount: number; averageFen: string; comparisonPercent: string | null };
  trend: Array<{ bucket: string; revenueFen: string; count: number }>;
  currentStates: Array<{ state: CommercialState; patternCount: number }>;
  fields: Array<{ fieldId: string; fieldName: string; count: number; revenueFen: string }>;
  topPatterns: Array<{ patternId: string; patternName: string; lifecycle: "library" | "trash"; count: number; revenueFen: string }>;
};
```

All money fields are decimal strings. Average rounds half-up to the nearest fen with bigint arithmetic, then the UI formats two decimals; comparison percentage uses a decimal string and is null when no comparison or zero base.

- [ ] **Step 3: Implement range and trend rules exactly**

Current year compares year-to-date with the same dates last year. Last 12 months compares the immediately preceding 12 months. Custom compares the immediately preceding equal number of inclusive days. All-time has no comparison. Custom ≤62 days groups by day, ≤2 years by month, and longer by year; current-year/last-12-month group by month; all-time uses month up to two years and year beyond it.

```ts
export function resolveTrendGranularity(range: DateRange, preset: DashboardPreset): "day" | "month" | "year" {
  const days = inclusiveDayCount(range.start, range.end);
  if (preset === "custom" && days <= 62) return "day";
  return days <= 731 ? "month" : "year";
}
```

- [ ] **Step 4: Implement PostgreSQL aggregate queries**

Use separate focused queries inside one read transaction: period metrics/comparison, trend, current states, field ranking and top patterns. Every query begins with owner scope and active authorization status. Apply optional kind/field filters to period metrics, trend and rankings, but never to current-state buckets. Return archived field snapshot names. Limit both rankings to 10 with stable ties by revenue, latest authorized date and name.

```ts
return db.transaction(async (tx) => ({
  metrics: await queryPeriodMetrics(tx, ownerId, filters),
  trend: await queryTrend(tx, ownerId, filters),
  currentStates: await queryCurrentStates(tx, ownerId),
  fields: await queryFieldRanking(tx, ownerId, filters, 10),
  topPatterns: await queryTopPatterns(tx, ownerId, filters, 10),
}));
```

- [ ] **Step 5: Verify plans and commit**

```bash
npm test -- src/features/analytics/date-ranges.test.ts src/app/api/dashboard/authorizations/route.test.ts
npm run test:integration -- src/features/analytics/dashboard-service.integration.test.ts
npm run typecheck
npm run lint
git add src/features/analytics src/app/api/dashboard
git commit -m "feat: add authorization dashboard aggregates"
```

Expected: all boundary fixtures match exactly and the JSON response contains no `bigint`.

## Task 8: Build the Accessible Dashboard UI

**Files:**
- Create: `src/features/analytics/dashboard-view.tsx`, `dashboard-filters.tsx`
- Create: `src/features/analytics/kpi-strip.tsx`, `revenue-trend.tsx`
- Create: `src/features/analytics/current-state-chart.tsx`, `ranking-table.tsx`
- Create: `src/app/(workspace)/dashboard/page.tsx`
- Modify: `src/features/library/sidebar.tsx`
- Test: `src/features/analytics/dashboard-view.test.tsx`
- Test: `src/features/analytics/revenue-trend.test.tsx`

- [ ] **Step 1: Install the chart library and write failing UI tests**

```bash
npm install recharts
```

Test current-year default, all-time comparison omission, custom inclusive dates, filters, `¥0` empty state, no fabricated line when there is no data, visible value labels, keyboard-readable data table, trash labels and library/trash drill-down URLs.

- [ ] **Step 2: Build the unframed dashboard layout**

Use one page band with compact heading/filter row, four KPI cells separated by borders, a wide trend region, a current-state region, then two ranking tables. Do not wrap page sections in cards. Use 6 px maximum radius only for genuine chart/tool frames. Keep headings between 15 and 22 px and preserve a hint of lower content without a hero block.

```tsx
return <main className="dashboard"><DashboardFilters /><KpiStrip /><section className="trend"><RevenueTrend /></section><section className="status"><CurrentStateChart /></section><section className="rankings"><FieldRanking /><PatternRanking /></section></main>;
```

- [ ] **Step 3: Render charts with accessible fallbacks**

Recharts receives formatted numeric values derived safely from integer strings within supported display range while raw strings remain authoritative. Trend uses indigo; current-state uses neutral/green/gold/red tokens. Every chart has a sibling semantic table or list with the same values, an accessible name, and focusable data points; tooltip hover is never the only reading method.

```tsx
return <figure aria-labelledby="revenue-trend-title"><ResponsiveContainer><LineChart data={chartData}><Line dataKey="revenueYuan" stroke="var(--primary)" /></LineChart></ResponsiveContainer><TrendDataTable rows={rows} /></figure>;
```

- [ ] **Step 4: Implement URL-backed filters and drill-down**

Persist preset/custom dates, field and kind in search params. Clicking a field navigates to `/library?authorizationField=<id>`. Clicking a live pattern navigates to `/library?selected=<id>`; a trashed pattern navigates to `/trash?selected=<id>`. Current-state chart filters only the library and does not alter the dashboard's fixed “截至今日” population.

```ts
export const patternDrilldownHref = (row: DashboardDto["topPatterns"][number]) => `${row.lifecycle === "trash" ? "/trash" : "/library"}?selected=${encodeURIComponent(row.patternId)}`;
export const fieldDrilldownHref = (fieldId: string) => `/library?authorizationField=${encodeURIComponent(fieldId)}`;
```

- [ ] **Step 5: Verify both themes and commit**

```bash
npm test -- src/features/analytics/dashboard-view.test.tsx src/features/analytics/revenue-trend.test.tsx
npm run typecheck
npm run lint
git add package.json package-lock.json src/features/analytics src/app/'(workspace)'/dashboard src/features/library/sidebar.tsx
git commit -m "feat: add commercial dashboard UI"
```

Expected: tests pass in light and dark theme renderings with no text-only color dependence or fake empty-state data.

## Task 9: Implement Trash and Permanent Commercial Deletion Semantics

**Files:**
- Create: `src/features/patterns/trash-service.ts`, `deletion-service.ts`
- Create: `src/app/api/patterns/[patternId]/trash/route.ts`
- Create: `src/app/api/patterns/[patternId]/restore/route.ts`
- Create: `src/app/api/patterns/[patternId]/deletion-impact/route.ts`
- Create: `src/app/api/patterns/[patternId]/permanent-delete/route.ts`
- Create: `src/app/(workspace)/trash/page.tsx`, `src/features/library/trash-view.tsx`
- Test: `src/features/patterns/trash-service.integration.test.ts`
- Test: `src/features/patterns/deletion-service.integration.test.ts`
- Test: `src/features/library/trash-view.test.tsx`

- [ ] **Step 1: Write failing lifecycle and race tests**

Prove that trashing preserves authorizations and period revenue, excludes the pattern from current-library state, makes commercial history read-only, and restores all data. Permanent deletion must remove active/void authorizations, assets, pattern-tag links and old commercial change payloads; scrub the pattern into a final deleted tombstone; and reduce historical dashboard values.

Use concurrent transactions to prove an authorization write cannot commit after the pattern becomes trashed and a restore cannot race past permanent deletion.

```ts
expect(await dashboardRevenue(ownerId)).toBe("250000");
await trashPattern({ ownerId, patternId, version });
expect(await dashboardRevenue(ownerId)).toBe("250000");
expect(await currentStateContains(patternId)).toBe(false);
await permanentDeletePattern({ ownerId, patternId, version: version + 1 });
expect(await dashboardRevenue(ownerId)).toBe("0");
```

- [ ] **Step 2: Implement trash and restore under the pattern row lock**

Trash locks `(ownerId, patternId)`, requires `ready`, changes to `trashed`, sets `trashedAt`, increments normal pattern version and appends a change. Restore locks the same row, requires `trashed`, returns to `ready`, clears `trashedAt` and appends a change. Authorization service already checks `ready`, so trashed commercial history becomes read-only.

```ts
const next = action === "trash"
  ? { status: "trashed" as const, trashedAt: now }
  : { status: "ready" as const, trashedAt: null };
await updateLockedPattern(tx, pattern.id, pattern.version, next);
```

- [ ] **Step 3: Calculate and present deletion impact**

The impact endpoint returns effective count, effective revenue as a string, total records including void, asset count and `purgeOn = trashedAt + 30 days`. Both the initial trash confirmation and trash view state: “永久删除后，授权历史和过去看板收入也会删除。” Manual permanent delete requires typing the pattern name or an explicit destructive confirmation, and only works online.

```ts
export type DeletionImpactDto = {
  activeAuthorizationCount: number;
  activeRevenueFen: string;
  totalAuthorizationCount: number;
  assetCount: number;
  purgeOn: string;
};
```

- [ ] **Step 4: Implement idempotent permanent deletion**

Load trashed pattern/version and asset keys, delete OSS objects first through an idempotent adapter call, then open a transaction and lock the pattern again. Abort if it was restored or changed. Delete authorization rows and their commercial `ChangeLog` entries, delete asset/tag relations, scrub user metadata, set `status=deleted`/`deletedAt`, increment change sequence, and insert one final pattern deletion tombstone without commercial payload. Repeating the operation returns the existing deleted result.

```ts
await oss.deleteObjects(assetKeys);
return db.transaction(async (tx) => {
  const pattern = await lockOwnedPattern(tx, ownerId, patternId);
  if (pattern.status === "deleted") return { patternId, status: "deleted" as const };
  assertStillTrashedAtVersion(pattern, expectedVersion);
  await purgePatternBusinessRows(tx, ownerId, patternId);
  return writeDeletedPatternTombstone(tx, pattern, now);
});
```

The 30-day scheduler is wired in phase 04; this task exposes the same service for manual deletion and future job calls.

- [ ] **Step 5: Verify C semantics and commit**

```bash
npm run test:integration -- src/features/patterns/trash-service.integration.test.ts src/features/patterns/deletion-service.integration.test.ts
npm test -- src/features/library/trash-view.test.tsx
npm run typecheck
npm run lint
git add src/features/patterns src/app/api/patterns src/app/'(workspace)'/trash src/features/library/trash-view.tsx
git commit -m "feat: enforce pattern deletion lifecycle"
```

Expected: 30-day recovery preserves records, permanent deletion removes them, and historical aggregates recalculate from remaining rows.

## Task 10: Verify Commercial Workflows and Query Performance

**Files:**
- Create: `src/test/fixtures/authorization-seed.ts`
- Create: `scripts/seed-performance.ts`
- Create: `tests/e2e/commercial-authorizations.spec.ts`, `dashboard.spec.ts`
- Create: `docs/verification/2026-10-08-commercial-authorizations.md`
- Modify: `README.md`, `package.json`

- [ ] **Step 1: Write end-to-end commercial journeys**

Cover repeated ordinary licensing in one field, field-exclusive confirmation and blocking, other-field allowance, global-buyout confirmation and blocking, edit, void, restore conflict, custom field creation/archive, stale-version refresh, trash read-only behavior, restore, and permanent-delete impact. A second user cannot read or mutate any IDs from the first.

```ts
test("enforces exclusive and buyout history", async ({ page }) => {
  await createAuthorization(page, { kind: "standard", field: "家居服", price: "1000" });
  await createAuthorization(page, { kind: "field_exclusive", field: "家居服", price: "5000", confirmHistory: true });
  await expect(createAuthorization(page, { kind: "standard", field: "家居服", price: "100" })).rejects.toThrow(/已独占/);
  await createAuthorization(page, { kind: "standard", field: "文具纸品", price: "800" });
});
```

- [ ] **Step 2: Add deterministic dashboard journeys**

Seed known dates/prices, select each date preset and field/kind filter, and assert KPI text, trend accessible table, current-state counts, rankings and drill-down URLs. Run every dashboard journey in light and dark mode at 1440×900 and a smoke pass at 1024×1366.

```ts
for (const theme of ["light", "dark"] as const) {
  await setTheme(page, theme);
  await page.goto("/dashboard?range=current_year");
  await expect(page.getByText("¥18,800.00")).toBeVisible();
  await expect(page.getByRole("table", { name: "收入趋势数据" })).toBeVisible();
}
```

- [ ] **Step 3: Seed and inspect target-scale queries**

Generate 10,000 patterns and 100,000 authorization rows for one test owner without network or OSS objects. Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for period metrics, trend, current state, field ranking and top patterns. Store summarized plans in the verification document and fail the script when a large table uses an unexpected unbounded sequential scan.

Add the executable script before running it:

```json
{ "scripts": { "seed:performance": "tsx scripts/seed-performance.ts" } }
```

- [ ] **Step 4: Run the phase gate**

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
npm run seed:performance
```

Expected: every command exits 0, commercial browser journeys pass in Chromium/WebKit, and query plans use the intended owner/date/status indexes.

- [ ] **Step 5: Record evidence and commit**

```bash
git add scripts/seed-performance.ts src/test/fixtures tests/e2e docs/verification/2026-10-08-commercial-authorizations.md README.md package.json package-lock.json
git commit -m "test: verify commercial authorization milestone"
git status --short --branch
```

Expected: clean branch and a complete online commercial workflow ready for professional preview work.
