# Melon Editorial Inspiration Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn completed inspiration research into a source-linked editorial document containing real hero, evidence, and product images, while preserving private-library matches, safe refresh behavior, and share authorization.

**Architecture:** Keep text research as the durable primary record and use the existing visual job as an idempotent enhancement. One Qwen Web Search Agent call yields structured image candidates; deterministic intent matching assigns document roles and existing source indexes; a DNS-pinned importer validates and copies accepted bytes into private OSS; the visual service commits web and library results atomically. A pure document composer then maps the text result and completed visual assets into one stable DTO rendered by both authenticated and shared pages.

**Tech Stack:** Next.js 16.4.1 App Router, React 19, TypeScript 6, Node.js 24 `https`/`dns`/Web Streams, Zod 4, PostgreSQL/Drizzle, Alibaba Cloud Web Search Agent and OSS, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-melon-editorial-inspiration-flow-design.md`

**Scope:** This plan implements phase one only. Qwen-Image concept generation remains in `docs/superpowers/plans/2026-10-29-melon-inspiration-concept-images.md` and must not block or be mixed into this release.

## Global Constraints

- Before changing any Next.js route or image rendering code, read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, `node_modules/next/dist/docs/01-app/01-getting-started/12-images.md`, and `node_modules/next/dist/docs/01-app/02-guides/self-hosting.md` in full. Record any Next.js 16.4.1 behavior that changes the steps below in the task log before editing.
- Preserve the existing dirty worktree. Never use `git add -A`, `git add .`, `git reset`, or `git checkout --`; stage only the exact files listed for each task.
- Use the official fixed endpoint `POST https://dashscope.aliyuncs.com/api/v2/apps/web-search-agent/chat/completions` with `stream: true`, `forced_search: true`, `enable_citation: true`, and `enable_text_image_mixed: true`.
- One research visual job makes at most one Agent request. Parse only `message.additional_kwargs.data_type === "image"` and validated `data_json`; never parse or render provider HTML.
- Accept only credential-free HTTPS image and source-page URLs. The actual TLS request must use a validated pinned public address and retain the original hostname for SNI and `Host`.
- Enforce 3 redirects, 16 KiB headers, 8 MiB image bytes, 15-second total time, 5-second idle time, 40 million decoded pixels, and 2 MiB provider SSE.
- Permit JPEG, PNG, WebP, and GIF only. MIME, magic bytes, and dimensions must agree. Reject SVG, HTML, multipart responses, scripts, truncation, and ambiguous payloads.
- Never log API keys, authorization headers, response bodies, full temporary image URLs, URL query strings, OSS object keys, owner IDs, or unvalidated provider text.
- Store web objects only under `users/{ownerId}/inspiration/{analysisId}/research/{jobId}/{assetId}.{ext}`. Browsers receive application resource paths, never provider or OSS URLs.
- A completed job contains at most 8 web assets, including at most 1 `hero` and 4 `product` assets. A `product` requires a reliable `productName`; otherwise downgrade it to `evidence`.
- `sourceIndexes` may contain only unique indexes already present in the completed text report, in report order, with a maximum of 20.
- Web search and library matching fail independently. A partial result completes the visual job; only an all-empty/all-failed result fails it. Text remains readable in every visual state.
- Refresh keeps the previous completed job visible until the new job and all metadata commit. Failed refreshes do not remove old assets.
- The public share excludes private library matches, pending/failed jobs, provider IDs, internal errors, storage metadata, and ownership data.
- Offline tests must not call billable services. Every real Agent test is opt-in and bounded to one request.
- Production stays flags-off until schema, offline gates, the one-request real smoke, source-page checks, owner/share authorization, deletion cleanup, and target-viewport QA pass.

---

## File Map

### New files

- `drizzle/0011_melon_editorial_inspiration_visuals.sql`: additive role, source-index, and product metadata migration.
- `drizzle/meta/0011_snapshot.json`: generated Drizzle snapshot.
- `src/features/inspiration-visuals/web-evidence-intents.ts`: bounded search intents and deterministic candidate classification.
- `src/features/inspiration-visuals/web-evidence-intents.test.ts`: role, source mapping, downgrade, and ordering tests.
- `src/features/inspiration-visuals/web-agent-contracts.ts`: provider request/candidate/SSE schemas.
- `src/features/inspiration-visuals/web-agent-protocol.ts`: request builder and incremental structured SSE parser.
- `src/features/inspiration-visuals/web-agent-protocol.test.ts`: split-chunk, malformed, duplicate, and HTML-ignorance tests.
- `src/features/inspiration-visuals/web-agent-provider.ts`: deadline-bound official Agent adapter.
- `src/features/inspiration-visuals/web-agent-provider.test.ts`: HTTP, cap, abort, and redaction tests.
- `src/features/inspiration-visuals/web-agent-provider.real.test.ts`: opt-in one-request real Agent smoke.
- `src/features/inspiration-visuals/remote-address.ts`: public IPv4/IPv6 classification and pinned address selection.
- `src/features/inspiration-visuals/remote-address.test.ts`: private/reserved/mixed-answer coverage.
- `src/features/inspiration-visuals/image-sniffer.ts`: allowed-image MIME, magic, and dimension parser.
- `src/features/inspiration-visuals/image-sniffer.test.ts`: valid, truncated, mismatched, and oversized fixtures.
- `src/features/inspiration-visuals/safe-image-fetch.ts`: validated, redirect-aware, pinned HTTPS byte reader.
- `src/features/inspiration-visuals/safe-image-fetch.test.ts`: SSRF, DNS rebinding, timeout, redirect, and size tests.
- `src/features/inspiration-visuals/visual-object-keys.ts`: canonical inspiration research key parser/builder.
- `src/features/inspiration-visuals/visual-object-store.ts`: dedicated OSS put/get/delete adapter.
- `src/features/inspiration-visuals/visual-object-store.test.ts`: key scope, SDK mapping, credential reset, and batching tests.
- `src/features/inspiration-visuals/web-evidence-importer.ts`: candidate dedupe, safe import, OSS write, and compensation metadata.
- `src/features/inspiration-visuals/web-evidence-importer.test.ts`: concurrency, partial failure, cap, and cleanup tests.
- `src/features/inspiration-visuals/visual-resource-service.ts`: owner/share resource authorization and byte reads.
- `src/features/inspiration-visuals/visual-resource-service.integration.test.ts`: tenant, share, revocation, and missing-object tests.
- `src/features/inspiration-visuals/document-contracts.ts`: strict editorial document DTO schemas.
- `src/features/inspiration-visuals/document-composer.ts`: deterministic text/visual document composition.
- `src/features/inspiration-visuals/document-composer.test.ts`: hero, evidence, product, direction, and privacy tests.
- `src/app/api/inspiration-visual-assets/[assetId]/route.ts`: authenticated visual byte route.
- `src/app/api/inspiration-visual-assets/[assetId]/route.test.ts`: authenticated route contract.
- `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.ts`: active-share visual byte route.
- `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts`: public route and revocation contract.
- `src/features/inspiration/inspiration-document.tsx`: continuous editorial document renderer.
- `src/features/inspiration/inspiration-document.test.tsx`: document order, asset counts, failure, and accessibility tests.
- `src/features/inspiration/inspiration-hero-evidence.tsx`: hero image and source treatment.
- `src/features/inspiration/inspiration-signal-section.tsx`: alternating market-signal evidence sections.
- `src/features/inspiration/inspiration-dimension-sections.tsx`: all dimensions in continuous reading order.
- `src/features/inspiration/inspiration-product-references.tsx`: sourced product grid and reliable optional price display.
- `src/features/inspiration/inspiration-direction-section.tsx`: direction copy, private matches, and future concept slot.
- `src/features/inspiration/inspiration-evidence-dialog.tsx`: keyboard-accessible large preview and source action.
- `src/features/inspiration/inspiration-visual-status.tsx`: local loading, partial warning, and refresh action.
- `tests/e2e/inspiration-document-fixtures.ts`: metadata-only text/web/library fixture helpers.
- `tests/e2e/inspiration-document.spec.ts`: authenticated/share document and viewport coverage.

