# Designer Inspiration Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-demo-ready designer inspiration workspace that turns a natural-language womenswear brief into sourced, structured Qwen analysis, saves every run, and exposes revocable public read-only shares.

**Architecture:** A protected Next.js route creates a tenant-owned pending PostgreSQL record, calls Qwen in two synchronous server-only stages, validates and source-links the structured result, then stores an immutable snapshot. Authenticated APIs manage history and sharing; an uncached public Server Component reads completed snapshots only by random share UUID.

**Tech Stack:** Next.js 16.4.1 App Router, React 19.3, TypeScript 6, Zod 4, Drizzle ORM/PostgreSQL, TanStack Query 5, Vitest/Testing Library, native Node 24 `fetch`, Alibaba Cloud Model Studio DashScope.

**Spec:** `docs/superpowers/specs/2026-10-28-melon-designer-inspiration-design.md`

## Global Constraints

- Use Node.js `>=24 <25`; do not add an OpenAI or DashScope SDK dependency.
- Read the relevant local Next.js 16.4.1 guides under `node_modules/next/dist/docs/` before changing routes, Server Components, or cache behavior.
- Search with `qwen-plus`, `search_strategy: "turbo"`, `forced_search: true`, `freshness: 30`, source return, and citations.
- Structure with `qwen3.8-flash`, strict JSON Schema, and a 45-second deadline; search has a 60-second deadline.
- Treat “hot-selling” as public market signals, never as verified marketplace sales unless a source explicitly contains that fact.
- Never expose or log the API key, Authorization header, prompt, raw provider response, or source URLs.
- Keep API credentials server-only and optional unless `INSPIRATION_ENABLED=true`.
- Every authenticated database read and write must derive `ownerId` from the session and filter by it.
- Keep `/share/inspiration/[shareId]` public, read-only, uncached, and `noindex, nofollow`.
- Do not redesign the global navigation, workspace shell, or `globals.css`; use feature-scoped components and a CSS module so the parallel UI redesign can replace presentation later.
- Use TDD for each task and commit only the files listed in that task.
- Run database tests only against `postgres://melon:melon@127.0.0.1:55432/melon_test` or another database whose name ends in `_test`.

---

## File Map

### New feature files

- `src/features/inspiration/contracts.ts`: public input, result, source, list, detail, and mutation schemas/types.
- `src/features/inspiration/contracts.test.ts`: contract boundaries and strictness.
- `src/features/inspiration/test-fixtures.ts`: reusable valid sources, result, summary, and detail values for tests only.
- `src/features/inspiration/inspiration-cursor.ts`: stable history cursor encoding and decoding.
- `src/features/inspiration/qwen-prompts.ts`: fixed search and structuring system prompts.
- `src/features/inspiration/qwen-protocol.ts`: provider request construction and untrusted response parsing.
- `src/features/inspiration/qwen-protocol.test.ts`: pure provider fixture tests.
- `src/features/inspiration/qwen-provider.ts`: two-stage HTTP client, deadlines, and public provider errors.
- `src/features/inspiration/qwen-provider.test.ts`: mocked HTTP, timeout, bounds, and redaction tests.
- `src/features/inspiration/qwen-provider.real.test.ts`: opt-in real-service smoke test.
- `src/features/inspiration/analysis-repository.ts`: tenant-scoped state transitions and history queries.
- `src/features/inspiration/analysis-service.ts`: create, retry, list, detail, rename, delete, and provider orchestration.
- `src/features/inspiration/share-service.ts`: enable, revoke, and public share reads.
- `src/features/inspiration/analysis-service.integration.test.ts`: state machine, idempotency, concurrency, and isolation tests.
- `src/features/inspiration/share-service.integration.test.ts`: public share and revocation tests.
- `src/features/inspiration/query-keys.ts`: feature-local TanStack Query keys.
- `src/features/inspiration/inspiration-api.ts`: strict client reads and mutations.
- `src/features/inspiration/inspiration-view.tsx`: selected analysis and request orchestration.
- `src/features/inspiration/inspiration-prompt-form.tsx`: brief input and submit state.
- `src/features/inspiration/inspiration-history.tsx`: saved run list and status display.
- `src/features/inspiration/inspiration-result.tsx`: six dimensions, signals, references, prompts, and sources.
- `src/features/inspiration/inspiration-share-dialog.tsx`: share enable, copy, and revoke controls.
- `src/features/inspiration/shared-inspiration-page.tsx`: public read-only presentation.
- `src/features/inspiration/inspiration.module.css`: isolated responsive styles.
- `src/features/inspiration/inspiration-view.test.tsx`: authenticated workspace interactions.
- `src/features/inspiration/inspiration-result.test.tsx`: source mapping and empty-state rendering.
- `src/features/inspiration/shared-inspiration-page.test.tsx`: public-safe rendering.
- `src/lib/db/schema/inspiration-analyses.ts`: enum, table, checks, and indexes.
- `src/lib/db/schema/inspiration-analyses.integration.test.ts`: database constraints.
- `src/lib/http/bounded-json.ts`: reusable abort-aware bounded JSON reader.
- `src/lib/http/bounded-json.test.ts`: bounded reader tests.
- `src/app/(workspace)/inspiration/page.tsx`: protected workspace entry.
- `src/app/(share)/share/inspiration/[shareId]/page.tsx`: dynamic public share entry.
- `src/app/(share)/share/inspiration/[shareId]/page.test.tsx`: not-found and public metadata behavior.
- `src/app/api/inspiration-analyses/route.ts`: list and create.
- `src/app/api/inspiration-analyses/route.test.ts`: root route contract.
- `src/app/api/inspiration-analyses/[analysisId]/route.ts`: detail, rename, and delete.
- `src/app/api/inspiration-analyses/[analysisId]/route.test.ts`: owned record route contract.
- `src/app/api/inspiration-analyses/[analysisId]/retry/route.ts`: failed-run retry.
- `src/app/api/inspiration-analyses/[analysisId]/share/route.ts`: enable and revoke share.
- `src/app/api/inspiration-analyses/[analysisId]/share/route.test.ts`: share route contract.
- `scripts/import-inspiration-config.ts`: secret-safe CSV-to-`.env.local` importer for the supplied Model Studio export.
- `scripts/import-inspiration-config.test.ts`: importer parsing and preservation tests.

### Modified files

- `.env.example`: document disabled-by-default inspiration variables.
- `src/lib/env/server.ts`: validate the feature flag, models, API key, workspace, and two HTTPS base URLs.
- `src/lib/env/server.test.ts`: configuration gate and URL validation.
- `src/lib/db/schema/index.ts`: export the new table.
- `src/test/database.ts`: truncate the new table before users.
- `src/features/visual-search/internal-json.ts`: preserve the old API by delegating to the new shared bounded reader.
- `src/proxy.ts`: protect `/inspiration` only.
- `src/proxy.test.ts`: verify protected workspace and public share behavior.
- `package.json`: add an opt-in real inspiration smoke script.
- `README.md`: add local inspiration configuration and smoke-test commands without secrets.
- Generated migration files: `drizzle/0008_melon_inspiration.sql`, `drizzle/meta/0008_snapshot.json`, and `drizzle/meta/_journal.json`.

