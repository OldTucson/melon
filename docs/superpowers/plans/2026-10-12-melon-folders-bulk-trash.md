# Melon Folders, Bulk Selection, and Trash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add single-folder pattern ownership, nested folder CRUD, atomic multi-pattern actions, recoverable folder-tree deletion, and a durable trash/purge workflow while keeping the library compact, tenant-safe, and responsive.

**Architecture:** PostgreSQL remains the source of truth. Folders are virtual metadata; OSS keys never change when a pattern moves. All mutations are owner-scoped, version-checked, idempotent through `operations`, and emit one `changeSeq` per user action. Folder deletion creates one recoverable batch for the complete subtree; permanent deletion uses a resumable database claim, OSS cleanup, and tombstone finalization state machine.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, PostgreSQL, Drizzle ORM, Zod, TanStack Query, Zustand, Radix UI, Lucide, Vitest, Testing Library, and Playwright. Run repository commands with Node 24.

---

## Prerequisites and Fixed Decisions

- Work directly on `main`, as explicitly approved by the product owner.
- Start from commit `f9fb493` or a later descendant containing the approved design at `docs/superpowers/specs/2026-10-12-melon-folders-bulk-trash-design.md`.
- Keep every change tenant-scoped by `ownerId`; never trust owner, counts, paths, or OSS keys from request payloads.
- A pattern has one nullable `folderId`; moving never copies or renames an OSS object.
- Editable bulk pattern states are exactly `ready` and `failed`. Uploading states continue to be managed by the upload queue.
- A folder-tree trash batch is indivisible. An ordinary pattern trash batch supports partial restore and partial purge.
- A destructive mutation waits for server confirmation before removing data from the client cache.
- Do not add folder drag/drop, reparenting, custom sorting, smart folders, or bulk tag editing in this plan.

Use this command shape throughout when the current shell is not already Node 24:

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/folders/contracts.test.ts'
```

## File Map

```text
drizzle/0002_melon_folders_bulk_trash.sql     # generated schema migration
drizzle/meta/                                 # generated Drizzle journal and snapshot
scripts/cleanup-trash.ts                      # resumable 30-day cleanup entry point
src/app/(workspace)/library/page.tsx          # parses folder-aware library query
src/app/(workspace)/trash/page.tsx            # trash workspace
src/app/api/folders/                          # list/create/rename/trash/impact endpoints
src/app/api/patterns/batch/route.ts            # atomic pattern actions
src/app/api/trash/                             # list/restore/purge endpoints
src/features/folders/                          # contracts, repository, services, folder tree UI
src/features/library/                          # selection, toolbar, folder picker, dialogs, styles
src/features/patterns/                         # folder-aware reads and batch writes
src/features/trash/                            # trash read model, restore and purge state machine
src/lib/db/schema/folders.ts                   # folder data model
src/lib/db/schema/patterns.ts                  # folder/trash fields and deleting status
src/lib/db/operation.ts                        # explicit pending/complete replay helpers
src/lib/query/keys.ts                          # folders and trash cache keys
src/test/database.ts                           # test reset includes folders
src/test/fake-oss.ts                           # deterministic delete failure/retry support
tests/e2e/folders-trash.spec.ts                # product workflow coverage
```

## Task 1: Add the Folder and Trash Database Model

**Files:**
- Create: `src/lib/db/schema/folders.ts`
- Modify: `src/lib/db/schema/patterns.ts`
- Modify: `src/lib/db/schema/index.ts`
- Modify: `src/test/database.ts`
- Create: `src/lib/db/schema/folders.integration.test.ts`
- Generate: `drizzle/0002_melon_folders_bulk_trash.sql`
- Generate: `drizzle/meta/0002_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [x] **Step 1: Write the failing migration smoke test**

Create a raw-schema test that does not import a not-yet-created TypeScript module:

```ts
it("creates folders and the pattern location columns", async () => {
  const [result] = await db.execute<{ folders: string | null }>(sql`
    select to_regclass('public.folders')::text as folders
  `);
  expect(result?.folders).toBe("folders");

  const columns = await db.execute<{ column_name: string }>(sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'patterns'
      and column_name in ('folder_id', 'trash_batch_id', 'pre_trash_status')
  `);
  expect(columns.map((row) => row.column_name).sort()).toEqual([
    "folder_id",
    "pre_trash_status",
    "trash_batch_id",
  ]);
});
```

Run:

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/lib/db/schema/folders.integration.test.ts'
```

Expected: FAIL because `folders` and the three pattern columns do not exist.

- [x] **Step 2: Define the folder table and invariants**

Create `src/lib/db/schema/folders.ts` with these exported statuses and columns:

```ts
export const folderStatuses = ["active", "trashed", "deleting", "deleted"] as const;
export const folderStatusEnum = pgEnum("folder_status", folderStatuses);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    status: folderStatusEnum("status").notNull().default("active"),
    version: integer("version").notNull().default(0),
    trashBatchId: uuid("trash_batch_id"),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    changeSeq: bigint("change_seq", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("folders_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      name: "folders_owner_parent_fk",
      columns: [table.ownerId, table.parentId],
      foreignColumns: [table.ownerId, table.id],
    }),
    check("folders_parent_not_self", sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
    uniqueIndex("folders_owner_root_name_live_unique")
      .on(table.ownerId, table.normalizedName)
      .where(sql`${table.parentId} is null and ${table.status} <> 'deleted'::folder_status`),
    uniqueIndex("folders_owner_parent_name_live_unique")
      .on(table.ownerId, table.parentId, table.normalizedName)
      .where(sql`${table.parentId} is not null and ${table.status} <> 'deleted'::folder_status`),
    index("folders_owner_parent_status_idx").on(table.ownerId, table.parentId, table.status),
    index("folders_owner_trash_batch_idx").on(table.ownerId, table.trashBatchId),
  ],
);
```

Use the existing schema style and import `check`, `foreignKey`, and `uniqueIndex` from `drizzle-orm/pg-core`.

- [x] **Step 3: Extend patterns for single-folder ownership and trash state**

Make these targeted changes in `src/lib/db/schema/patterns.ts`:

```ts
export const patternStatuses = [
  "draft", "hashing", "uploading", "processing", "ready", "failed",
  "trashed", "deleting", "deleted",
] as const;

folderId: uuid("folder_id"),
trashBatchId: uuid("trash_batch_id"),
preTrashStatus: patternStatusEnum("pre_trash_status"),
```

Add the tenant-safe folder foreign key and query indexes:

```ts
foreignKey({
  name: "patterns_owner_folder_fk",
  columns: [table.ownerId, table.folderId],
  foreignColumns: [folders.ownerId, folders.id],
}),
index("patterns_owner_folder_status_updated_idx").on(
  table.ownerId,
  table.folderId,
  table.status,
  table.updatedAt,
  table.id,
),
index("patterns_owner_trash_batch_idx").on(table.ownerId, table.trashBatchId),
```

Export `folders` from `src/lib/db/schema/index.ts` and add `"folders"` to the test reset after `"patterns"`; the reset statement's existing `CASCADE` handles dependency order.

- [x] **Step 4: Generate and inspect the migration**

```bash
npx --yes --package=node@24 -c 'npm run db:generate -- --name melon_folders_bulk_trash'
git diff -- drizzle src/lib/db/schema src/test/database.ts
```