### Modified files

- `src/lib/db/schema/inspiration-visuals.ts`: document role and product/source metadata columns and constraints.
- `src/lib/db/schema/inspiration-visuals.integration.test.ts`: database constraint coverage.
- `drizzle/meta/_journal.json`: register migration 0011.
- `src/lib/env/server.ts`: web visuals gate, Agent ID/version, and image cap.
- `src/lib/env/server.test.ts`: disabled/enabled and production config tests.
- `src/lib/env/production-readiness.ts`: release-version and image-cap production gates.
- `src/lib/env/production-readiness.test.ts`: new readiness errors.
- `.env.example`: disabled defaults and production lifecycle notes.
- `src/features/inspiration-visuals/contracts.ts`: role/product/source fields and safe public DTOs.
- `src/features/inspiration-visuals/contracts.test.ts`: strict role and secrecy tests.
- `src/features/inspiration-visuals/test-fixtures.ts`: hero/evidence/product and document fixtures.
- `src/features/inspiration-visuals/visual-repository.ts`: metadata persistence, active assets, resource lookups, and cleanup keys.
- `src/features/inspiration-visuals/visual-service.ts`: concurrent web/library orchestration, atomic switch, and compensation.
- `src/features/inspiration-visuals/visual-service.integration.test.ts`: partial-success, refresh, replay, and cleanup coverage.
- `src/features/inspiration/share-service.ts`: unchanged text share semantics plus page composition support.
- `src/features/inspiration/share-service.integration.test.ts`: shared completed visuals and revocation coverage.
- `src/features/inspiration/analysis-service.integration.test.ts`: analysis deletion plus visual object cleanup regression.
- `src/app/api/inspiration-analyses/[analysisId]/route.ts`: delete through visual lifecycle wrapper.
- `src/app/api/inspiration-analyses/[analysisId]/route.test.ts`: delete delegation contract.
- `src/app/(share)/share/inspiration/[shareId]/page.tsx`: load the composed public page DTO.
- `src/app/(share)/share/inspiration/[shareId]/page.test.tsx`: Promise params, 404, and public document tests.
- `src/features/inspiration/inspiration-view.tsx`: compose and render the authenticated document while preserving automatic visual startup.
- `src/features/inspiration/inspiration-view.test.tsx`: auto-start, refresh, partial failure, and active-content retention tests.
- `src/features/inspiration/shared-inspiration-page.tsx`: render the same public editorial document.
- `src/features/inspiration/shared-inspiration-page.test.tsx`: public image/product/source and private-match exclusion tests.
- `src/features/inspiration/inspiration.module.css`: editorial measure, stable media, responsive grid, and dialog styling.
- `src/features/inspiration/inspiration-result.tsx`: remove after the document renderer owns all sections.
- `src/features/inspiration/inspiration-result.test.tsx`: migrate assertions, then remove with the old renderer.
- `src/features/inspiration/inspiration-visual-board.tsx`: remove after status and private matches move into document sections.
- `package.json`: real Agent smoke script.
- `playwright.config.ts`: metadata-only inspiration document project coverage.
- `README.md`: Agent/OSS setup, lifecycle, smoke, rollout, rollback, and observability.

---

### Task 1: Freeze the Next.js 16 Baseline and Add the Visual Data Contract

**Files:**
- Read: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- Read: `node_modules/next/dist/docs/01-app/01-getting-started/12-images.md`
- Read: `node_modules/next/dist/docs/01-app/02-guides/self-hosting.md`
- Modify: `src/lib/db/schema/inspiration-visuals.ts`
- Modify: `src/lib/db/schema/inspiration-visuals.integration.test.ts`
- Create: `drizzle/0011_melon_editorial_inspiration_visuals.sql`
- Create: `drizzle/meta/0011_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/features/inspiration-visuals/contracts.ts`
- Modify: `src/features/inspiration-visuals/contracts.test.ts`
- Modify: `src/features/inspiration-visuals/test-fixtures.ts`

**Interfaces:**
- Produces: `InspirationDocumentRole`, strict web asset metadata, and database rows that can represent hero/evidence/product images.
- Consumes: current completed visual jobs and existing `web_evidence` rows.

- [ ] **Step 1: Read the three local Next.js 16.4.1 guides and record relevant behavior**

Confirm route handlers use Promise params, byte responses are supported without cache redirects, self-hosted dynamic routes are not accidentally cached, and same-origin authenticated image paths can use ordinary `<img>` elements. Do not edit application code before this read is complete.

- [ ] **Step 2: Write failing schema and contract tests**

Add cases for:

- `role: "hero" | "evidence" | "product"` only on `web_evidence`.
- unique ordered `sourceIndexes`, maximum 20, all present in the report at composition time.
- at most one hero and four products in a board.
- product requires non-empty `productName`; evidence with product metadata is rejected.
- `brand` max 120, `productName` max 300, `priceText` max 120.
- browser DTO contains local `imageUrl` but no `objectKey`, remote image URL, request ID, or owner ID.
- existing web rows migrate to `role=evidence` and `sourceIndexes=[]`.

- [ ] **Step 3: Run focused tests and confirm the missing contract**

```bash
npm test -- src/features/inspiration-visuals/contracts.test.ts
npm run test:integration -- src/lib/db/schema/inspiration-visuals.integration.test.ts
```

Expected: FAIL because role and product/source metadata do not exist.

- [ ] **Step 4: Add the schema fields and exact checks**

Add a nullable PostgreSQL enum column for non-web compatibility and JSON source indexes:

```ts
export const inspirationDocumentRoles = ["hero", "evidence", "product"] as const;

documentRole: inspirationDocumentRoleEnum("document_role"),
sourceIndexes: jsonb("source_indexes").$type<number[]>(),
brand: text("brand"),
productName: text("product_name"),
priceText: text("price_text"),
```

Update the kind check so every `web_evidence` row has `documentRole` and an array `sourceIndexes`, while all three fields remain null for library and concept assets. Require `productName` only for `document_role='product'`; require `brand`, `productName`, and `priceText` to be null for hero/evidence. Keep the current source, storage, dimension, and ownership constraints intact.

- [ ] **Step 5: Generate and inspect the additive migration**

```bash
npm run db:generate -- --name=melon_editorial_inspiration_visuals
```

Ensure the generated migration is named `drizzle/0011_melon_editorial_inspiration_visuals.sql`. Insert an explicit backfill between column creation and the new check:

```sql
UPDATE inspiration_visual_assets
SET document_role = 'evidence', source_indexes = '[]'::jsonb
WHERE kind = 'web_evidence';
```

The migration must not drop visual rows or alter completed text analyses. Review `drizzle/meta/0011_snapshot.json` and `_journal.json`; do not hand-edit the snapshot.

- [ ] **Step 6: Extend DTOs and fixtures**

Add role/source/product fields to `webEvidenceAssetDtoSchema`; add board-level count refinements; retain authenticated and public variants with safe local URLs. Create distinct hero, evidence, and product fixtures so later tests do not infer role from array position.

- [ ] **Step 7: Run contract, migration, type, and diff checks**