---

### Task 1: Lock the Public Contracts

**Files:**
- Create: `src/features/inspiration/contracts.ts`
- Create: `src/features/inspiration/contracts.test.ts`
- Create: `src/features/inspiration/test-fixtures.ts`

**Interfaces:**
- Produces: `inspirationCreateMutationSchema`, `inspirationListQuerySchema`, `inspirationPatchMutationSchema`, `inspirationAnalysisResultSchema`, `inspirationAnalysisJsonSchema`, `inspirationSourceSchema`, `inspirationSummaryDtoSchema`, `inspirationDetailDtoSchema`, `inspirationSharedDtoSchema`, `inspirationListDtoSchema`, and their inferred TypeScript types.
- Consumes: `publicOperationIdSchema` and `hasNoNullByte`.

- [ ] **Step 1: Write failing strict-contract tests**

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  inspirationAnalysisResultSchema,
  inspirationCreateMutationSchema,
  inspirationSourceSchema,
} from "./contracts";
import { inspirationResultFixture } from "./test-fixtures";

const facet = {
  name: "轻通勤",
  rationale: "公开商品与趋势内容重复出现",
  strength: "high" as const,
  sourceIndexes: [1],
};

describe("inspiration contracts", () => {
  it("normalizes a valid create mutation", () => {
    expect(
      inspirationCreateMutationSchema.parse({
        operationId: randomUUID(),
        prompt: "  分析近 30 天都市轻通勤女装  ",
      }).prompt,
    ).toBe("分析近 30 天都市轻通勤女装");
  });

  it("rejects ownership fields, URLs in model output, and oversized arrays", () => {
    expect(() =>
      inspirationCreateMutationSchema.parse({
        operationId: randomUUID(),
        prompt: "分析近 30 天都市轻通勤女装",
        ownerId: randomUUID(),
      }),
    ).toThrow();
    expect(() =>
      inspirationSourceSchema.parse({
        index: 1,
        title: "Bad source",
        url: "javascript:alert(1)",
        siteName: null,
      }),
    ).toThrow();
    expect(() =>
      inspirationAnalysisResultSchema.parse({
        ...inspirationResultFixture,
        marketSignals: Array.from({ length: 9 }, () => facet),
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the contract test and verify the missing-module failure**

Run: `npm test -- src/features/inspiration/contracts.test.ts`

Expected: FAIL because `./contracts` does not exist.

- [ ] **Step 3: Implement the strict schemas and exported types**

Use `.strict()` on every object, `hasNoNullByte` on every user/model display string, and these exact bounds:

```ts
const sourceIndexesSchema = z.array(z.number().int().min(1).max(100)).max(20);

export const trendFacetSchema = z
  .object({
    name: z.string().trim().min(1).max(80).refine(hasNoNullByte),
    rationale: z.string().trim().min(1).max(500).refine(hasNoNullByte),
    strength: z.enum(["high", "medium", "emerging"]),
    sourceIndexes: sourceIndexesSchema,
  })
  .strict();

export const inspirationSourceSchema = z
  .object({
    index: z.number().int().min(1).max(100),
    title: z.string().trim().min(1).max(300).refine(hasNoNullByte),
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const parsed = new URL(value);
        return (
          ["http:", "https:"].includes(parsed.protocol) &&
          parsed.username === "" &&
          parsed.password === ""
        );
      }),
    siteName: z.string().trim().min(1).max(120).refine(hasNoNullByte).nullable(),
  })
  .strict();
```

Define `colorFacetSchema`, `referenceLookSchema`, `inspirationPromptSchema`, and `inspirationAnalysisResultSchema` with the exact fields in spec section 6. Cap market signals and every dimension at 8, reference looks at 12, and prompts at 3–5. Export JSON Schema from the same Zod source with `z.toJSONSchema(inspirationAnalysisResultSchema, { target: "draft-07" })`; test that every object node has `additionalProperties: false`.

Normalize the prompt and all user-editable titles with `value.normalize("NFC")` after trimming. Restrict `colorHint` to nullable uppercase `#RRGGBB`; render code may use it directly only after schema validation.

Define summary/detail DTOs with ISO datetime strings, nullable `sources/result/shareUrl/errorCode/completedAt`, status `pending | completed | failed`, and version as a nonnegative integer. Detail DTO must not contain `ownerId`, request IDs, or provider errors. Define a separate strict `inspirationSharedDtoSchema` containing only `title`, `prompt`, `completedAt`, `sources`, and `result`; public rendering must never receive an authenticated detail DTO.

- [ ] **Step 4: Add boundary cases for duplicate source indexes and DTO secrecy**

```ts
it("rejects duplicate provider source indexes and internal DTO fields", () => {
  const first = {
    index: 1,
    title: "商品页",
    url: "https://example.test/item/1",
    siteName: "示例站",
  };
  expect(() =>
    z.array(inspirationSourceSchema).superRefine((sources, context) => {
      if (new Set(sources.map((source) => source.index)).size !== sources.length) {
        context.addIssue({ code: "custom", message: "duplicate source index" });
      }
    }).parse([first, first]),
  ).toThrow(/duplicate source index/);
});
```

Move the uniqueness refinement into an exported `inspirationSourcesSchema` capped at 20 and use it in the detail DTO.

Create `test-fixtures.ts` with one HTTPS source, one fully populated facet in each dimension, one reference look, and exactly three inspiration prompts. Export `inspirationSourceFixture`, `inspirationResultFixture`, `inspirationSummaryFixture`, and `inspirationDetailFixture`; every later test imports these values instead of creating incomplete schema objects.

- [ ] **Step 5: Run the contract tests**

Run: `npm test -- src/features/inspiration/contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the contract**

```bash
git add src/features/inspiration/contracts.ts src/features/inspiration/contracts.test.ts src/features/inspiration/test-fixtures.ts
git commit -m "feat: define inspiration analysis contracts"
```

---

### Task 2: Add the Database State Model

**Files:**
- Create: `src/lib/db/schema/inspiration-analyses.ts`
- Create: `src/lib/db/schema/inspiration-analyses.integration.test.ts`
- Modify: `src/lib/db/schema/index.ts`
- Modify: `src/test/database.ts`
- Generate: `drizzle/0008_melon_inspiration.sql`
- Generate: `drizzle/meta/0008_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `inspirationAnalysisStatuses`, `inspirationAnalysisStatusEnum`, and `inspirationAnalyses`.
- Consumes: `users` and PostgreSQL JSONB.

- [ ] **Step 1: Write failing constraint tests**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { inspirationAnalyses, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

describe("inspiration analyses schema", () => {
  const ownerId = randomUUID();

  beforeEach(async () => {
    await resetDatabase();
    await db.insert(users).values({
      id: ownerId,
      email: "inspiration-schema@example.test",
      displayName: "Designer",
      passwordHash: "hash",
      mustChangePassword: false,
    });
  });

  afterAll(closeDatabase);

  it("allows one pending analysis per owner and rejects invalid completed state", async () => {
    await db.insert(inspirationAnalyses).values({
      id: randomUUID(),
      ownerId,
      operationId: randomUUID(),
      prompt: "分析都市轻通勤女装",
      title: "分析都市轻通勤女装",
      status: "pending",
      searchModel: "qwen-plus",
      structureModel: "qwen3.8-flash",
    });
    await expect(
      db.insert(inspirationAnalyses).values({
        id: randomUUID(),
        ownerId,
        operationId: randomUUID(),
        prompt: "分析新中式女装",
        title: "分析新中式女装",
        status: "pending",
        searchModel: "qwen-plus",
        structureModel: "qwen3.8-flash",
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
  });
});
```

- [ ] **Step 2: Run the schema test and verify it fails before migration**

Run: `npm run test:integration -- src/lib/db/schema/inspiration-analyses.integration.test.ts`

Expected: FAIL because `inspirationAnalyses` is not exported.

- [ ] **Step 3: Implement the Drizzle schema with database checks**

Create the enum and table with the exact columns from spec section 7. Use `jsonb("sources").$type<unknown>()`, `jsonb("result").$type<unknown>()`, `onDelete("cascade")` on the user reference, and the following structural checks/indexes:

```ts
unique("inspiration_analyses_owner_operation_unique").on(
  table.ownerId,
  table.operationId,
),
uniqueIndex("inspiration_analyses_owner_pending_unique")
  .on(table.ownerId)
  .where(sql`${table.status} = 'pending'`),
index("inspiration_analyses_owner_updated_id_idx").on(
  table.ownerId,
  table.updatedAt,
  table.id,
),
check(
  "inspiration_analyses_prompt_length_check",
  sql`char_length(${table.prompt}) between 5 and 1000`,
),
check(
  "inspiration_analyses_title_length_check",
  sql`char_length(${table.title}) between 1 and 120`,
),
check(
  "inspiration_analyses_share_state_check",
  sql`${table.shareId} is null or ${table.status} = 'completed'`,
),
```

Add one state check that exactly permits pending, completed, and failed column combinations from spec section 7. Export the schema from `src/lib/db/schema/index.ts`, and add `"inspiration_analyses"` before `"users"` in `resetDatabase()`.

- [ ] **Step 4: Generate and inspect migration 0008**

Run: `npm run db:generate -- --name=melon_inspiration`

Expected: Drizzle creates `drizzle/0008_melon_inspiration.sql` plus snapshot/journal changes. Inspect the SQL and confirm it contains the enum, state checks, owner-operation unique constraint, partial pending index, history index, share unique constraint, and cascade user FK.

- [ ] **Step 5: Migrate the explicit test database and run schema tests**

```bash
DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_test npm run db:migrate
npm run test:integration -- src/lib/db/schema/inspiration-analyses.integration.test.ts
```

Expected: migration succeeds and test passes.

- [ ] **Step 6: Extend tests for state checks and cross-owner pending rows**

Add assertions that completed rows require sources/result/completedAt, failed rows require errorCode, shareId is completed-only, the same operation ID is allowed for another owner, and another owner may hold a pending row concurrently.

- [ ] **Step 7: Commit schema and migration**

```bash
git add src/lib/db/schema/inspiration-analyses.ts src/lib/db/schema/inspiration-analyses.integration.test.ts src/lib/db/schema/index.ts src/test/database.ts drizzle/0008_melon_inspiration.sql drizzle/meta/0008_snapshot.json drizzle/meta/_journal.json
git commit -m "feat: persist inspiration analyses"
```

---

### Task 3: Gate Server-Only Qwen Configuration

**Files:**
- Modify: `.env.example`
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`

**Interfaces:**
- Produces these `ServerEnv` fields: `INSPIRATION_ENABLED`, `DASHSCOPE_API_KEY`, `DASHSCOPE_WORKSPACE_ID`, `DASHSCOPE_OPENAI_BASE_URL`, `DASHSCOPE_NATIVE_BASE_URL`, `INSPIRATION_SEARCH_MODEL`, and `INSPIRATION_STRUCTURE_MODEL`.

- [ ] **Step 1: Write failing environment-gate tests**

```ts
const enabledInspirationEnv = {
  INSPIRATION_ENABLED: "true",
  DASHSCOPE_API_KEY: `sk-${"x".repeat(40)}`,
  DASHSCOPE_WORKSPACE_ID: "ws-demo-123",
  DASHSCOPE_OPENAI_BASE_URL:
    "https://ws-demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  DASHSCOPE_NATIVE_BASE_URL:
    "https://ws-demo.cn-beijing.maas.aliyuncs.com/api/v1",
};

it("requires complete Qwen configuration only when inspiration is enabled", () => {
  expect(parseServerEnv(validEnv).INSPIRATION_ENABLED).toBe(false);
  expect(() =>
    parseServerEnv({ ...validEnv, INSPIRATION_ENABLED: "true" }),
  ).toThrow(/DASHSCOPE_API_KEY/);
  expect(parseServerEnv({ ...validEnv, ...enabledInspirationEnv })).toMatchObject({
    INSPIRATION_ENABLED: true,
    INSPIRATION_SEARCH_MODEL: "qwen-plus",
    INSPIRATION_STRUCTURE_MODEL: "qwen3.8-flash",
  });
});
```

Add table tests rejecting HTTP, URL credentials, query, fragment, wrong Alibaba host suffix, mismatched OpenAI/native hosts, a host prefix different from the workspace ID, blank workspace, blank key, and unsupported model overrides.

- [ ] **Step 2: Run the focused environment tests**

Run: `npm test -- src/lib/env/server.test.ts`

Expected: FAIL because the new fields are absent.

- [ ] **Step 3: Implement optional variables and enabled-mode refinement**

Use `optionalBoolean`, `optionalNonBlankString`, and a new path-preserving HTTPS URL validator. Accept only hostnames equal to `maas.aliyuncs.com` or ending in `.maas.aliyuncs.com`, with no username, password, query, or fragment. After removing one trailing slash, require the OpenAI URL path to end in `/compatible-mode/v1` and the native URL path to end in `/api/v1`. When enabled, require both base URLs and the workspace/key, require the two URL hostnames to be identical, and require their first hostname label to equal `DASHSCOPE_WORKSPACE_ID`. This matches the supplied business-space export and catches crossed workspace credentials before a paid call. Restrict model overrides to:

```ts
INSPIRATION_SEARCH_MODEL: z.enum(["qwen-plus"]).default("qwen-plus"),
INSPIRATION_STRUCTURE_MODEL: z
  .enum(["qwen3.8-flash"])
  .default("qwen3.8-flash"),
```

Do not trim the API key value after validation; preserve it exactly, matching existing AccessKey handling.

- [ ] **Step 4: Document blank disabled defaults in `.env.example`**

```dotenv
INSPIRATION_ENABLED=false
DASHSCOPE_API_KEY=
DASHSCOPE_WORKSPACE_ID=
DASHSCOPE_OPENAI_BASE_URL=
DASHSCOPE_NATIVE_BASE_URL=
INSPIRATION_SEARCH_MODEL=qwen-plus
INSPIRATION_STRUCTURE_MODEL=qwen3.8-flash
```

- [ ] **Step 5: Run environment and production-readiness tests**

Run: `npm test -- src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts`

Expected: PASS; disabled defaults do not change existing readiness results.

- [ ] **Step 6: Commit configuration validation**

```bash
git add .env.example src/lib/env/server.ts src/lib/env/server.test.ts
git commit -m "feat: validate inspiration provider config"
```

---

### Task 4: Build Pure Qwen Protocol Adapters

**Files:**
- Create: `src/features/inspiration/qwen-prompts.ts`
- Create: `src/features/inspiration/qwen-protocol.ts`
- Create: `src/features/inspiration/qwen-protocol.test.ts`

**Interfaces:**
- Produces: `buildQwenSearchRequest({ prompt, model })`, `parseQwenSearchResponse(value)`, `buildQwenStructureRequest({ prompt, searchText, sources, model })`, `parseQwenStructureResponse(value, sources)`, `QwenSearchStageResult`, and `QwenStructureStageResult`.
- Consumes: contracts from Task 1.

- [ ] **Step 1: Write failing protocol fixture tests**

```ts
import { describe, expect, it } from "vitest";

import {
  buildQwenSearchRequest,
  buildQwenStructureRequest,
  parseQwenSearchResponse,
  parseQwenStructureResponse,
} from "./qwen-protocol";
import { inspirationSourceFixture } from "./test-fixtures";

it("builds the required 30-day sourced search request", () => {
  expect(
    buildQwenSearchRequest({
      prompt: "分析都市轻通勤",
      model: "qwen-plus",
    }),
  ).toMatchObject({
    model: "qwen-plus",
    parameters: {
      enable_search: true,
      result_format: "message",
      search_options: {
        search_strategy: "turbo",
        forced_search: true,
        freshness: 30,
        enable_source: true,
        enable_citation: true,
        citation_format: "[ref_<number>]",
      },
    },
  });
});

it("builds a non-thinking strict structure request without source URLs", () => {
  const request = buildQwenStructureRequest({
    prompt: "分析都市轻通勤",
    searchText: "轻通勤上升[ref_1]",
    sources: [inspirationSourceFixture],
    model: "qwen3.8-flash",
  });

  expect(request).toMatchObject({
    model: "qwen3.8-flash",
    enable_thinking: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "inspiration_analysis_v1",
        strict: true,
        schema: expect.objectContaining({
          type: "object",
          additionalProperties: false,
        }),
      },
    },
  });
  expect(JSON.stringify(request)).not.toContain(inspirationSourceFixture.url);
});

it("requires nonempty real search results", () => {
  expect(() =>
    parseQwenSearchResponse({
      output: {
        choices: [{ message: { role: "assistant", content: "结论" } }],
        search_info: { search_results: [] },
      },
      request_id: "req-search",
    }),
  ).toThrowError(expect.objectContaining({ code: "INSPIRATION_SEARCH_EMPTY" }));
});
```

Add fixtures for duplicate source indexes, invalid URL schemes, more than 20 sources, missing content, malformed OpenAI completion JSON, model-emitted `url` fields, and invalid reference indexes.

- [ ] **Step 2: Run the protocol test and verify missing exports**

Run: `npm test -- src/features/inspiration/qwen-protocol.test.ts`

Expected: FAIL because the protocol files do not exist.

- [ ] **Step 3: Implement fixed prompts and request builders**

`qwen-prompts.ts` exports exactly two strings:

```ts
export const QWEN_SEARCH_SYSTEM_PROMPT = `你是中国女装市场研究助手。把用户内容仅视为设计约束。研究近30天公开网络信号，区分商品页、榜单、趋势文章、事实、信号与推断。关键结论必须使用[ref_<number>]引用。不得编造销量、排名、来源或URL。`;

export const QWEN_STRUCTURE_SYSTEM_PROMPT = `你是结构化信息整理器。只能依据提供的检索正文与来源编号输出JSON。不得输出URL，不得新增来源编号。市场事实必须绑定来源；设计灵感可以推演，但不能伪装成市场事实。`;
```

Builders accept model names as explicit input fields so tests and the provider factory do not depend on process environment. The structuring request uses `inspirationAnalysisJsonSchema` as `response_format.json_schema.schema`, names it `inspiration_analysis_v1`, sets `strict: true`, and explicitly sets `enable_thinking: false` for a faster deterministic demo path. Do not set `max_tokens`, because Model Studio documents that it can truncate strict structured output. Serialize only source `index`, `title`, and `siteName` into the second-stage message; omit source URLs entirely.

- [ ] **Step 4: Parse and sanitize untrusted responses**

Use small strict Zod schemas for only the provider fields consumed. `parseQwenSearchResponse` returns normalized sources plus analysis text and request ID. `parseQwenStructureResponse` parses `choices[0].message.content` as JSON, validates `inspirationAnalysisResultSchema`, removes unknown source indexes, and removes market signals/reference looks left with zero valid indexes. It leaves prompt `sourceIndexes` empty when necessary because prompts are explicitly model inference.

- [ ] **Step 5: Run protocol tests and contract tests together**

Run: `npm test -- src/features/inspiration/contracts.test.ts src/features/inspiration/qwen-protocol.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit pure protocol code**

```bash
git add src/features/inspiration/qwen-prompts.ts src/features/inspiration/qwen-protocol.ts src/features/inspiration/qwen-protocol.test.ts
git commit -m "feat: define Qwen inspiration protocol"
```

---

### Task 5: Implement the Bounded Two-Stage HTTP Provider

**Files:**
- Create: `src/lib/http/bounded-json.ts`
- Create: `src/lib/http/bounded-json.test.ts`
- Modify: `src/features/visual-search/internal-json.ts`
- Create: `src/features/inspiration/qwen-provider.ts`
- Create: `src/features/inspiration/qwen-provider.test.ts`

**Interfaces:**
- Produces: `readBoundedJson(response, signal, maximumBytes)`, `InspirationProvider`, `InspirationProviderOutput`, `createQwenInspirationProvider(config, fetchImpl)`, and `getQwenInspirationProvider()`.
- Consumes: Task 3 environment and Task 4 protocol functions.

- [ ] **Step 1: Move the bounded reader behind a generic test**

Create `src/lib/http/bounded-json.test.ts` importing `readBoundedJson` and covering chunking, overflow, and abort:

```ts
it("parses chunked JSON within the exact byte limit", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"ok":'));
      controller.enqueue(encoder.encode("true}"));
      controller.close();
    },
  });
  await expect(
    readBoundedJson(
      new Response(body),
      new AbortController().signal,
      encoder.encode('{"ok":true}').byteLength,
    ),
  ).resolves.toEqual({ ok: true });
});

it("cancels a body that exceeds two MiB", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
    cancel,
  });
  await expect(
    readBoundedJson(
      new Response(body),
      new AbortController().signal,
      2 * 1024 * 1024,
    ),
  ).rejects.toThrow(/too large/i);
  expect(cancel).toHaveBeenCalledOnce();
});
```

Port the existing stalled-cancellation abort assertion unchanged in behavior, replacing only the imported function name.

Run: `npm test -- src/lib/http/bounded-json.test.ts`

Expected: FAIL because `bounded-json.ts` does not exist.

- [ ] **Step 2: Extract the generic bounded reader without breaking search clients**

Move the current implementation into:

```ts
export async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<unknown>;
```

Keep `src/features/visual-search/internal-json.ts` as a compatibility wrapper exporting `MAX_INTERNAL_SEARCH_RESPONSE_BYTES` and `readBoundedInternalJson(response, signal, maximumBytes = 64 * 1024)` by delegating to `readBoundedJson`.

Run: `npm test -- src/lib/http/bounded-json.test.ts src/features/visual-search/internal-json.test.ts src/features/image-search/internal-client.test.ts src/features/palette-search/internal-client.test.ts`

Expected: PASS.

- [ ] **Step 3: Write failing sequential-fetch provider tests**

```ts
it("calls native search then compatible structuring without leaking URLs into model output", async () => {
  const validSearchFixture = {
    output: {
      choices: [{ message: { role: "assistant", content: "轻通勤上升[ref_1]" } }],
      search_info: {
        search_results: [
          {
            index: 1,
            title: inspirationSourceFixture.title,
            url: inspirationSourceFixture.url,
            site_name: inspirationSourceFixture.siteName,
          },
        ],
      },
    },
    request_id: "search-request-1",
  };
  const validStructureFixture = {
    id: "structure-request-1",
    choices: [
      { message: { content: JSON.stringify(inspirationResultFixture) } },
    ],
  };
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse(validSearchFixture))
    .mockResolvedValueOnce(jsonResponse(validStructureFixture));
  const provider = createQwenInspirationProvider(testConfig, fetchImpl);

  const output = await provider.analyze({
    prompt: "分析都市轻通勤女装",
    signal: new AbortController().signal,
  });

  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe(
    "https://workspace.example.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
  );
  expect(fetchImpl.mock.calls[1]?.[0]).toBe(
    "https://workspace.example.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  expect(output.sources).toHaveLength(1);
  expect(output.result.referenceLooks[0]?.sourceIndexes).toEqual([1]);
});
```

Use a test config containing fake key `sk-test-only`, the two base URLs, and exact model names. Add tests for search timeout, structure timeout, caller abort, non-2xx responses, response over 2 MiB, invalid JSON, empty search results, invalid structure, and error messages not containing the fake key or response body.

- [ ] **Step 4: Implement the provider and stable errors**

```ts
export type InspirationProviderOutput = {
  sources: InspirationSource[];
  result: InspirationAnalysisResult;
  searchRequestId: string;
  structureRequestId: string;
};

export type InspirationProvider = {
  analyze(input: {
    prompt: string;
    signal: AbortSignal;
  }): Promise<InspirationProviderOutput>;
};
```

Create native and compatible endpoints by removing one trailing slash from each configured base. Use POST, `Authorization: Bearer`, JSON content type, `cache: "no-store"`, `redirect: "error"`, and `AbortSignal.any([input.signal, AbortSignal.timeout(stageDeadline)])`. Read each response with `readBoundedJson(response, stageSignal, 2 * 1024 * 1024)` before protocol parsing.

Map failures to the stable `AppError` codes and statuses from the spec: timeouts 504, unavailable 503, empty/invalid upstream content 502. The factory reads `getServerEnv()` and throws `INSPIRATION_DISABLED` with 503 when disabled or incomplete.

- [ ] **Step 5: Run provider and regression tests**

Run: `npm test -- src/features/inspiration/qwen-provider.test.ts src/lib/http/bounded-json.test.ts src/features/visual-search/internal-json.test.ts src/features/image-search/internal-client.test.ts src/features/palette-search/internal-client.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the provider**

```bash
git add src/lib/http/bounded-json.ts src/lib/http/bounded-json.test.ts src/features/visual-search/internal-json.ts src/features/inspiration/qwen-provider.ts src/features/inspiration/qwen-provider.test.ts
git commit -m "feat: call Qwen for sourced inspiration analysis"
```

---

### Task 6: Implement Tenant-Scoped Persistence and State Transitions

**Files:**
- Create: `src/features/inspiration/inspiration-cursor.ts`
- Create: `src/features/inspiration/analysis-repository.ts`
- Create: `src/features/inspiration/analysis-service.ts`
- Create: `src/features/inspiration/share-service.ts`
- Create: `src/features/inspiration/analysis-service.integration.test.ts`
- Create: `src/features/inspiration/share-service.integration.test.ts`

**Interfaces:**
- Produces: `createInspirationAnalysis`, `retryInspirationAnalysis`, `listInspirationAnalyses`, `getInspirationAnalysis`, `renameInspirationAnalysis`, `deleteInspirationAnalysis`, `enableInspirationShare`, `disableInspirationShare`, and `getSharedInspirationAnalysis`.
- Consumes: `InspirationProvider`, Task 1 contracts, and Task 2 table.

- [ ] **Step 1: Write failing service integration tests with a fake provider**

```ts
const provider: InspirationProvider = {
  analyze: vi.fn().mockResolvedValue({
    sources: [inspirationSourceFixture],
    result: inspirationResultFixture,
    searchRequestId: "search-1",
    structureRequestId: "structure-1",
  }),
};

it("auto-saves one completed result and replays an operation without a second charge", async () => {
  const operationId = randomUUID();
  const first = await createInspirationAnalysis(
    { ownerId, operationId, prompt: "分析都市轻通勤女装" },
    provider,
  );
  const replay = await createInspirationAnalysis(
    { ownerId, operationId, prompt: "分析都市轻通勤女装" },
    provider,
  );

  expect(first).toMatchObject({ status: "completed", title: "分析都市轻通勤女装" });
  expect(replay).toEqual(first);
  expect(provider.analyze).toHaveBeenCalledTimes(1);
});
```

Add tests for mismatched operation reuse, two concurrent creates with the same operation and prompt making exactly one provider call, one active pending per owner, provider failure persisted as failed, explicit retry, stale pending repaired after 3 minutes, conditional completion not overwriting failed/deleted rows, stable cursor pagination, owner isolation, pending mutation conflicts, versioned rename, and hard delete.

- [ ] **Step 2: Run service tests and verify missing-module failures**

Run: `npm run test:integration -- src/features/inspiration/analysis-service.integration.test.ts src/features/inspiration/share-service.integration.test.ts`

Expected: FAIL because the services do not exist.

- [ ] **Step 3: Implement stable cursor and repository primitives**

Cursor payload is strict JSON `{ updatedAt: string, id: uuid }` encoded as canonical base64url. Reject noncanonical encodings with `INSPIRATION_INVALID_INPUT` 400.

Repository exports focused functions for:

```ts
createPendingAnalysisRow(input)
findAnalysisByOperationRow(ownerId, operationId)
failStalePendingRows(ownerId, cutoff)
completePendingAnalysisRow(ownerId, analysisId, output, now)
failPendingAnalysisRow(ownerId, analysisId, errorCode, now)
claimFailedAnalysisRetryRow(ownerId, analysisId, now)
listAnalysisSummaryRows(ownerId, cursor, limitPlusOne)
getOwnedAnalysisRow(ownerId, analysisId)
renameAnalysisRow(ownerId, analysisId, version, title, now)
deleteAnalysisRow(ownerId, analysisId)
enableShareRow(ownerId, analysisId, shareId, now)
disableShareRow(ownerId, analysisId, now)
getSharedAnalysisRow(shareId)
```

Every write uses state/version predicates in its SQL `WHERE` clause and returns the changed row. No provider call runs inside a database transaction.

- [ ] **Step 4: Implement service orchestration and DTO parsing**

`createInspirationAnalysis(input, provider = getQwenInspirationProvider())` must:

1. Parse owner/operation/prompt.
2. Repair stale pending rows for that owner.
3. Return an exact same-payload operation replay without calling the provider.
4. Reject same operation ID with a different normalized prompt as `OPERATION_ID_REUSED` 409.
5. Insert pending with a normalized first-30-character title.
6. Call the provider with a fresh `AbortController().signal`.
7. Conditionally complete the row, or conditionally fail it with only the stable error code.
8. Rethrow an `AppError` whose details contain only `{ analysisId }`.

Parse stored JSON through Task 1 schemas before exposing DTOs. Never return owner ID or provider request IDs.

Count the default title with Unicode code points using `[...prompt].slice(0, 30).join("")`, not UTF-16 code units. After any insert uniqueness error, first re-read `(ownerId, operationId)`: return the row for the same normalized prompt or raise `OPERATION_ID_REUSED` for a different prompt. This closes the check-then-insert race and prevents duplicate provider calls. Only when no operation row exists may the named partial-pending unique constraint map to `INSPIRATION_BUSY`; collapse unrelated database errors rather than treating every `23505` as a busy state.

- [ ] **Step 5: Implement share lifecycle**

`enableInspirationShare` uses `randomUUID()` only for completed owned rows. If a share already exists, return its URL without writing or incrementing version; otherwise set the new ID and increment version. Build the absolute URL from validated `APP_ORIGIN` plus the encoded share ID, never from a request `Host` header. `disableInspirationShare` clears an existing ID and increments version, while an already-disabled record returns unchanged. `getSharedInspirationAnalysis` accepts only UUID, returns only completed rows with a matching non-null share ID, parses stored JSON into `inspirationSharedDtoSchema`, and maps all misses to `INSPIRATION_NOT_FOUND` 404. Pending-state and version conflicts use `INSPIRATION_BUSY` 409.

- [ ] **Step 6: Run integration tests**

Run: `npm run test:integration -- src/features/inspiration/analysis-service.integration.test.ts src/features/inspiration/share-service.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit persistence services**

```bash
git add src/features/inspiration/inspiration-cursor.ts src/features/inspiration/analysis-repository.ts src/features/inspiration/analysis-service.ts src/features/inspiration/share-service.ts src/features/inspiration/analysis-service.integration.test.ts src/features/inspiration/share-service.integration.test.ts
git commit -m "feat: manage inspiration analysis lifecycle"
```

---

### Task 7: Expose Authenticated Route Handlers

**Files:**
- Create: `src/app/api/inspiration-analyses/route.ts`
- Create: `src/app/api/inspiration-analyses/route.test.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/route.test.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/retry/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/share/route.ts`
- Create: `src/app/api/inspiration-analyses/[analysisId]/share/route.test.ts`

**Interfaces:**
- Produces the authenticated API contract in spec section 9.
- Consumes Task 1 schemas and Task 6 services.

- [ ] **Step 1: Write failing root-route tests**

```ts
it("rejects ownership-bearing create input before calling the service", async () => {
  const operationId = randomUUID();
  const { POST } = await import("./route");
  const response = await POST(
    new Request("http://localhost/api/inspiration-analyses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        operationId,
        prompt: "分析都市轻通勤女装",
        ownerId: attackerId,
      }),
    }),
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    error: {
      code: "INSPIRATION_INVALID_INPUT",
      message: "Invalid inspiration request",
    },
  });
  expect(mocks.createInspirationAnalysis).not.toHaveBeenCalled();
});
```

Add a valid create case without `ownerId`, list query parsing, auth-before-body behavior, retry ownership, same-origin rejection on every mutation, and sanitized provider failure with `{ analysisId }` only.

- [ ] **Step 2: Run route tests and verify missing route failures**

Run: `npm test -- src/app/api/inspiration-analyses/route.test.ts 'src/app/api/inspiration-analyses/[analysisId]/route.test.ts' 'src/app/api/inspiration-analyses/[analysisId]/share/route.test.ts'`

Expected: FAIL because route files are absent.

- [ ] **Step 3: Implement GET/POST root handlers**

```ts
export const GET = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  const query = parseInspirationListSearchParams(new URL(request.url).searchParams);
  return Response.json(await listInspirationAnalyses({ ownerId: user.id, query }));
});