Inspect that the migration:

- creates `folder_status` and appends `deleting` to `pattern_status`;
- creates `folders` before adding the pattern foreign key;
- leaves existing pattern rows with `folder_id = null`;
- adds both composite foreign keys and both partial name indexes;
- does not drop or rewrite existing tables.

- [x] **Step 5: Add database constraint tests and migrate both database shapes**

Extend the integration test to prove:

```ts
await expect(insertFolder({ ownerId: alice.id, parentId: bobFolder.id })).rejects.toThrow();
await expect(insertFolder({ ownerId: alice.id, parentId: sameId, id: sameId })).rejects.toThrow();
await expect(insertPattern({ ownerId: alice.id, folderId: bobFolder.id })).rejects.toThrow();
await expect(insertFolder({ ownerId: alice.id, parentId: null, normalizedName: "flora" })).rejects.toThrow();
```

Also prove the same normalized name is accepted beneath different parents and is reusable only after the prior folder reaches `deleted`.

Run the migration against the existing development database, then create an empty disposable `_test` database and run all migrations from zero. Do not drop a database unless its name ends in `_test`.

```bash
npx --yes --package=node@24 -c 'npm run db:migrate'
docker compose exec -T postgres dropdb --if-exists -U melon melon_migration_test
docker compose exec -T postgres createdb -U melon melon_migration_test
DATABASE_URL=postgres://melon:melon@localhost:55432/melon_migration_test npx --yes --package=node@24 -c 'npm run db:migrate'
docker compose exec -T postgres dropdb -U melon melon_migration_test
npx --yes --package=node@24 -c 'npm run test:integration -- src/lib/db/schema/folders.integration.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
```

Expected: schema tests and typecheck PASS.

- [x] **Step 6: Commit the schema slice**

```bash
git add drizzle src/lib/db/schema src/test/database.ts
git commit -m "feat: add folder and trash data model"
```

## Task 2: Define Folder, Batch, and Trash Contracts

**Files:**
- Create: `src/features/folders/contracts.ts`
- Create: `src/features/folders/contracts.test.ts`
- Create: `src/features/patterns/batch-contracts.ts`
- Create: `src/features/patterns/batch-contracts.test.ts`
- Create: `src/features/trash/contracts.ts`
- Create: `src/features/trash/contracts.test.ts`
- Modify: `src/features/patterns/contracts.ts`
- Create: `src/features/patterns/contracts.test.ts`
- Modify: `src/lib/http/app-error.ts`

- [x] **Step 1: Write failing contract tests**

Cover Unicode normalization, name bounds, query exclusivity, unique IDs, the 100-item limit, and action-specific payload fields:

```ts
expect(parseFolderName("  SUMMER\u0301  ")).toEqual({
  name: "SUMME\u0154",
  normalizedName: "summe\u0155",
});
expect(() => patternQuerySchema.parse({ folderId: id, unfiled: true })).toThrow();
expect(() => patternBatchMutationSchema.parse({
  operationId,
  action: "move",
  patterns: [{ id, version: 0 }, { id, version: 0 }],
  folderId: null,
})).toThrow();
expect(() => patternBatchMutationSchema.parse({
  operationId,
  action: "trash",
  patterns: Array.from({ length: 101 }, (_, index) => ({ id: ids[index]!, version: 0 })),
})).toThrow();
```

Use a real set of 101 UUID fixtures rather than invalid placeholder strings.

Run:

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/folders/contracts.test.ts src/features/patterns/batch-contracts.test.ts src/features/trash/contracts.test.ts src/features/patterns/contracts.test.ts'
```

Expected: FAIL because the new schemas and query fields are missing.

- [x] **Step 2: Implement exact folder schemas**

```ts
export const folderNameInputSchema = z.string().trim().min(1).max(80).refine(hasNoNullByte);

export function parseFolderName(input: string) {
  const name = folderNameInputSchema.parse(input).normalize("NFC");
  return { name, normalizedName: name.toLowerCase() };
}

export const folderCreateMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  input: z.object({ name: folderNameInputSchema, parentId: z.string().uuid().nullable() }),
});

export const folderRenameMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  patch: z.object({ name: folderNameInputSchema, version: z.number().int().nonnegative() }),
});

export const folderTrashMutationSchema = z.object({
  operationId: publicOperationIdSchema,
  version: z.number().int().nonnegative(),
});
```

- [x] **Step 3: Implement the discriminated batch union**

```ts
const patternRefSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
});

const uniquePatterns = z.array(patternRefSchema).min(1).max(100).superRefine((items, ctx) => {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    ctx.addIssue({ code: "custom", message: "Pattern IDs must be unique" });
  }
});

export const patternBatchMutationSchema = z.discriminatedUnion("action", [
  z.object({ operationId: publicOperationIdSchema, action: z.literal("move"), patterns: uniquePatterns, folderId: z.string().uuid().nullable() }),
  z.object({ operationId: publicOperationIdSchema, action: z.literal("trash"), patterns: uniquePatterns }),
  z.object({ operationId: publicOperationIdSchema, action: z.literal("favorite"), patterns: uniquePatterns, isFavorite: z.boolean() }),
]);
```

Export `parsePatternBatchMutation(input: unknown)` as the only public parser. It converts a Zod `too_big` issue on `patterns` into `new AppError("BATCH_LIMIT_EXCEEDED", 400, "A batch can contain at most 100 patterns")`; all other schema failures become the standard validation error. Both the route and service use this helper, so direct service calls cannot bypass the runtime limit.

Add restore and purge schemas that require a new `operationId`, unique pattern IDs for ordinary pattern actions, and only `trashBatchId` for folder-batch actions. Give their array parsers the same explicit batch-limit mapping.

- [x] **Step 4: Extend the pattern query contract explicitly**

Add:

```ts
folderId: z.string().uuid().optional(),
unfiled: queryBoolean.optional(),
includeDescendants: queryBoolean.default(true),
scope: z.enum(["library", "trash"]).default("library"),
```

Refine the object so `folderId` and `unfiled=true` are mutually exclusive. Parse and serialize all four values; `scope=trash` must not be used by the library page because `/trash` has its own grouped read model.

- [x] **Step 5: Add public error codes and verify**

Add these exact `AppErrorCode` values:

```ts
| "BATCH_LIMIT_EXCEEDED"
| "FOLDER_BATCH_ACTION_REQUIRED"
| "FOLDER_NAME_CONFLICT"
| "FOLDER_NOT_ACTIVE"
| "FOLDER_NOT_FOUND"
| "FOLDER_STATE_CHANGED"
| "OSS_DELETE_FAILED"
| "TRASH_BATCH_NOT_FOUND"
| "TRASH_PURGE_IN_PROGRESS"
```

Run:

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/folders/contracts.test.ts src/features/patterns/batch-contracts.test.ts src/features/trash/contracts.test.ts src/features/patterns/contracts.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/folders src/features/patterns src/features/trash src/lib/http/app-error.ts
git commit -m "feat: define folder batch and trash contracts"
```

Expected: contract tests and typecheck PASS.

## Task 3: Implement Folder CRUD and Recursive Counts

**Files:**
- Create: `src/features/folders/folder-repository.ts`
- Create: `src/features/folders/folder-service.ts`
- Create: `src/features/folders/folder-service.integration.test.ts`