```bash
npm test -- src/features/inspiration-visuals/contracts.test.ts
npm run test:integration -- src/lib/db/schema/inspiration-visuals.integration.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 8: Commit only the data-contract files**

```bash
git add src/lib/db/schema/inspiration-visuals.ts src/lib/db/schema/inspiration-visuals.integration.test.ts drizzle/0011_melon_editorial_inspiration_visuals.sql drizzle/meta/0011_snapshot.json drizzle/meta/_journal.json src/features/inspiration-visuals/contracts.ts src/features/inspiration-visuals/contracts.test.ts src/features/inspiration-visuals/test-fixtures.ts
git commit -m "feat: model editorial inspiration assets"
```

---

### Task 2: Gate Web Visuals Independently from Library Search

**Files:**
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`
- Modify: `src/lib/env/production-readiness.ts`
- Modify: `src/lib/env/production-readiness.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: typed web-visual configuration and a correct `refreshAvailable` capability predicate for Task 7.
- Consumes: existing inspiration, DashScope API key, image-search, and OSS settings.

- [ ] **Step 1: Write failing configuration tests**

Cover disabled blank defaults; enabled mode requiring `INSPIRATION_ENABLED=true`, `DASHSCOPE_API_KEY`, Agent ID, and version; Agent ID format `^aid-[A-Za-z0-9_-]{3,128}$`; versions `beta | release`; image count 1 through 8; invalid 0/9; production requiring `release` and exactly 8.

- [ ] **Step 2: Run focused tests**

```bash
npm test -- src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts
```

Expected: FAIL because the keys and readiness codes are absent.

- [ ] **Step 3: Implement exact environment fields**

```ts
INSPIRATION_WEB_VISUALS_ENABLED: optionalBoolean,
DASHSCOPE_WEB_SEARCH_AGENT_ID: optionalTrimmedNonBlankString,
DASHSCOPE_WEB_SEARCH_AGENT_VERSION: z.preprocess(
  blankToUndefined,
  z.enum(["beta", "release"]).optional(),
),
INSPIRATION_VISUAL_MAX_IMAGES: z.coerce.number().int().min(1).max(8).default(8),
```

Do not add a configurable endpoint. Add stable readiness errors for a non-release Agent version and a production cap other than 8.

- [ ] **Step 4: Document safe disabled defaults**

Add all four variables to `.env.example`, disabled by default. Note that `users/*/inspiration/*/research/*` needs a 30-day OSS lifecycle before the production flag is enabled.

- [ ] **Step 5: Verify and commit configuration**

```bash
npm test -- src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts
npm run typecheck
git add src/lib/env/server.ts src/lib/env/server.test.ts src/lib/env/production-readiness.ts src/lib/env/production-readiness.test.ts .env.example
git commit -m "feat: gate inspiration web visuals"
```

---

### Task 3: Plan Search Intents and Classify Candidates Deterministically

**Files:**
- Create: `src/features/inspiration-visuals/web-evidence-intents.ts`
- Create: `src/features/inspiration-visuals/web-evidence-intents.test.ts`

**Interfaces:**
- Produces: `planWebEvidenceIntents` and `classifyWebEvidenceCandidates`.
- Consumes: validated prompt, result, sources, and structured provider candidates.

- [ ] **Step 1: Write failing intent tests**

Cover:

- one hero intent built from headline plus the strongest sourced market signal.
- up to three evidence intents from unique sourced market/dimension facets.
- up to four product intents only from `referenceLooks.sourceKind === "product"` with valid source indexes.
- stable ordering and an overall maximum of eight.
- exact canonical source-page matches winning over query similarity.
- query-intent mapping carrying only source indexes that exist in `sources`.
- duplicate image/source pairs removed.
- product classification requiring a product intent plus a candidate page on a mapped source host; otherwise downgrade to evidence and clear brand/product/price.
- product name taken from the validated reference look, not free provider text.
- optional price accepted only from a bounded structured field and never parsed from title/HTML.

- [ ] **Step 2: Run the new unit suite**

```bash
npm test -- src/features/inspiration-visuals/web-evidence-intents.test.ts
```

Expected: FAIL because the planner does not exist.

- [ ] **Step 3: Define bounded intent and classified-candidate types**

```ts
type WebEvidenceIntent = {
  key: string;
  role: "hero" | "evidence" | "product";
  query: string;
  sourceIndexes: number[];
  sourceHosts: string[];
  productName: string | null;
  brand: string | null;
};
```

Canonicalize URLs by dropping fragments, preserving meaningful query parameters for source links, and comparing normalized hostname/path separately. Do not fetch pages during classification.

- [ ] **Step 4: Implement deterministic quotas and downgrade rules**

Use role quotas `1/3/4`; fill fewer slots when the text report lacks supported material. Match candidate `query` to a normalized intent first, then use canonical source URL/host evidence. A candidate cannot be promoted from evidence to product by its title alone.

- [ ] **Step 5: Verify and commit intent planning**

```bash
npm test -- src/features/inspiration-visuals/web-evidence-intents.test.ts
npm run typecheck
git add src/features/inspiration-visuals/web-evidence-intents.ts src/features/inspiration-visuals/web-evidence-intents.test.ts
git commit -m "feat: classify inspiration evidence roles"
```

---

### Task 4: Parse the Official Qwen Web Search Agent Stream

**Files:**
- Create: `src/features/inspiration-visuals/web-agent-contracts.ts`
- Create: `src/features/inspiration-visuals/web-agent-protocol.ts`
- Create: `src/features/inspiration-visuals/web-agent-protocol.test.ts`
- Create: `src/features/inspiration-visuals/web-agent-provider.ts`
- Create: `src/features/inspiration-visuals/web-agent-provider.test.ts`

**Interfaces:**
- Produces: `WebEvidenceProvider.search`, `buildWebAgentRequest`, and `parseWebAgentStream`.
- Consumes: Task 3 intents and Task 2 server configuration.

- [ ] **Step 1: Write failing protocol tests**

Feed SSE split at every byte boundary. Test CRLF/LF, comments, blank events, multiple `data:` lines, malformed JSON, provider error chunks, unknown messages, duplicate candidates, oversized `data_json`, a stream over 2 MiB, and HTML containing an `<img>` while `additional_kwargs` is empty. The HTML-only case must return no candidates.

- [ ] **Step 2: Run protocol tests before implementation**

```bash
npm test -- src/features/inspiration-visuals/web-agent-protocol.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Build the fixed request from validated fields**

```ts
return {
  stream: true,
  input: {
    request_id: input.requestId,
    messages: [{ role: "user", content: buildVisualPrompt(input.intents) }],
  },
  parameters: {
    agent_options: {
      agent_id: config.agentId,
      agent_version: config.agentVersion,
      agent_policy: "standard",
      forced_search: true,
      enable_citation: true,
      enable_text_image_mixed: true,
      show_step_info: false,
    },
  },
} as const;
```

The prompt contains only the validated brief, headline/summary, and bounded intent queries. It asks for original source pages and image results for the supplied intent set; it does not include source bodies or any previous provider output.

- [ ] **Step 4: Implement bounded incremental SSE parsing**

Use `TextDecoder` streaming and parse only `data:` events. Validate this structured path:

```ts
output.choices[0].message.additional_kwargs = {
  data_type: "image",
  data_json: [{
    idx, query, url, title,
    image_info: { url: imageUrl, width, height },
  }],
};
```

Bound every string, array, URL, and dimension before dedupe. Ignore `content` entirely. Return candidates and a validated request ID, never raw chunks.

- [ ] **Step 5: Write provider transport tests and implement the adapter**

POST only to the fixed DashScope URL with bearer authorization and JSON content type. Require `200` plus `text/event-stream`; use a 60-second Agent deadline. Map abort, transport, non-200, malformed, and empty responses to stable visual errors. Error/log metadata may contain only stable codes and validated request IDs.

- [ ] **Step 6: Verify and commit the provider**

```bash
npm test -- src/features/inspiration-visuals/web-agent-protocol.test.ts src/features/inspiration-visuals/web-agent-provider.test.ts
npm run typecheck
git add src/features/inspiration-visuals/web-agent-contracts.ts src/features/inspiration-visuals/web-agent-protocol.ts src/features/inspiration-visuals/web-agent-protocol.test.ts src/features/inspiration-visuals/web-agent-provider.ts src/features/inspiration-visuals/web-agent-provider.test.ts
git commit -m "feat: query inspiration web evidence"
```

---

### Task 5: Fetch and Validate Remote Image Bytes Safely

**Files:**
- Create: `src/features/inspiration-visuals/remote-address.ts`
- Create: `src/features/inspiration-visuals/remote-address.test.ts`
- Create: `src/features/inspiration-visuals/image-sniffer.ts`
- Create: `src/features/inspiration-visuals/image-sniffer.test.ts`
- Create: `src/features/inspiration-visuals/safe-image-fetch.ts`
- Create: `src/features/inspiration-visuals/safe-image-fetch.test.ts`

**Interfaces:**
- Produces: `fetchRemoteImage(url, dependencies?) -> { bytes, contentType, extension, width, height }`.
- Consumes: Node 24 DNS and HTTPS APIs or injected test equivalents.

- [ ] **Step 1: Write failing public-address tests**

Cover IPv4 loopback, RFC1918, link-local, carrier-grade NAT, documentation, benchmark, multicast, unspecified, reserved, and IPv4-mapped IPv6. Cover IPv6 loopback, unique-local, link-local, documentation, multicast, and unspecified ranges. Reject empty and mixed public/private DNS answers.

- [ ] **Step 2: Write failing image-sniffer tests**

Use byte fixtures for PNG, baseline/progressive JPEG, WebP VP8/VP8L/VP8X, GIF87a/GIF89a, truncated headers, malformed JPEG lengths, MIME mismatch, HTML/SVG, excessive dimensions, and pixel count above 40 million.

- [ ] **Step 3: Write failing pinned-request tests**

Assert the real request receives a lookup callback pinned to the validated address; `servername` and `Host` retain the original hostname; every redirect revalidates; credentials, fragments, HTTP, redirect four, headers over 16 KiB, body over 8 MiB, total timeout, idle timeout, multipart, and content-length mismatch fail closed.

- [ ] **Step 4: Implement URL/address validation and the pinned TLS request**

```ts
const request = httpsRequest({
  protocol: "https:",
  hostname: url.hostname,
  port: url.port || 443,
  path: `${url.pathname}${url.search}`,
  method: "GET",
  servername: url.hostname,
  maxHeaderSize: 16 * 1024,
  headers: {
    Host: url.host,
    Accept: "image/webp,image/png,image/jpeg,image/gif",
  },
  lookup: (_hostname, _options, callback) =>
    callback(null, pinned.address, pinned.family),
});
```

Resolve with `{ all: true, verbatim: true }`; classify IP literals without DNS. Abort the socket at every limit and sniff only after the full bounded body arrives.

- [ ] **Step 5: Run security, type, and diff checks**

```bash
npm test -- src/features/inspiration-visuals/remote-address.test.ts src/features/inspiration-visuals/image-sniffer.test.ts src/features/inspiration-visuals/safe-image-fetch.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 6: Commit the safe fetch boundary**

```bash
git add src/features/inspiration-visuals/remote-address.ts src/features/inspiration-visuals/remote-address.test.ts src/features/inspiration-visuals/image-sniffer.ts src/features/inspiration-visuals/image-sniffer.test.ts src/features/inspiration-visuals/safe-image-fetch.ts src/features/inspiration-visuals/safe-image-fetch.test.ts
git commit -m "feat: safely fetch inspiration images"
```

---

### Task 6: Add the Private Visual Object Store and Importer

**Files:**
- Create: `src/features/inspiration-visuals/visual-object-keys.ts`
- Create: `src/features/inspiration-visuals/visual-object-store.ts`
- Create: `src/features/inspiration-visuals/visual-object-store.test.ts`
- Create: `src/features/inspiration-visuals/web-evidence-importer.ts`
- Create: `src/features/inspiration-visuals/web-evidence-importer.test.ts`

**Interfaces:**
- Produces: `VisualObjectStore`, canonical research keys, and `importWebEvidence`.
- Consumes: `createDefaultCredentialResolver`, OSS configuration, classified candidates, and `fetchRemoteImage`.

- [ ] **Step 1: Write failing key and store tests**

Cover canonical UUID normalization, extensions, traversal, wrong owner/analysis/job, pattern-key rejection, put content type, copied get bytes, delete batching, and client recreation after credential/client failure.

- [ ] **Step 2: Implement the dedicated store**

```ts
export interface VisualObjectStore {
  put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  delete(keys: readonly string[]): Promise<void>;
}
```

Use `ali-oss` `put`, `get`, and `deleteMulti` with the credential resolver, V4 authorization, HTTPS, retry zero, and existing request timeout posture. Validate every key with `parseVisualObjectKey`; do not weaken the pattern-only storage contract.

- [ ] **Step 3: Write failing importer tests**

Given more than eight classified candidates, prove:

- import concurrency never exceeds three.
- invalid/duplicate images are skipped independently.
- role caps remain one hero and four products after failures.
- generated UUID determines the final extension-bearing object key.
- a failed OSS put leaves no returned asset.
- returned persistence records contain object keys, but browser projections do not.
- `writtenKeys` contains every successfully written key so orchestration can compensate.

- [ ] **Step 4: Implement bounded import and stable warnings**

Return `{ assets, warnings, writtenKeys }`. Preserve role/source/product metadata from the deterministic classifier; derive extension/dimensions only from sniffed bytes. Never include a remote URL or object key in an error message.

- [ ] **Step 5: Verify and commit storage/import**

```bash
npm test -- src/features/inspiration-visuals/visual-object-store.test.ts src/features/inspiration-visuals/web-evidence-importer.test.ts
npm run typecheck
git add src/features/inspiration-visuals/visual-object-keys.ts src/features/inspiration-visuals/visual-object-store.ts src/features/inspiration-visuals/visual-object-store.test.ts src/features/inspiration-visuals/web-evidence-importer.ts src/features/inspiration-visuals/web-evidence-importer.test.ts
git commit -m "feat: cache sourced inspiration images"
```

---

### Task 7: Orchestrate Web Evidence and Library Matching Atomically

**Files:**
- Modify: `src/features/inspiration-visuals/visual-repository.ts`
- Modify: `src/features/inspiration-visuals/visual-service.ts`
- Modify: `src/features/inspiration-visuals/visual-service.integration.test.ts`

**Interfaces:**
- Produces: one research visual job with independent web/library outcomes, atomic activation, and compensating object cleanup.
- Consumes: Tasks 2–6 provider/importer, existing library matcher, visual repository, and object store.

- [ ] **Step 1: Write failing integration cases**

Add cases for web+library success, web only, library only with web warning, partial image import, provider disabled, both empty, both unavailable, request abort, operation replay, one concurrent pending winner, completion transaction failure, compare-and-set loss, successful refresh, failed refresh, stale-job repair, and cross-owner access.

Assert:

- one Agent call per job.
- the active job changes only after the completion transaction.
- old assets stay visible during pending/failed refresh.
- every newly written key is deleted when the transaction fails or loses ownership.
- superseded keys are best-effort deleted only after commit.
- cleanup failure does not turn a committed refresh into a user-visible failure.

- [ ] **Step 2: Run the service suite and confirm red paths**

```bash
npm run test:integration -- src/features/inspiration-visuals/visual-service.integration.test.ts
```

- [ ] **Step 3: Extend persistence and projections**

Persist all Task 1 metadata in `completeResearchJob`. Add repository methods to list object keys by job/analysis and to authorize only assets attached to completed jobs. Keep library row validation/locking unchanged.

- [ ] **Step 4: Run independent branches with one completion transaction**

Use `Promise.allSettled` for:

```ts
const [webResult, libraryResult] = await Promise.allSettled([
  buildAndImportWebEvidence(...),
  matchLibraryPatterns(...),
]);
```

Disabled web visuals return `INSPIRATION_WEB_VISUALS_DISABLED`; disabled library matching returns its existing warning. Merge and dedupe warnings, normalize ordinals within each kind, then call `completeResearchJob` once.

- [ ] **Step 5: Fix capability and failure semantics**

Set `refreshAvailable` to `INSPIRATION_WEB_VISUALS_ENABLED || IMAGE_SEARCH_ENABLED`. Complete if either branch yields assets. Fail with `INSPIRATION_VISUALS_EMPTY` only when both are empty, and `INSPIRATION_VISUALS_UNAVAILABLE` only when no branch yields assets and at least one failed.

- [ ] **Step 6: Verify integration and regressions**

```bash
npm run test:integration -- src/features/inspiration-visuals/visual-service.integration.test.ts src/features/inspiration/analysis-service.integration.test.ts
npm test -- src/features/inspiration-visuals
npm run typecheck
```

- [ ] **Step 7: Commit orchestration**

```bash
git add src/features/inspiration-visuals/visual-repository.ts src/features/inspiration-visuals/visual-service.ts src/features/inspiration-visuals/visual-service.integration.test.ts
git commit -m "feat: enrich inspiration visual jobs"
```

---

### Task 8: Authorize Owner and Share Image Bytes

**Files:**
- Create: `src/features/inspiration-visuals/visual-resource-service.ts`
- Create: `src/features/inspiration-visuals/visual-resource-service.integration.test.ts`
- Create: `src/app/api/inspiration-visual-assets/[assetId]/route.ts`
- Create: `src/app/api/inspiration-visual-assets/[assetId]/route.test.ts`
- Create: `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.ts`
- Create: `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts`

**Interfaces:**
- Produces: opaque owner/share image URLs and hardened byte responses.
- Consumes: Task 7 completed asset lookups and Task 6 object-store reads.

- [ ] **Step 1: Write failing authorization tests**

Cover valid owner; other owner 404; unknown/malformed UUID; library match 404; pending/failed/superseded job 404; active share success; wrong/revoked share 404; missing OSS object 404; and no bucket/key/signed URL in headers, body, or errors.

- [ ] **Step 2: Implement indistinguishable repository lookups**

Owner lookup joins asset -> completed active job -> analysis and filters owner. Share lookup also requires the current `analysis.share_id`. Return only `{ objectKey, contentType }` internally. Do not reveal whether denial came from ownership, state, share, or storage.

- [ ] **Step 3: Implement hardened byte responses**

```ts
return new Response(bytes, {
  headers: {
    "Content-Type": contentType,
    "Content-Length": String(bytes.byteLength),
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  },
});
```

Both routes accept path UUIDs only and do not accept URL, bucket, or key query input. Authentication happens before owner route params are read. The share route rechecks the live share on every request.

- [ ] **Step 4: Run route/resource suites**

```bash
npm run test:integration -- src/features/inspiration-visuals/visual-resource-service.integration.test.ts
npm test -- 'src/app/api/inspiration-visual-assets/[assetId]/route.test.ts' 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts'
npm run typecheck
```

- [ ] **Step 5: Commit the resource boundary**

```bash
git add src/features/inspiration-visuals/visual-resource-service.ts src/features/inspiration-visuals/visual-resource-service.integration.test.ts 'src/app/api/inspiration-visual-assets/[assetId]/route.ts' 'src/app/api/inspiration-visual-assets/[assetId]/route.test.ts' 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.ts' 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts'
git commit -m "feat: authorize inspiration image bytes"
```

---

### Task 9: Compose One Deterministic Editorial Document DTO

**Files:**
- Create: `src/features/inspiration-visuals/document-contracts.ts`
- Create: `src/features/inspiration-visuals/document-composer.ts`
- Create: `src/features/inspiration-visuals/document-composer.test.ts`
- Modify: `src/features/inspiration/share-service.ts`
- Modify: `src/features/inspiration/share-service.integration.test.ts`

**Interfaces:**
- Produces: `InspirationDocumentDto`, `composeInspirationDocument`, and a public shared-page DTO.
- Consumes: validated text result/sources and active completed visual assets.

- [ ] **Step 1: Write failing composer tests**

Test exact document order and these rules:

- unique hero becomes `document.hero`; no hero yields `null` without moving a product.
- evidence with overlapping source indexes attaches to the first matching market signal.
- remaining evidence fills unillustrated market signals by ordinal without duplication.
- products appear only in `products` and preserve brand/site, name, optional price, and source link.
- all six dimension keys appear in fixed vertical order.
- library matches attach by `directionIndex`; null-direction matches enter `unassignedLibraryMatches`.
- concepts attach only by direction and remain a future-compatible empty collection in phase one.
- public composition strips library matches and uses share asset URLs.
- 0, 1, 4, and 8 web assets produce valid strict DTOs.

- [ ] **Step 2: Define strict document schemas**

Model the spec DTO plus `unassignedLibraryMatches` and phase-one `visualState`:

```ts
type InspirationDocumentDto = {
  hero: WebEvidenceAssetDto | null;
  intro: { headline: string; summary: string; confidenceNote: string };
  marketSignals: Array<{ signal: TrendFacet; evidence: WebEvidenceAssetDto[] }>;
  dimensions: Array<{ key: DimensionKey; label: string; items: TrendFacet[] }>;
  products: WebEvidenceAssetDto[];
  directions: Array<{
    direction: InspirationPrompt;
    libraryMatches: LibraryMatchAssetDto[];
    concepts: GeneratedConceptAssetDto[];
  }>;
  unassignedLibraryMatches: LibraryMatchAssetDto[];
  sources: InspirationSource[];
};
```

Keep job status/warnings outside this content DTO so refresh state cannot reorder the document.

- [ ] **Step 3: Implement pure deterministic composition**

The composer must not import server-only modules, inspect provider fields, fetch data, or infer roles from titles. It accepts already validated assets and returns a parsed strict DTO.

- [ ] **Step 4: Compose the public shared page on the server**

Add a service that loads the existing shared text DTO, the latest completed visual job, and public web/concept assets. Rewrite image URLs to `/share/inspiration/${shareId}/assets/${assetId}` before composition. Do not include private library matches or non-completed visual jobs.

- [ ] **Step 5: Verify and commit composition**

```bash
npm test -- src/features/inspiration-visuals/document-composer.test.ts
npm run test:integration -- src/features/inspiration/share-service.integration.test.ts
npm run typecheck
git add src/features/inspiration-visuals/document-contracts.ts src/features/inspiration-visuals/document-composer.ts src/features/inspiration-visuals/document-composer.test.ts src/features/inspiration/share-service.ts src/features/inspiration/share-service.integration.test.ts
git commit -m "feat: compose editorial inspiration documents"
```

---

### Task 10: Replace the Authenticated Mosaic with the Editorial Document

**Files:**
- Create: `src/features/inspiration/inspiration-document.tsx`
- Create: `src/features/inspiration/inspiration-document.test.tsx`
- Create: `src/features/inspiration/inspiration-hero-evidence.tsx`
- Create: `src/features/inspiration/inspiration-signal-section.tsx`
- Create: `src/features/inspiration/inspiration-dimension-sections.tsx`
- Create: `src/features/inspiration/inspiration-product-references.tsx`
- Create: `src/features/inspiration/inspiration-direction-section.tsx`
- Create: `src/features/inspiration/inspiration-evidence-dialog.tsx`
- Create: `src/features/inspiration/inspiration-visual-status.tsx`
- Modify: `src/features/inspiration/inspiration-view.tsx`
- Modify: `src/features/inspiration/inspiration-view.test.tsx`
- Modify: `src/features/inspiration/inspiration.module.css`
- Delete: `src/features/inspiration/inspiration-result.tsx`
- Delete: `src/features/inspiration/inspiration-result.test.tsx`
- Delete: `src/features/inspiration/inspiration-visual-board.tsx`

**Interfaces:**
- Produces: one continuous, desktop-first authenticated research document.
- Consumes: Task 9 DTO, existing query/mutation state, and authenticated resource URLs.

- [ ] **Step 1: Write failing document-rendering tests**

Cover:

- DOM order: header -> hero -> conclusion -> market signals -> six dimensions -> products -> directions/private matches -> sources.
- zero images keeps all text and shows a local visual status/action.
- one/four/eight images appear once each with stable labels.
- hero/evidence/product never cross sections.
- every web image shows source site and “打开原始页面”.
- product shows `品牌或站点 · 查看商品`; price renders only when non-null.
- image error preserves title/source/link in a same-ratio fallback.
- dialog opens by keyboard, has a name, traps/restores focus, and repeats source metadata.
- external links use `target="_blank" rel="noopener noreferrer"`.
- all dimension headings are present without tabs.
- private library matches appear only inside the relevant direction or private supplement.

- [ ] **Step 2: Run UI tests and confirm old behavior fails**

```bash
npm test -- src/features/inspiration/inspiration-document.test.tsx src/features/inspiration/inspiration-view.test.tsx
```

- [ ] **Step 3: Build the semantic components**

Use buttons for preview actions and links for original pages. Keep DOM reading order text-first even when CSS alternates the visual side. Use ordinary `<img>` for session/share byte routes with explicit `width`, `height`, `loading`, and `decoding`; do not add remote image hosts to Next config.

- [ ] **Step 4: Preserve automatic and manual visual behavior**

Keep the current automatic POST only for a newly completed analysis. Historical analyses load without automatic backfill. Disable another request while the selected report has a pending refresh. Preserve active content during pending/failed refresh and show branch-specific warnings instead of the blanket “文字报告不受影响” banner when partial content exists.

- [ ] **Step 5: Implement stable desktop-first CSS**

Acceptance details:

- reading column max width approximately 960px.
- stable media aspect ratios for loaded/loading/error states.
- market signals alternate at desktop but remain one-column in DOM and narrow layouts.
- product grid is 3 columns, then 2, then 1.
- no cards nested inside cards and no floating page-section cards.
- no viewport-scaled type, negative letter spacing, decorative orbs, or dominant one-hue palette.
- controls remain touch-sized and long source/product text wraps.

- [ ] **Step 6: Remove old renderers after all call sites move**

Delete `InspirationResult` and the summary `InspirationVisualBoard`; migrate their source-label, warning, and private-match behavior into the new components. Confirm no imports remain:

```bash
rg -n "InspirationResult|InspirationVisualBoard|dimensionTabs" src tests
```

Expected: no matches except historical docs.

- [ ] **Step 7: Verify and commit authenticated UI**

```bash
npm test -- src/features/inspiration/inspiration-document.test.tsx src/features/inspiration/inspiration-view.test.tsx
npm run typecheck
npm run lint
git diff --check
git add src/features/inspiration/inspiration-document.tsx src/features/inspiration/inspiration-document.test.tsx src/features/inspiration/inspiration-hero-evidence.tsx src/features/inspiration/inspiration-signal-section.tsx src/features/inspiration/inspiration-dimension-sections.tsx src/features/inspiration/inspiration-product-references.tsx src/features/inspiration/inspiration-direction-section.tsx src/features/inspiration/inspiration-evidence-dialog.tsx src/features/inspiration/inspiration-visual-status.tsx src/features/inspiration/inspiration-view.tsx src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/inspiration.module.css src/features/inspiration/inspiration-result.tsx src/features/inspiration/inspiration-result.test.tsx src/features/inspiration/inspiration-visual-board.tsx
git commit -m "feat: render editorial inspiration documents"
```

---

### Task 11: Bring Sharing and Deletion into the Same Lifecycle

**Files:**
- Modify: `src/features/inspiration/shared-inspiration-page.tsx`
- Modify: `src/features/inspiration/shared-inspiration-page.test.tsx`
- Modify: `src/app/(share)/share/inspiration/[shareId]/page.tsx`
- Modify: `src/app/(share)/share/inspiration/[shareId]/page.test.tsx`
- Modify: `src/app/api/inspiration-analyses/[analysisId]/route.ts`
- Modify: `src/app/api/inspiration-analyses/[analysisId]/route.test.ts`
- Modify: `src/features/inspiration/analysis-service.integration.test.ts`
- Modify: `src/features/inspiration-visuals/visual-service.ts`
- Modify: `src/features/inspiration-visuals/visual-repository.ts`

**Interfaces:**
- Produces: public editorial parity and analysis-level visual object cleanup.
- Consumes: Task 8 share resource route and Task 9 public document DTO.

- [ ] **Step 1: Write failing public-page and deletion tests**

Assert:

- public page renders hero/evidence/products/sources with share-local image paths.
- public page never renders library matches, refresh controls, private job state, or owner data.
- malformed/unknown/revoked share IDs 404 before leaking detail.
- deleting an owned analysis captures its research object keys, deletes the database row/visual rows, then best-effort deletes objects.
- object deletion failure does not restore the analysis.
- foreign analysis deletion remains indistinguishable from missing.
- saved pattern/library data is untouched.

- [ ] **Step 2: Render the shared composed DTO**

Load the public page DTO once in the dynamic share route and pass it to `SharedInspirationPage`. Reuse `InspirationDocument` in read-only/public mode; do not fork markup or rebuild source mapping in the page component.

- [ ] **Step 3: Add the visual lifecycle delete wrapper**

Implement `deleteInspirationWithVisualAssets({ ownerId, analysisId })` in `visual-service.ts`: list owned research object keys, call the existing analysis deletion (which cascades database rows), then best-effort delete the captured keys. Change only the API DELETE route to use this wrapper, avoiding a dependency from core analysis service into OSS/provider code.

- [ ] **Step 4: Verify and commit share/lifecycle behavior**

```bash
npm test -- src/features/inspiration/shared-inspiration-page.test.tsx 'src/app/(share)/share/inspiration/[shareId]/page.test.tsx' 'src/app/api/inspiration-analyses/[analysisId]/route.test.ts'
npm run test:integration -- src/features/inspiration/share-service.integration.test.ts src/features/inspiration/analysis-service.integration.test.ts src/features/inspiration-visuals/visual-resource-service.integration.test.ts
npm run typecheck
git add src/features/inspiration/shared-inspiration-page.tsx src/features/inspiration/shared-inspiration-page.test.tsx 'src/app/(share)/share/inspiration/[shareId]/page.tsx' 'src/app/(share)/share/inspiration/[shareId]/page.test.tsx' 'src/app/api/inspiration-analyses/[analysisId]/route.ts' 'src/app/api/inspiration-analyses/[analysisId]/route.test.ts' src/features/inspiration/analysis-service.integration.test.ts src/features/inspiration-visuals/visual-service.ts src/features/inspiration-visuals/visual-repository.ts
git commit -m "feat: share and clean inspiration visuals"
```

---

### Task 12: Add Browser Fixtures, Real-Service Gates, and Release Documentation

**Files:**
- Create: `src/features/inspiration-visuals/web-agent-provider.real.test.ts`
- Modify: `package.json`
- Create: `tests/e2e/inspiration-document-fixtures.ts`
- Create: `tests/e2e/inspiration-document.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: reproducible viewport QA, one-request real Agent verification, and a flags-off production runbook.
- Consumes: all phase-one implementation tasks.

- [ ] **Step 1: Add metadata-only browser fixtures**

Seed one completed analysis, one completed visual job, hero/evidence/product rows, direction-scoped and unassigned library matches, and an active share. Intercept only the app resource byte routes with fixed local raster fixtures; do not place remote URLs or real OSS credentials in Playwright.

- [ ] **Step 2: Write browser tests for target states and sizes**

At `1512x982`, `1280x800`, and `390x844`, verify:

- no body/document horizontal overflow.
- document section order and 960px reading measure.
- 0, 1, 4, and 8-image states do not overlap or resize controls.
- product grid changes 3 -> 2 -> 1 columns as space narrows.
- broken image keeps source link and stable media box.
- dialog is keyboard reachable and restores focus.
- authenticated view contains private matches; shared view does not.
- revoked share page and asset URL return 404.

Add `inspiration-document.spec.ts` to the metadata-only Playwright match list.

- [ ] **Step 3: Add the one-request real Agent smoke**

Add:

```json
"test:inspiration:web-real": "RUN_REAL_INSPIRATION_WEB_TESTS=1 vitest run src/features/inspiration-visuals/web-agent-provider.real.test.ts"
```

The test uses one fixed fashion/material intent set, makes one Agent call, validates structured candidates, and prints only counts and stable request IDs. It does not download images or print URLs/credentials.

- [ ] **Step 4: Document configuration and release/rollback**

Document:

- Agent ID/version and feature flag setup.
- required private OSS permissions and 30-day research-prefix lifecycle.
- offline, real Agent, and real end-to-end smoke commands.
- flags-off migration/code deployment, candidate process, source-page verification, blue-green cutover, private-invite enablement, and rollback by disabling `INSPIRATION_WEB_VISUALS_ENABLED`.
- telemetry limited to stable codes, job durations, imported counts, failure counts, memory, and OSS growth; no query text or remote URLs.

- [ ] **Step 5: Run the complete offline release gate**

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e -- tests/e2e/inspiration-document.spec.ts --project=chromium-desktop
git diff --check
```

Expected: every command exits 0. Do not run the real Agent test without explicitly supplied credentials.

- [ ] **Step 6: Run real and visual gates before production enablement**

With the candidate environment only:

```bash
npm run test:inspiration:web-real
```

Then create one real report and require at least one hero, one evidence, and one reliable product image; open every original page; test refresh retention, owner/share bytes, share revocation, and delete cleanup. Capture screenshots at all three target viewports and inspect them for overlap, blank media, clipping, or source-link loss. A missing reliable product fails the release gate; do not fabricate a product card.

- [ ] **Step 7: Commit tests and runbook**

```bash
git add src/features/inspiration-visuals/web-agent-provider.real.test.ts package.json tests/e2e/inspiration-document-fixtures.ts tests/e2e/inspiration-document.spec.ts playwright.config.ts README.md
git commit -m "test: gate editorial inspiration rollout"
```

---

## Phase-One Acceptance Checklist

- [ ] A new completed text report becomes readable immediately and starts one visual enhancement automatically.
- [ ] The report is one continuous editorial document; there is no empty standalone visual-summary mosaic and no hidden dimension tabs.
- [ ] Every web image uses an application-local byte route and shows a source site plus original-page link.
- [ ] Product references have a real image, reliable product name, brand/site, and original product page; uncertain candidates are evidence instead.
- [ ] The active job contains at most 8 web images, at most 1 hero, and at most 4 products.
- [ ] Provider HTML, remote image URLs, OSS keys/hosts, credentials, owner IDs, and raw internal failures never reach browser DTOs or logs.
- [ ] HTTPS, public-address validation, DNS pinning, redirect, byte, time, MIME, magic, dimension, and pixel limits are enforced.
- [ ] Web and library branches degrade independently; all visual failures leave the text document intact.
- [ ] Refresh atomically replaces a completed visual set and preserves the previous set on pending or failure.
- [ ] Owners and active shares can read only their authorized completed assets; revoked shares and cross-owner requests receive the same 404 shape.
- [ ] Shared documents exclude private library matches and internal visual state.
- [ ] Analysis deletion cascades visual rows and best-effort deletes research objects without touching saved library patterns.
- [ ] Authenticated and shared pages pass at `1512x982`, `1280x800`, and `390x844` with no overlap or horizontal overflow.
- [ ] Offline gates, one-request real Agent smoke, real hero/evidence/product report, source-page checks, and flags-off candidate deployment pass before the private-invite flag is enabled.