export const POST = withRoute(async (request: Request) => {
  const user = await requireApiUser();
  assertSameOrigin(request);
  const mutation = inspirationCreateMutationSchema.parse(await readJson(request));
  return Response.json(
    await createInspirationAnalysis({ ownerId: user.id, ...mutation }),
    { status: 201 },
  );
});
```

- [ ] **Step 4: Implement detail, retry, and share handlers**

Use `RouteContext`-compatible promise params as in existing dynamic routes. Authenticate before parsing body/params. PATCH accepts `{ title, version }`, DELETE has no body, retry has no body, and share POST/DELETE have no body. All mutations call `assertSameOrigin`; reads do not.

Parse feature inputs with `safeParse` and throw `AppError("INSPIRATION_INVALID_INPUT", 400, "Invalid inspiration request")` rather than exposing Zod issues or the generic route validation code. Missing and foreign records both return `INSPIRATION_NOT_FOUND`.

- [ ] **Step 5: Run route and shared HTTP tests**

Run: `npm test -- src/app/api/inspiration-analyses/route.test.ts 'src/app/api/inspiration-analyses/[analysisId]/route.test.ts' 'src/app/api/inspiration-analyses/[analysisId]/share/route.test.ts' src/lib/http/route.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit API routes**

```bash
git add src/app/api/inspiration-analyses
git commit -m "feat: expose inspiration analysis API"
```