- [x] **Step 1: Write failing service tests**

Test root creation, child creation, nested counts, rename, same-parent conflicts, different-parent duplicates, inactive-parent rejection, stale versions, tenant isolation, idempotent replay, and reused operation IDs:

```ts
const created = await createFolder({ ownerId, operationId, name: "  花园  ", parentId: null });
expect(created).toMatchObject({ name: "花园", normalizedName: "花园", parentId: null, version: 0 });

const replay = await createFolder({ ownerId, operationId, name: "  花园  ", parentId: null });
expect(replay).toEqual(created);

await expect(renameFolder({ ownerId, folderId: created.id, operationId: nextId, name: "花园 2", version: 9 }))
  .rejects.toMatchObject({ code: "FOLDER_STATE_CHANGED" });
```

For recursive counts, place one active pattern in the parent and two in a child; expect `directPatternCount=1` and `recursivePatternCount=3` on the parent.

Run and expect missing service failures:

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/folders/folder-service.integration.test.ts'
```

- [x] **Step 2: Implement owner-scoped repository primitives**

The repository exposes only these operations:

```ts
export type FolderRow = typeof folders.$inferSelect;
export function listActiveFolderRows(ownerId: string): Promise<FolderCountRow[]>;
export function lockFolderRow(ownerId: string, tx: DbTransaction, folderId: string): Promise<FolderRow | undefined>;
export function insertFolderRow(ownerId: string, tx: DbTransaction, input: InsertFolderInput): Promise<FolderRow | undefined>;
export function renameFolderRow(ownerId: string, tx: DbTransaction, input: RenameFolderInput): Promise<FolderRow | undefined>;
```

Compute recursive counts in PostgreSQL with a `WITH RECURSIVE descendants` CTE, and count only library-visible pattern states:

```ts
export const libraryPatternStatuses = [
  "draft", "hashing", "uploading", "processing", "ready", "failed",
] as const;
```

Every lookup predicate contains both `ownerId` and the entity ID. Child creation locks the parent `FOR UPDATE` and requires `status='active'`.

- [x] **Step 3: Implement idempotent create and rename services**

Both services follow this transaction order:

```ts
const operation = await claimOperation(ownerId, tx, operationId, operationKey);
if (operation.state === "replay") return operation.result as FolderDto;
if (operation.state === "mismatch") throw new AppError("OPERATION_ID_REUSED", 409, "Operation ID was already used");
const seq = await nextChangeSeq(tx, ownerId);
```

Create uses `randomUUID()`, normalized NFC lowercase name, one `changeLog` event `folder.created`, and one stored result. Rename locks the folder, validates `active` plus the supplied version, increments version, emits `folder.updated`, and maps PostgreSQL unique violation `23505` from either live-name index to `FOLDER_NAME_CONFLICT`.

- [x] **Step 4: Verify and commit**

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/folders/folder-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/folders
git commit -m "feat: add folder CRUD services"
```

## Task 4: Expose Folder APIs and Delete Impact Preview

**Files:**
- Create: `src/app/api/folders/route.ts`
- Create: `src/app/api/folders/route.test.ts`
- Create: `src/app/api/folders/[folderId]/route.ts`
- Create: `src/app/api/folders/[folderId]/route.test.ts`
- Create: `src/app/api/folders/[folderId]/delete-impact/route.ts`
- Create: `src/app/api/folders/[folderId]/delete-impact/route.test.ts`
- Modify: `src/features/folders/folder-repository.ts`
- Modify: `src/features/folders/folder-service.ts`

- [x] **Step 1: Write failing route tests**

Mock `requireUser` and service boundaries, then verify:

```ts
const listResponse = await GET(new Request("http://app.test/api/folders"));
expect(listResponse.status).toBe(200);
expect(folderService.listFolders).toHaveBeenCalledWith({ ownerId: user.id });
expect((await POST(validCreateRequest)).status).toBe(201);
expect((await PATCH(validRenameRequest, routeContext)).status).toBe(200);
```

Also verify malformed UUID/body returns `400`, an `AppError` preserves its public code/status, and no route accepts `ownerId` from JSON.

- [x] **Step 2: Implement the non-mutating impact query**

Add:

```ts
export type FolderDeleteImpact = {
  folderCount: number;
  patternCount: number;
  alreadyTrashedFolderCount: number;
  alreadyTrashedPatternCount: number;
  hasDeletingEntities: boolean;
};
```

Resolve the subtree with a recursive CTE including `active`, `trashed`, and `deleting` rows. Count all non-`deleted` patterns whose `folderId` is in that subtree. This endpoint is preview-only and performs no locking; the delete service in Task 7 recomputes everything under locks.

- [x] **Step 3: Implement thin authenticated routes**

Use the existing pattern:

```ts
export const POST = withRoute(async (request: Request) => {
  const user = await requireUser();
  const mutation = folderCreateMutationSchema.parse(await readJson(request));
  return Response.json(await createFolder({
    ownerId: user.id,
    operationId: mutation.operationId,
    name: mutation.input.name,
    parentId: mutation.input.parentId,
  }), { status: 201 });
});
```

Keep route files free of transaction logic. This task adds list, create, rename, and impact handlers only; Task 7 adds `DELETE` together with its real cascading service so the branch never contains a production route backed by a stub.

- [x] **Step 4: Verify and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/app/api/folders/route.test.ts src/app/api/folders/[folderId]/route.test.ts src/app/api/folders/[folderId]/delete-impact/route.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/folders/folder-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/app/api/folders src/features/folders
git commit -m "feat: expose folder APIs"
```

## Task 5: Make Pattern Reads Folder-Aware and Status-Explicit

**Files:**
- Modify: `src/features/patterns/contracts.ts`
- Modify: `src/features/patterns/pattern-repository.ts`
- Modify: `src/features/patterns/pattern-service.ts`
- Modify: `src/features/patterns/pattern-service.integration.test.ts`
- Modify: `src/features/tags/tag-repository.ts`
- Modify: `src/features/tags/pattern-tag-service.integration.test.ts`
- Modify: `src/features/library/query-state.ts`
- Modify: `src/features/library/query-state.test.ts`
- Modify: `src/features/library/library-types.ts`
- Modify: `src/app/(workspace)/library/page.tsx`

- [x] **Step 1: Write failing repository/service tests**

Seed a parent, child, unrelated folder, unfiled patterns, and every pattern status. Assert:

```ts
expect(ids(await listPatterns({ ownerId, input: { folderId: parent.id, includeDescendants: true } })))
  .toEqual([parentPattern.id, childPattern.id]);
expect(ids(await listPatterns({ ownerId, input: { folderId: parent.id, includeDescendants: false } })))
  .toEqual([parentPattern.id]);
expect(ids(await listPatterns({ ownerId, input: { unfiled: true } })))
  .toEqual([unfiledPattern.id]);
expect(allLibraryItems).not.toContainEqual(expect.objectContaining({ status: "deleting" }));
```

Add query-state tests proving round-trip serialization for `folderId` and `includeDescendants=false`, and proving `unfiled=true` excludes `folderId`.

- [x] **Step 2: Replace negative status filtering with allowlists**

In `listPatternRows`, replace:

```ts
notInArray(patterns.status, ["trashed", "deleted"])
```

with:

```ts
query.scope === "trash"
  ? inArray(patterns.status, ["trashed", "deleting"])
  : inArray(patterns.status, ["draft", "hashing", "uploading", "processing", "ready", "failed"])