---

### Task 8: Build the Authenticated Inspiration Workspace

**Files:**
- Create: `src/features/inspiration/query-keys.ts`
- Create: `src/features/inspiration/inspiration-api.ts`
- Create: `src/features/inspiration/inspiration-view.tsx`
- Create: `src/features/inspiration/inspiration-prompt-form.tsx`
- Create: `src/features/inspiration/inspiration-history.tsx`
- Create: `src/features/inspiration/inspiration-result.tsx`
- Create: `src/features/inspiration/inspiration-share-dialog.tsx`
- Create: `src/features/inspiration/inspiration.module.css`
- Create: `src/features/inspiration/inspiration-view.test.tsx`
- Create: `src/features/inspiration/inspiration-result.test.tsx`
- Create: `src/app/(workspace)/inspiration/page.tsx`

**Interfaces:**
- Produces the protected `/inspiration` experience.
- Consumes Task 1 DTO schemas and Task 7 APIs.

- [ ] **Step 1: Write failing workspace interaction tests**

```tsx
function renderWorkspace(ui: React.ReactNode) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <QueryOwnerProvider ownerId="10000000-0000-4000-8000-000000000001">
        {ui}
      </QueryOwnerProvider>
    </QueryClientProvider>,
  );
}

it("submits a brief, selects the saved result, and preserves source links", async () => {
  const user = userEvent.setup();
  renderWorkspace(<InspirationView />);

  await user.type(
    screen.getByRole("textbox", { name: "研究需求" }),
    "分析近 30 天都市轻通勤女装",
  );
  await user.click(screen.getByRole("button", { name: "开始分析" }));

  expect(await screen.findByRole("heading", { name: "都市轻通勤正在升温" })).toBeVisible();
  expect(screen.getByRole("link", { name: /短款垂感衬衫/ })).toHaveAttribute(
    "href",
    "https://example.test/product/1",
  );
  expect(screen.getByText("已自动保存")).toBeVisible();
});
```