```

Use `eq(patterns.folderId, query.folderId)` for direct scope and a recursive folder CTE for descendants. `unfiled=true` adds `isNull(patterns.folderId)`. Resolve folder scope with `ownerId` in every recursive term so another tenant's UUID can never broaden the query.

- [x] **Step 3: Return location and trash metadata in the DTO**

Add these exact properties in `toPatternDto` and `PatternItem`:

```ts
folderId: row.folderId,
trashBatchId: row.trashBatchId,
preTrashStatus: row.preTrashStatus,
```

Type `status` as the schema-derived pattern status union rather than generic `string`. Keep OSS URLs out of the DTO.

- [x] **Step 4: Close existing mutation paths during permanent deletion**

Add regression tests proving a `deleting` pattern cannot be renamed, favorited, or have tag relations added/removed. Keep trashed detail readable for the trash service, but change write predicates from “not deleted” to “not deleting and not deleted”. Return `PATTERN_STATE_CHANGED` for a pattern patch that was locked before its state changed; tag relation endpoints retain their neutral `NOT_FOUND` behavior.

- [x] **Step 5: Wire page parsing and verify**

The server page parses the new search params through `parsePatternSearchParams`. The client serializer omits defaults (`includeDescendants=true`, `scope=library`) to keep URLs concise, but retains explicit `false`.

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/library/query-state.test.ts src/features/patterns/contracts.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/patterns/pattern-service.integration.test.ts src/features/tags/pattern-tag-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/patterns src/features/tags src/features/library src/app/'(workspace)'/library/page.tsx
git commit -m "feat: filter patterns by folder"
```

## Task 6: Implement Atomic Pattern Batch Actions

**Files:**
- Create: `src/features/patterns/pattern-batch-repository.ts`
- Create: `src/features/patterns/pattern-batch-service.ts`
- Create: `src/features/patterns/pattern-batch-service.integration.test.ts`
- Create: `src/app/api/patterns/batch/route.ts`
- Create: `src/app/api/patterns/batch/route.test.ts`

- [x] **Step 1: Write the failing all-or-none tests**

Cover move, favorite, trash, target-folder validation, mixed ownership, stale version, invalid status, duplicate IDs, idempotent replay, and deadlock-safe input ordering. The critical rollback assertion is:

```ts
await expect(batchPatterns({
  ownerId,
  mutation: {
    operationId,
    action: "move",
    patterns: [
      { id: first.id, version: first.version },
      { id: second.id, version: second.version + 1 },
    ],
    folderId: target.id,
  },
})).rejects.toMatchObject({ code: "PATTERN_STATE_CHANGED" });

expect(await readPattern(first.id)).toMatchObject({ folderId: first.folderId, version: first.version });
```

For trash, assert one shared `trashBatchId=operationId`, preserved `folderId`, `preTrashStatus` set to the prior status, and no OSS calls.

- [x] **Step 2: Implement stable row locking and validation**

The repository accepts sorted unique IDs and executes one owner-scoped select with `FOR UPDATE`. The service then validates exact cardinality, versions, and status:

```ts
const editablePatternStatuses = new Set(["ready", "failed"] as const);
const sortedRefs = [...mutation.patterns].sort((left, right) => left.id.localeCompare(right.id));
const rows = await lockPatternRows(ownerId, tx, sortedRefs.map((item) => item.id));
if (rows.length !== sortedRefs.length) throw new AppError("NOT_FOUND", 404, "Pattern not found");
for (const ref of sortedRefs) {
  const row = byId.get(ref.id)!;
  if (row.version !== ref.version || !editablePatternStatuses.has(row.status as "ready" | "failed")) {
    throw new AppError("PATTERN_STATE_CHANGED", 409, "Pattern state changed");
  }
}
```

For `move`, lock the target folder and require `active`. For `favorite`, set one boolean. For `trash`, set `status='trashed'`, `preTrashStatus` from the locked row, `trashBatchId=operationId`, and one shared `trashedAt`.

- [x] **Step 3: Emit one event and one shared sequence**

Allocate one `changeSeq`, update every row with it, increment each version, and write one change log row:

```ts
await tx.insert(changeLog).values({
  ownerId,
  seq,
  operationId: mutation.operationId,
  entityType: "pattern_batch",
  entityId: mutation.operationId,
  operation: mutation.action === "move"
    ? "patterns.moved"
    : mutation.action === "trash"
      ? "patterns.trashed"
      : "patterns.favorited",
  payload: { patternIds: sortedRefs.map((item) => item.id) },
});
```

The stored operation result contains fresh DTOs in deterministic ID order.

- [x] **Step 4: Add the route and verify**

`POST /api/patterns/batch` calls `parsePatternBatchMutation`, derives `ownerId` from session, and delegates to `batchPatterns`.

```bash
npx --yes --package=node@24 -c 'npm test -- src/app/api/patterns/batch/route.test.ts src/features/patterns/batch-contracts.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/patterns/pattern-batch-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/patterns src/app/api/patterns/batch
git commit -m "feat: add atomic pattern batch actions"
```

## Task 7: Implement Cascading Folder Trash

**Files:**
- Create: `src/features/folders/folder-trash-repository.ts`
- Create: `src/features/folders/folder-trash-service.ts`
- Create: `src/features/folders/folder-trash-service.integration.test.ts`
- Modify: `src/features/folders/folder-repository.ts`
- Modify: `src/features/folders/folder-service.ts`
- Modify: `src/app/api/folders/[folderId]/route.ts`
- Modify: `src/app/api/folders/[folderId]/route.test.ts`

- [x] **Step 1: Write failing cascade and merge tests**

Build a three-level tree containing active and already-trashed descendants and patterns. Assert one deletion produces:

```ts
const result = await trashFolderTree({
  ownerId,
  folderId: root.id,
  operationId,
  version: root.version,
});

expect(result).toEqual({
  state: "trashed",
  trashBatchId: operationId,
  rootFolderId: root.id,
  folderCount: 3,
  patternCount: 4,
});
const subtree = await readSubtree(root.id);
expect(subtree.every((row) =>
  row.status === "trashed" && row.trashBatchId === operationId,
)).toBe(true);
```

Prove an already-trashed pattern preserves its existing `preTrashStatus`, but receives the new batch and timestamp. Prove any `deleting` folder or pattern aborts the entire transaction. Prove stale root version, cross-tenant root, and replay-with-different-payload fail with public errors.

- [x] **Step 2: Serialize folder-structure mutations for one owner**

Add a transaction-scoped advisory lock used by create-child and cascade-delete before reading the hierarchy:

```ts
export async function lockFolderHierarchy(ownerId: string, tx: DbTransaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`);
}
```

Keep the existing row lock on the direct parent as a local invariant. The advisory lock closes the snapshot race in which a new grandchild commits while a recursive delete is resolving descendants.

- [x] **Step 3: Implement recursive lookup and deterministic locks**

The repository resolves every non-deleted descendant with an owner-scoped recursive CTE, sorts IDs, then locks folders and patterns in stable UUID order. It returns this complete locked aggregate:

```ts
export type LockedFolderTree = {
  folders: FolderRow[];
  patterns: PatternRow[];
};
```

The service rejects an empty root as `FOLDER_NOT_FOUND`, a non-active root as `FOLDER_NOT_ACTIVE`, root version mismatch as `FOLDER_STATE_CHANGED`, and any `deleting` row as `TRASH_PURGE_IN_PROGRESS`.

- [x] **Step 4: Apply the batch in one transaction**

For every folder, set `status='trashed'`, the new `trashBatchId`, shared `trashedAt`, shared `changeSeq`, incremented version, and `updatedAt`. For every pattern:

```ts
preTrashStatus: sql`case
  when ${patterns.status} = 'trashed'::pattern_status then ${patterns.preTrashStatus}
  else ${patterns.status}
end`,
status: "trashed",
trashBatchId: operationId,
trashedAt: now,
version: sql`${patterns.version} + 1`,
changeSeq: seq,
updatedAt: now,
```

Write one `folder_tree.trashed` change event containing root ID plus sorted folder and pattern IDs. Store the exact count result for idempotent replay. Do not mutate assets, tags, or OSS.

- [x] **Step 5: Prove create/delete concurrency and wire the route**

Use two real database connections and a test barrier. Start child creation while tree deletion holds the hierarchy lock; after both settle, assert either the child was committed before the delete and is trashed with the tree, or creation observed the trashed parent and failed. It must never leave an active descendant under a trashed ancestor.

Replace the mocked `DELETE` boundary with the real service.

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/folders/folder-trash-service.integration.test.ts src/features/folders/folder-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm test -- src/app/api/folders/[folderId]/route.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/folders src/app/api/folders
git commit -m "feat: trash complete folder trees"
```

## Task 8: Build the Trash Read Model and Restore Services

**Files:**
- Create: `src/features/trash/trash-repository.ts`
- Create: `src/features/trash/trash-service.ts`
- Create: `src/features/trash/trash-service.integration.test.ts`
- Create: `src/app/api/trash/route.ts`
- Create: `src/app/api/trash/route.test.ts`
- Create: `src/app/api/trash/patterns/restore/route.ts`
- Create: `src/app/api/trash/patterns/restore/route.test.ts`
- Create: `src/app/api/trash/folder-batches/[trashBatchId]/restore/route.ts`
- Create: `src/app/api/trash/folder-batches/[trashBatchId]/restore/route.test.ts`

- [x] **Step 1: Write failing grouped-read and restore tests**

Cover these observable cases:

```ts
expect(await listTrash({ ownerId })).toEqual({
  folderBatches: [expect.objectContaining({
    trashBatchId: folderBatchId,
    rootFolderName: "夏日果园",
    folderCount: 3,
    patternCount: 4,
  })],
  patternBatches: [expect.objectContaining({
    trashBatchId: patternBatchId,
    patterns: expect.arrayContaining([expect.objectContaining({ id: loosePattern.id })]),
  })],
});
```

Also prove:

- a folder batch can restore only as a whole;
- its complete hierarchy and original pattern `folderId` values remain intact;
- a root whose outside parent is no longer active cannot restore;
- an ordinary pattern batch can restore a chosen subset;
- a pattern belonging to a folder batch returns `FOLDER_BATCH_ACTION_REQUIRED`;
- a `deleting` entity returns `TRASH_PURGE_IN_PROGRESS`;
- every restore is tenant-isolated, version-independent from the stale library UI, and idempotent by operation ID.

- [x] **Step 2: Implement the grouped trash read model**

Classify a batch as a folder batch when at least one non-deleted folder has its `trashBatchId`. Find the root as the batch folder whose parent is outside the batch. Compute expiration from the minimum batch `trashedAt`:

```ts
expiresAt: new Date(earliestTrashedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
```

Return only `trashed` and `deleting` rows. Return explicit `state: 'trashed' | 'deleting'`, aggregated nullable `lastErrorCode`, and nullable `purgeOperationId` so the UI never infers progress from missing data and can resume a failed purge after reload. Task 9 populates `purgeOperationId` by associating pending operation results with their target. Sort batches by most recent `trashedAt`, then `trashBatchId` for stable rendering.

- [x] **Step 3: Implement ordinary pattern restore**

Parse 1–100 unique pattern IDs, lock them in stable order, require all rows to be `trashed`, and reject any batch present in the folder-batch lookup. Reject a null `preTrashStatus`, then restore each pattern to its required prior state:

```ts
if (row.preTrashStatus === null) {
  throw new AppError("PATTERN_STATE_CHANGED", 409, "Pattern state changed");
}
const restoredStatus = row.preTrashStatus;
const restorePatch = {
  status: restoredStatus,
  preTrashStatus: null,
  trashBatchId: null,
  trashedAt: null,
  lastErrorCode: null,
  version: sql`${patterns.version} + 1`,
  changeSeq: seq,
  updatedAt: now,
};
```

Clear selection-specific batch membership only for restored patterns, leaving the rest of an ordinary batch intact.

- [x] **Step 4: Implement atomic folder-batch restore**

Lock every folder and pattern in the batch. Reject missing, partial, `deleting`, or `deleted` data. Resolve the batch root and verify its outside parent is either null or currently `active` for the same owner. Restore all folders to `active`; restore all patterns from `preTrashStatus`; clear batch/timestamps/errors; increment versions; write one `folder_tree.restored` event and one stored result.

Because live-name uniqueness reserves names while folders are trashed, a valid restore cannot collide with a newly created sibling. Still translate a database unique violation into `FOLDER_NAME_CONFLICT` as a defensive boundary.

- [x] **Step 5: Add routes and verify**

`GET /api/trash` reads only the session owner. Pattern restore accepts `{ operationId, patternIds }`. Folder restore accepts `{ operationId }` and derives `trashBatchId` from the path.

```bash
npx --yes --package=node@24 -c 'npm test -- src/app/api/trash/route.test.ts src/app/api/trash/patterns/restore/route.test.ts src/app/api/trash/folder-batches/[trashBatchId]/restore/route.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/trash/trash-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/trash src/app/api/trash
git commit -m "feat: list and restore trash batches"
```

## Task 9: Implement Resumable Permanent Deletion

**Files:**
- Modify: `src/lib/db/operation.ts`
- Create: `src/lib/db/operation.test.ts`
- Modify: `src/test/fake-oss.ts`
- Modify: `src/test/fake-oss.test.ts`
- Create: `src/features/trash/trash-purge-repository.ts`
- Create: `src/features/trash/trash-purge-service.ts`
- Create: `src/features/trash/trash-purge-service.integration.test.ts`
- Modify: `src/features/trash/trash-repository.ts`
- Modify: `src/features/trash/trash-service.ts`
- Create: `src/app/api/trash/patterns/purge/route.ts`
- Create: `src/app/api/trash/patterns/purge/route.test.ts`
- Create: `src/app/api/trash/folder-batches/[trashBatchId]/purge/route.ts`
- Create: `src/app/api/trash/folder-batches/[trashBatchId]/purge/route.test.ts`
- Create: `scripts/cleanup-trash.ts`
- Modify: `package.json`

- [x] **Step 1: Write failing operation-state and OSS retry tests**

Add a typed result union:

```ts
type PurgeOperationResult =
  | { state: "pending"; target: PurgeTarget }
  | { state: "complete"; deletedPatternCount: number; deletedFolderCount: number };
```

Test the three phases independently:

1. Claim sets all target rows to `deleting` and persists `state='pending'`.
2. An injected OSS failure leaves rows `deleting`, assets intact, and stores `OSS_DELETE_FAILED`.
3. Replaying the same operation resumes deletion, removes all objects, and finalizes tombstones exactly once.

Make `FakeOssAdapter` record delete calls and support deterministic failures:

```ts
readonly deleteCalls: string[][] = [];
failDeleteCall: number | null = null;
```

Assert 1,001 object keys produce two calls and that an already-missing object is success.

- [x] **Step 2: Make pending replay explicit**

Keep `claimOperation` backward compatible, and add exact helpers:

```ts
export async function readOperation(ownerId: string, operationId: string): Promise<OperationRow | undefined>;
export async function listPendingOperations(kindPrefix: string): Promise<OperationRow[]>;
```

Store `{ state: 'pending', target }` in the claim transaction before returning to network I/O. A replay with `state='complete'` returns immediately; a replay with `state='pending'` runs the continuation. Never interpret `{}` as completed purge work.

Extend the grouped trash read model to match each deleting target to its pending operation and return that operation's ID as `purgeOperationId`. This makes retry after a browser refresh resume the original idempotent operation.

- [x] **Step 3: Implement the claim phase**

For ordinary pattern purge, reject patterns tied to a folder batch. For folder purge, lock the complete batch. Both require `trashed`; replay continuation also accepts the same rows already in `deleting`. Set `status='deleting'`, retain `trashBatchId`, set `lastErrorCode=null` on patterns, and persist the target in the operation result in the same transaction.

The pending target contains IDs and kind, not object keys or credentials:

```ts
type PurgeTarget =
  | { kind: "patterns"; patternIds: string[] }
  | { kind: "folder_batch"; trashBatchId: string };
```

- [x] **Step 4: Implement OSS cleanup and tombstone finalization**

Outside the transaction, load object keys from owned asset rows and call the existing `OssAdapter.deleteObjects`; it already chunks to the OSS maximum. On failure, update only `lastErrorCode='OSS_DELETE_FAILED'` and throw `new AppError('OSS_DELETE_FAILED', 502, 'OSS object deletion failed')`.

After OSS succeeds, start a new transaction, relock the exact target, and verify every pattern remains `deleting`. Delete current relational rows in this order:

```text
pattern_tags -> assets -> pattern tombstones
```

Do not delete the pattern row. Update it to a minimal tombstone: `status='deleted'`, clear `folderId`, `trashBatchId`, `preTrashStatus`, hashes and errors, set `deletedAt`, increment version, and retain identity/name/timestamps required by sync. Mark folder rows `deleted`, clear batch and parent references after descendants have been finalized, set `deletedAt`, and retain identity/name. Emit one `patterns.deleted` or `folder_tree.deleted` change event and store `{ state:'complete', counts }`.

- [x] **Step 5: Add purge routes and the 30-day cleanup command**

Both endpoints call the same service used by maintenance. `scripts/cleanup-trash.ts` loads server environment, finds expired `trashed` batches and pending purge operations, and processes them sequentially with isolated error reporting. Generate a fresh operation ID only for a newly expired batch; resume pending operations with their stored operation ID.

Add:

```json
"trash:cleanup": "node --conditions=react-server --import tsx scripts/cleanup-trash.ts"
```

The script exits nonzero if any batch remains failed, making scheduler failures visible.

- [x] **Step 6: Verify and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/lib/db/operation.test.ts src/test/fake-oss.test.ts src/app/api/trash/patterns/purge/route.test.ts src/app/api/trash/folder-batches/[trashBatchId]/purge/route.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/trash/trash-purge-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/lib/db/operation.ts src/lib/db/operation.test.ts src/test/fake-oss.ts src/test/fake-oss.test.ts src/features/trash src/app/api/trash scripts/cleanup-trash.ts package.json
git commit -m "feat: permanently purge trashed patterns"
```

## Task 10: Finish Multi-Selection and Client Batch Mutations

**Files:**
- Modify: `src/features/library/selection-store.ts`
- Modify: `src/features/library/selection-store.test.ts`
- Modify: `src/features/library/pattern-card.tsx`
- Modify: `src/features/library/pattern-grid.tsx`
- Create: `src/features/library/pattern-batch-mutations.ts`
- Create: `src/features/library/pattern-batch-mutations.test.tsx`
- Create: `src/features/library/bulk-action-bar.tsx`
- Create: `src/features/library/bulk-action-bar.test.tsx`
- Create: `src/features/library/trash-patterns-dialog.tsx`
- Modify: `src/features/library/library-view.tsx`
- Modify: `src/features/library/library-view.test.tsx`
- Modify: `src/lib/query/keys.ts`

- [x] **Step 1: Write failing selection tests**

Extend the Zustand store contract with `selectAll` and `removeSelected`. Test plain click, Command/Ctrl toggle, Shift range, all loaded items, query reset, and explicit selection marks:

```ts
store.getState().selectAll(["a", "b", "c"]);
expect(store.getState().selectedIds).toEqual(["a", "b", "c"]);
store.getState().removeSelected(["b", "c"]);
expect(store.getState().selectedIds).toEqual(["a"]);
```

Render the grid and assert selected cards expose a checked checkbox with an accessible label such as `选择 图案名称`; do not rely only on `data-selected` or border color.

- [x] **Step 2: Implement stable selection actions**

Add:

```ts
selectAll: (orderedIds) => set({
  anchorId: orderedIds.at(-1) ?? null,
  selectedIds: [...orderedIds],
}),
removeSelected: (ids) => set((state) => {
  const removed = new Set(ids);
  const selectedIds = state.selectedIds.filter((id) => !removed.has(id));
  return {
    selectedIds,
    anchorId: state.anchorId && removed.has(state.anchorId) ? (selectedIds[0] ?? null) : state.anchorId,
    previewId: state.previewId && removed.has(state.previewId) ? null : state.previewId,
  };
}),
```

Keep “全选” scoped to `orderedIds`, which contains only pages already loaded by the infinite query.

Add `ctrlKey?: boolean` to `SelectionModifiers`, treat `metaKey || ctrlKey` as additive selection, and forward both event flags from `PatternCard`. This keeps Command behavior on macOS and Ctrl behavior on Windows/Linux aligned.

- [x] **Step 3: Write failing mutation/cache tests**

Mock `fetch` and Query Client. Assert the hook:

- reuses one generated `operationId` while retrying the same user action;
- sends selected IDs with their current versions;
- waits for server success before removing trashed rows;
- invalidates patterns, folders, individual selected patterns, and trash;
- restores snapshots on failed move/favorite optimistic updates;
- clears only successfully affected selection IDs.

- [x] **Step 4: Implement the batch mutation hook**

Add cache keys:

```ts
folders: (ownerId: string) => ["owner", ownerId, "folders"] as const,
trash: (ownerId: string) => ["owner", ownerId, "trash"] as const,
```

`usePatternBatchMutation(activeQuery)` posts to `/api/patterns/batch`. Move and favorite may optimistically update with a complete query snapshot. Trash has no optimistic removal. Generate `operationId` in the click handler and keep it in mutation variables so React Query retries the identical request.

- [x] **Step 5: Build the bulk action bar and delete confirmation**

The bar appears between heading and grid whenever `selectedIds.length > 0`. It contains stable-size controls for:

```text
[checked count] [Move] [Favorite] [Unfavorite] [Trash] [Clear]
```

Use Lucide icons and tooltips. The destructive action opens a Radix dialog showing the exact count. Confirm calls the server; cancel changes nothing. On success show an in-workspace status notice with “撤销”; the undo action calls `/api/trash/patterns/restore` with a new operation ID and the returned pattern IDs.

- [x] **Step 6: Verify and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/library/selection-store.test.ts src/features/library/pattern-batch-mutations.test.tsx src/features/library/bulk-action-bar.test.tsx src/features/library/library-view.test.tsx'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/library src/lib/query/keys.ts
git commit -m "feat: add library bulk selection actions"
```

## Task 11: Build the Nested Folder Tree and Folder CRUD UI

**Files:**
- Create: `src/features/folders/folder-tree-model.ts`
- Create: `src/features/folders/folder-tree-model.test.ts`
- Create: `src/features/folders/folder-tree.tsx`
- Create: `src/features/folders/folder-tree.test.tsx`
- Create: `src/features/folders/folder-mutations.ts`
- Create: `src/features/folders/folder-mutations.test.tsx`
- Create: `src/features/folders/folder-delete-dialog.tsx`
- Modify: `src/features/library/sidebar.tsx`
- Modify: `src/features/library/sidebar.test.tsx`
- Modify: `src/features/library/library-view.tsx`
- Modify: `src/features/library/library-view.test.tsx`
- Modify: `src/features/library/workspace-shell.tsx`

- [x] **Step 1: Write failing pure tree tests**

Create a pure builder that accepts the flat API response and returns deterministic roots/children without mutating input:

```ts
expect(buildFolderTree([
  folder("child", "root"),
  folder("root", null),
])).toEqual([
  expect.objectContaining({ id: "root", children: [expect.objectContaining({ id: "child" })] }),
]);
```

Sort siblings by `name.localeCompare(name, 'zh-CN')`, then ID. Detect an impossible cycle or orphan and surface it as an ungrouped diagnostic node in development rather than recursing forever.

- [x] **Step 2: Write failing folder-tree interaction tests**

Render the sidebar with nested fixtures and verify:

- expand/collapse buttons have `aria-expanded`;
- folder links encode `folderId` and preserve `includeDescendants`;
- “未分类” uses `unfiled=true`;
- the plus icon starts a root inline input;
- row menu starts child input, rename, or delete preview;
- name conflicts preserve the inline draft and show the server error;
- successful delete navigates to the nearest active outside ancestor or `/library`.

- [x] **Step 3: Implement query and mutation boundaries**

Load `FolderDto[]` once in the shared `WorkspaceShell` through `queryKeys.folders(ownerId)` so the sidebar and inspectors use one cache. Provide focused hooks:

```ts
useCreateFolderMutation();
useRenameFolderMutation();
useTrashFolderMutation();
```

Each mutation receives its `operationId` from the initiating UI event. Create and rename optimistically update the flat folder list, roll back on failure, and retain the local draft. Delete first fetches `/api/folders/:id/delete-impact`, displays current counts, then waits for the DELETE response before removing the subtree from caches.

- [x] **Step 4: Build the compact folder tree**

Use `ChevronRight`, `Folder`, `FolderOpen`, `Plus`, and `MoreHorizontal`. Rows are 30–32 px high, names truncate with a title tooltip, counts are tabular numerals, and icon buttons remain square. Keep all menu commands accessible by keyboard. Do not render folder rows as cards.

Folder navigation resets `cursor`, `unfiled`, selection, and preview while preserving filters that remain meaningful (`q`, `formats`, tags, favorite, sort). The active folder row uses `aria-current='page'`.

- [x] **Step 5: Show current folder context in the library heading**

Replace the static “全部图案” title with the active folder name or “未分类”. For a real folder, add a checkbox/toggle labeled “包含子文件夹内容”, default on, which updates `includeDescendants` without changing other filters. Query changes already clear selection through `querySignature`.

- [x] **Step 6: Verify and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/folders/folder-tree-model.test.ts src/features/folders/folder-tree.test.tsx src/features/folders/folder-mutations.test.tsx src/features/library/sidebar.test.tsx src/features/library/library-view.test.tsx'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/folders src/features/library
git commit -m "feat: add nested folder navigation"
```

## Task 12: Add Folder Pickers and the Trash Workspace

**Files:**
- Create: `src/features/folders/folder-picker.tsx`
- Create: `src/features/folders/folder-picker.test.tsx`
- Modify: `src/features/library/inspector.tsx`
- Modify: `src/features/library/library-view.tsx`
- Modify: `src/features/library/library-view.test.tsx`
- Create: `src/features/trash/trash-types.ts`
- Create: `src/features/trash/trash-mutations.ts`
- Create: `src/features/trash/trash-view.tsx`
- Create: `src/features/trash/trash-view.test.tsx`
- Create: `src/app/(workspace)/trash/page.tsx`
- Modify: `src/features/library/sidebar.tsx`
- Modify: `src/features/library/sidebar.test.tsx`

- [x] **Step 1: Write failing folder-picker tests**

The picker is a single-target control, not a checklist. Assert it presents one “未分类” option plus the active folder tree, indents nested names, prevents selecting a trashed/deleting folder, and returns `string | null`:

```ts
await user.click(screen.getByRole("radio", { name: "未分类" }));
expect(onChange).toHaveBeenLastCalledWith(null);
await user.click(screen.getByRole("radio", { name: "夏日果园 / 柑橘" }));
expect(onChange).toHaveBeenLastCalledWith(childId);
```

- [x] **Step 2: Integrate single and multi-pattern location controls**

The single-pattern inspector shows current location and a compact “移动” command using the batch API with one pattern/version. The multi-selection inspector replaces its placeholder with:

- one destination folder radio tree;
- “移动到此处”;
- “添加收藏” and “取消收藏”;
- “移入回收站”.

Disable commands while pending. If selected rows contain non-editable statuses, explain that the selection changed and require refresh rather than submitting a partial subset.

- [x] **Step 3: Write failing trash workspace tests**

Mock the grouped API and assert:

- folder batches render one row with root name, folder/pattern counts, expiry, restore, and purge;
- ordinary pattern batches expose per-pattern checkboxes and partial restore/purge;
- folder-batch patterns never expose individual actions;
- `deleting` disables restore and repeat purge;
- `OSS_DELETE_FAILED` displays “删除失败，可重试”;
- destructive purge requires a second confirmation naming the irreversible effect.

- [x] **Step 4: Implement the trash query and mutations**

Fetch `/api/trash` through `queryKeys.trash(ownerId)`. Use separate mutation functions for:

```ts
restorePatterns(operationId, patternIds);
purgePatterns(operationId, patternIds);
restoreFolderBatch(operationId, trashBatchId);
purgeFolderBatch(operationId, trashBatchId);
```

Invalidate trash, folders, and all pattern queries only after server confirmation or a purge failure that may have changed server state. While purge is in flight, keep the row visible with progress state. After failure or reload, reuse the API-provided `purgeOperationId`; do not generate a second operation for rows already in `deleting`.

- [x] **Step 5: Add `/trash` and enable navigation**

The server page renders `TrashView` inside the existing protected workspace layout. Replace the disabled sidebar entry with a real link, update active-route detection, and retain the existing dark/light theme and upload tray behavior. The empty state says “回收站是空的” and does not use a decorative card.

- [x] **Step 6: Verify and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/folders/folder-picker.test.tsx src/features/library/library-view.test.tsx src/features/trash/trash-view.test.tsx src/features/library/sidebar.test.tsx'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/features/folders src/features/library src/features/trash src/app/'(workspace)'/trash
git commit -m "feat: add folder picker and trash workspace"
```