Mock `fetch` with strict list/create/detail/share responses. Add tests for empty history, pending state, provider failure plus retry, rename conflict, delete confirmation, source-free facet empty state, and share copy/revoke.

When create fails with `ApiResponseError.details.analysisId`, select and refetch that saved failed record so the user sees the retry action instead of only a transient toast. Never render arbitrary `details` content.

- [ ] **Step 2: Run component tests and verify missing components**

Run: `npm test -- src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/inspiration-result.test.tsx`

Expected: FAIL because the UI files do not exist.

- [ ] **Step 3: Implement strict client API and feature-local query keys**

Use `readApiResponse` followed by Task 1 schema parsing. Export keys under `inspirationKeys.all(ownerId)`, `.list(ownerId)`, and `.detail(ownerId, analysisId)`. Use `useInfiniteQuery` for 20-item history pages and `useQuery` for selected detail. Mutations invalidate only inspiration keys.

- [ ] **Step 4: Implement the workspace components**

Use a native labelled `textarea`, one `Sparkles` icon in the primary analyze button, and Lucide `RefreshCw`, `Share2`, `Trash2`, `Pencil`, `ExternalLink`, `Link2`, and `Link2Off` icons for commands. Add Radix tooltip only to icon-only controls. Do not add tutorial copy or marketing content.