## Task 13: Apply the Eagle-Inspired Information Density and Responsive Layout

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/features/library/topbar.tsx`
- Modify: `src/features/library/workspace-shell.tsx`
- Modify: `src/features/library/library-toolbar.tsx`
- Modify: `src/features/library/pattern-card.tsx`
- Modify: `src/features/library/inspector.tsx`
- Create: `src/features/library/mobile-panels.test.tsx`

- [ ] **Step 1: Add failing layout/accessibility assertions**

Use component tests for stable control dimensions, named icon buttons, no nested card wrappers, and mobile panel open/close semantics. Assert long Chinese/Latin folder and pattern names truncate rather than expanding their tracks.

- [ ] **Step 2: Establish the restrained visual tokens**

Update the existing CSS variables instead of introducing another styling system:

```css
:root {
  --surface-app: #f5f6f8;
  --surface-panel: #ffffff;
  --surface-hover: #f0f1f3;
  --surface-selected: #e8e9ed;
  --border-subtle: #dedfe3;
  --text-primary: #1d1e22;
  --text-secondary: #686b73;
  --accent: #4f5bd5;
  --danger: #c93636;
  --control-radius: 5px;
}

[data-theme="dark"] {
  --surface-app: #111214;
  --surface-panel: #18191c;
  --surface-hover: #222429;
  --surface-selected: #2b2e35;
  --border-subtle: #303238;
  --text-primary: #f1f2f4;
  --text-secondary: #a3a6ae;
}
```

Retain brand/accent color only for primary actions and selected checkmarks. Keep controls at 6 px radius or less. Do not add gradients, floating section cards, decorative blobs, or oversized headings.

- [ ] **Step 3: Make desktop and iPad geometry explicit**

Use stable tracks:

```css
.workspace {
  grid-template-columns: 220px minmax(0, 1fr);
}
.library-layout[data-inspector="open"] {
  grid-template-columns: minmax(0, 1fr) 292px;
}
```

At iPad landscape/portrait widths, keep the left navigation usable and turn the inspector into a dismissible side sheet or content-bottom panel. At phone widths, the folder tree becomes a sheet opened by a folder icon and the inspector becomes a bottom panel. All controls must remain inside the viewport; no horizontal document scrollbar is allowed.

- [ ] **Step 4: Verify visual states with Playwright screenshots**

Run the app against seeded data and capture at minimum:

```text
1440x1000 light library with nested folders and multi-selection
1440x1000 dark trash page
1024x768 light folder library
390x844 dark library with folder drawer and inspector panel
```

Inspect screenshots for clipping, overlapping labels, accidental nested cards, unreadable selected states, and blank preview assets. Use browser console checks for errors and evaluate `document.documentElement.scrollWidth <= window.innerWidth` at every viewport.

- [ ] **Step 5: Run component checks and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/library/mobile-panels.test.tsx src/features/library/library-view.test.tsx src/features/library/sidebar.test.tsx'
npx --yes --package=node@24 -c 'npm run typecheck'
git add src/app/globals.css src/features/library
git commit -m "style: refine the library workspace"
```

## Task 14: Add End-to-End Workflows, Documentation, and Release Gates

**Files:**
- Create: `tests/e2e/folders-trash.spec.ts`
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/prepare.ts`
- Modify: `tests/e2e/tenant-isolation.spec.ts`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing folder workflow E2E test**

Using accessible locators, cover this exact sequence:

1. Create root “夏日果园” and child “柑橘”.
2. Attempt duplicate “柑橘” under the same parent and observe the inline conflict.
3. Multi-select two seeded patterns and move them to “柑橘”.
4. Verify each pattern appears in exactly one folder and disappears from “未分类”.
5. Trash “夏日果园” and confirm the impact counts.
6. Open `/trash`, restore the single folder batch, and verify hierarchy and pattern locations.
7. Trash both patterns directly, restore only one, and verify the other remains in trash.

Run and expect FAIL before fixture/UI gaps are filled:

```bash
npx --yes --package=node@24 -c 'npm run test:e2e -- tests/e2e/folders-trash.spec.ts --project=chromium'
```

- [ ] **Step 2: Extend tenant isolation E2E coverage**

Sign in as two test users. Attempt to inject the other user's folder and pattern IDs into folder query, batch move, delete-impact, restore, and purge requests. Assert `404` or the documented neutral response and verify the victim user's folder tree, assets, and OSS objects are unchanged.

- [ ] **Step 3: Document operation and recovery**

Update `README.md` with:

- folder ownership and “未分类” behavior;
- folder cascade deletion and 30-day retention;
- `npm run trash:cleanup` deployment scheduling;
- how to retry a failed `deleting` batch;
- the rule that OSS keys are stable and objects are deleted only on purge;
- database migration procedure for both an existing and an empty database;
- a warning never to log AccessKey, STS tokens, signed URLs, or source contents.

Only add environment variables to `.env.example` if the cleanup command genuinely introduces one. Prefer the existing database and OSS configuration.

- [ ] **Step 4: Run the focused release gate**

```bash
npx --yes --package=node@24 -c 'npm test'
npx --yes --package=node@24 -c 'npm run test:integration'
npx --yes --package=node@24 -c 'npm run test:e2e -- tests/e2e/folders-trash.spec.ts tests/e2e/tenant-isolation.spec.ts --project=chromium'
npx --yes --package=node@24 -c 'npm run lint'
npx --yes --package=node@24 -c 'npm run typecheck'
npx --yes --package=node@24 -c 'npm run build'
```

Expected: every command exits 0 with no skipped folder/trash coverage and no browser console errors.

- [ ] **Step 5: Audit the implementation against the approved spec**

Manually verify all acceptance criteria in `docs/superpowers/specs/2026-10-12-melon-folders-bulk-trash-design.md`. In particular, query the database after E2E to prove:

```text
one non-null folder_id at most per pattern
one trash_batch_id across every entity in a deleted folder subtree
no OSS delete before purge
deleted patterns retained as tombstones
one change_seq and one change_log row per batch action
```

Review the final diff for secrets, unrelated refactors, generated-file omissions, and accidental API owner fields.

- [ ] **Step 6: Commit, push, and report**

```bash
git add README.md .env.example tests/e2e
git commit -m "test: cover folder and trash workflows"
git status --short --branch
git log --oneline --decorate -12
git push origin main
```

Report the pushed commit, dev URL, test commands, migration name, screenshot viewports, and any residual deployment step. Do not call the feature complete unless the full gate above has actually passed.