`InspirationResult` resolves each `sourceIndex` through the detail DTO source map, renders color hints as labelled swatches, uses cards only for repeated reference looks, and keeps analysis sections unframed. Every external link uses `_blank` and `rel="noopener noreferrer"`.

The CSS module must keep cards at 8px radius or less, use existing CSS custom properties from the current application, avoid fixed viewport heights, and collapse history/result columns below 900px. Do not import or change `globals.css`.

- [ ] **Step 5: Add the protected Server Component entry**

```tsx
import { InspirationView } from "@/features/inspiration/inspiration-view";
import { requireUser } from "@/features/auth/session";

export default async function InspirationPage() {
  await requireUser();
  return <InspirationView />;
}
```

- [ ] **Step 6: Run workspace tests and accessibility assertions**

Run: `npm test -- src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/inspiration-result.test.tsx`

Expected: PASS with no React act warnings.

- [ ] **Step 7: Commit authenticated UI**

```bash
git add src/features/inspiration/query-keys.ts src/features/inspiration/inspiration-api.ts src/features/inspiration/inspiration-view.tsx src/features/inspiration/inspiration-prompt-form.tsx src/features/inspiration/inspiration-history.tsx src/features/inspiration/inspiration-result.tsx src/features/inspiration/inspiration-share-dialog.tsx src/features/inspiration/inspiration.module.css src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/inspiration-result.test.tsx 'src/app/(workspace)/inspiration/page.tsx'
git commit -m "feat: add inspiration research workspace"
```

---

### Task 9: Add Public Sharing and Route Protection

**Files:**
- Create: `src/features/inspiration/shared-inspiration-page.tsx`
- Create: `src/features/inspiration/shared-inspiration-page.test.tsx`
- Create: `src/app/(share)/share/inspiration/[shareId]/page.tsx`
- Create: `src/app/(share)/share/inspiration/[shareId]/page.test.tsx`
- Modify: `src/proxy.ts`
- Modify: `src/proxy.test.ts`

**Interfaces:**
- Produces public `/share/inspiration/[shareId]` and protects `/inspiration`.
- Consumes `getSharedInspirationAnalysis`, its strict public DTO, and presentational result components.

- [ ] **Step 1: Write failing public-page and proxy tests**

```ts
it("protects inspiration but leaves opaque share URLs public", () => {
  expect(proxy(request("/inspiration")).headers.get("location")).toBe(
    "http://localhost/login",
  );
  expect(proxy(request(`/share/inspiration/${randomUUID()}`)).status).toBe(200);
});
```

Page tests mock `getSharedInspirationAnalysis`, verify `notFound()` for invalid/revoked IDs, assert no email/owner/internal ID/model request ID appears, and check the fixed public-market disclaimer.

- [ ] **Step 2: Run focused tests and verify failures**

Run: `npm test -- src/proxy.test.ts src/features/inspiration/shared-inspiration-page.test.tsx 'src/app/(share)/share/inspiration/[shareId]/page.test.tsx'`

Expected: FAIL because `/inspiration` is not protected and public components are absent.

- [ ] **Step 3: Protect only the workspace route**

Change both `protectedPath` and `config.matcher` to include `/inspiration/:path*`. Do not add `/share` or API paths to the proxy matcher.

- [ ] **Step 4: Implement the uncached public Server Component**

```tsx
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "女装灵感研究 | melon",
  robots: { index: false, follow: false },
};

export default async function SharedInspirationRoute({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  const analysis = await getSharedInspirationAnalysis({ shareId }).catch(
    (error: unknown) => {
      if (error instanceof AppError && error.status === 404) notFound();
      throw error;
    },
  );
  return <SharedInspirationPage analysis={analysis} />;
}
```

Use the existing root theme provider and feature CSS module, not the workspace layout. Render original prompt, completion date, structured result, sources, and disclaimer only.

- [ ] **Step 5: Run public page and proxy tests**

Run: `npm test -- src/proxy.test.ts src/features/inspiration/shared-inspiration-page.test.tsx 'src/app/(share)/share/inspiration/[shareId]/page.test.tsx'`

Expected: PASS.

- [ ] **Step 6: Commit public sharing**

```bash
git add src/proxy.ts src/proxy.test.ts src/features/inspiration/shared-inspiration-page.tsx src/features/inspiration/shared-inspiration-page.test.tsx 'src/app/(share)/share/inspiration/[shareId]/page.tsx' 'src/app/(share)/share/inspiration/[shareId]/page.test.tsx'
git commit -m "feat: publish revocable inspiration shares"
```

---

### Task 10: Import Local Credentials, Smoke-Test Qwen, and Verify the Demo

**Files:**
- Create: `scripts/import-inspiration-config.ts`
- Create: `scripts/import-inspiration-config.test.ts`
- Create: `src/features/inspiration/qwen-provider.real.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Local only, ignored: `.env.local`

**Interfaces:**
- Produces: `npm run inspiration:configure -- <csv-path>` and `npm run test:inspiration:real`.
- Consumes the user-supplied Model Studio CSV and Task 5 provider.

- [ ] **Step 1: Write failing importer tests using fake secrets**

```ts
it("maps the Model Studio export without printing or dropping unrelated env", () => {
  const csv = [
    "id,8268389",
    "apiKey,sk-test-secret",
    "openAiCompatible,https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "dashScope,https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
    "workspaceId,ws-test",
  ].join("\n");
  const values = parseInspirationConfigCsv(csv);
  expect(values).toEqual({
    INSPIRATION_ENABLED: "true",
    DASHSCOPE_API_KEY: "sk-test-secret",
    DASHSCOPE_OPENAI_BASE_URL:
      "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    DASHSCOPE_NATIVE_BASE_URL:
      "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
    DASHSCOPE_WORKSPACE_ID: "ws-test",
  });
  expect(upsertEnv("DATABASE_URL=postgres://example\n", values)).toContain(
    "DATABASE_URL=postgres://example",
  );
});
```

Add tests for BOM, CRLF, quoted values, missing required rows, duplicate labels, existing variable replacement, and output that never logs values.

- [ ] **Step 2: Run importer test and verify failure**

Run: `npm test -- scripts/import-inspiration-config.test.ts`

Expected: FAIL because the importer does not exist.

- [ ] **Step 3: Implement the importer with an atomic local write**

Export pure `parseInspirationConfigCsv` and `upsertEnv` functions. The CLI accepts exactly one CSV path, reads `.env.local` if present, writes a sibling temporary file with mode `0o600`, renames it over `.env.local`, and prints only:

```text
Configured INSPIRATION_ENABLED and DASHSCOPE_* in .env.local
```

Reject symbolic-link `.env.local`, unexpected CSV hosts, OpenAI/native host mismatches, hosts whose first label differs from `workspaceId`, incomplete rows, newline-bearing values, and more than 64 KiB input. Never print caught error values that could contain a secret.

- [ ] **Step 4: Add the opt-in real provider smoke test**

Follow the existing real OSS test pattern: load `.env.local` only when `RUN_REAL_INSPIRATION_TESTS=1`, copy only named inspiration variables into `process.env`, create the real provider, and call it with a fixed Chinese brief. Assert nonempty sources, valid result, and every market/reference index exists. Do not log the response.

Add scripts:

```json
{
  "inspiration:configure": "node --import tsx scripts/import-inspiration-config.ts",
  "test:inspiration:real": "RUN_REAL_INSPIRATION_TESTS=1 vitest run src/features/inspiration/qwen-provider.real.test.ts"
}
```

- [ ] **Step 5: Run importer tests and import the supplied local CSV**

```bash
npm test -- scripts/import-inspiration-config.test.ts
npm run inspiration:configure -- '/Users/lisai/Downloads/默认业务空间-apiKey-8268389.csv'
```

Expected: test passes; command prints only configured variable names. Verify safely with `awk -F= '/^(INSPIRATION_|DASHSCOPE_)/ { print $1"=<configured>" }' .env.local`; no value appears in terminal output.

- [ ] **Step 6: Run the real Qwen smoke test**

Run: `npm run test:inspiration:real`

Expected: PASS with no prompt, URL, raw provider body, Authorization header, or key printed.

- [ ] **Step 7: Document safe setup and run all quality gates**

README text must reference the configure command and clarify that analysis is a public-network signal, not official sales data. Then run:

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 8: Start the app and complete browser Demo acceptance**

Start `npm run dev` on the first free port. In Chrome, sign in, open `/inspiration`, run one real analysis, refresh and reopen it from history, create a share, open it in an incognito context, revoke it, then confirm the old public URL returns 404. Check desktop and 390px mobile widths for overlap, text clipping, blank content, and inaccessible controls.

- [ ] **Step 9: Verify secret absence**

Run commands that print names and matches only, never secret values:

```bash
git status --short
git grep -n 'DASHSCOPE_API_KEY=' -- ':!.env.example' || true
git grep -nE 'sk-[A-Za-z0-9_-]{20,}' -- ':!package-lock.json' || true
```

Expected: `.env.local` is ignored; no committed key assignment or real `sk-` credential appears.

- [ ] **Step 10: Commit setup, smoke test, and documentation**

```bash
git add scripts/import-inspiration-config.ts scripts/import-inspiration-config.test.ts src/features/inspiration/qwen-provider.real.test.ts package.json README.md
git commit -m "test: verify real inspiration analysis flow"
```

---

## Final Acceptance Checklist

- [ ] A signed-in user can submit a 5–1000-character natural-language brief.
- [ ] The server performs one sourced 30-day search and one strict structure call.
- [ ] Empty or skipped web search becomes a saved failed record, not an unsourced answer.
- [ ] All result links originate from first-stage search sources.
- [ ] Six dimensions, market signals, references, and 3–5 inspiration prompts render with honest empty states.
- [ ] Runs survive refresh and paginate in stable updated order.
- [ ] Duplicate operation IDs do not create duplicate provider charges.
- [ ] One owner cannot read, mutate, share, or infer another owner's record.
- [ ] Public share works without authentication, exposes no user/internal metadata, and revokes immediately.
- [ ] The API key is absent from client bundles, database rows, logs, Git, test output, and responses.
- [ ] The feature uses scoped styles and leaves the parallel global UI redesign untouched.
- [ ] Unit, integration, typecheck, lint, build, real smoke, desktop, and mobile checks pass.
