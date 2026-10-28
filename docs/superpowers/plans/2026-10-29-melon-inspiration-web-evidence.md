# Inspiration Web Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add source-linked public web evidence images to the visual board through Qwen Web Search Agent, a rebinding-safe importer, private OSS caching, and owner/share-authorized resource routes.

**Architecture:** Extend the phase-one research visual service with an injected web-evidence provider and importer. The provider parses only structured image messages from bounded SSE. The importer validates and pins every HTTPS connection, verifies image bytes, writes approved images to an inspiration-specific OSS adapter, and persists only object keys. Application routes read bytes back after owner or active-share authorization; no remote/provider/storage URL reaches the browser.

**Tech Stack:** Node.js 24 `https`/`dns`/Web Streams, Next.js 16.4.1 Route Handlers, Zod 4, Alibaba Cloud Web Search Agent SSE API, `ali-oss`, PostgreSQL/Drizzle, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-melon-inspiration-visual-board-design.md`

**Prerequisite:** Complete `docs/superpowers/plans/2026-10-29-melon-inspiration-visual-foundation.md` first.

## Global Constraints

- Use the official `POST https://dashscope.aliyuncs.com/api/v2/apps/web-search-agent/chat/completions` contract with `stream: true` and `enable_text_image_mixed: true`.
- Parse only `message.additional_kwargs.data_type === "image"` and validated `data_json`; never parse or render provider HTML.
- Accept only credential-free HTTPS image and source-page URLs. HTTP candidates are skipped even if the provider returns them.
- A DNS preflight alone is insufficient. The actual TLS request must use a validated, pinned address and the original hostname as SNI/Host.
- Maximums: 3 redirects, 16 KiB response headers, 8 MiB body, 15-second total deadline, 5-second idle deadline, 40 million decoded pixels, 2 MiB provider SSE.
- Permit JPEG, PNG, WebP, and GIF only. MIME, magic bytes, and dimensions must agree. Reject SVG, HTML, multipart, scripts, truncation, and polyglot ambiguity.
- Never log API keys, Authorization headers, response bodies, full temporary/image URLs, URL query strings, or OSS object keys.
- Do not extend the pattern-only `OssAdapter`; use a separate inspiration object-store contract so existing upload/trash fakes remain unchanged.
- Store web cache objects under `users/{ownerId}/inspiration/{analysisId}/research/{jobId}/{assetId}.{ext}`.
- Resource responses must be byte responses, not redirects, and must use `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-store`.
- Provider/import failures are per-image and non-fatal when library matches exist.
- Real Agent tests are opt-in and make at most one known request.

---

## File Map

### New files

- `src/features/inspiration-visuals/web-agent-contracts.ts`: bounded provider image/SSE schemas.
- `src/features/inspiration-visuals/web-agent-protocol.ts`: request builder and structured SSE parser.
- `src/features/inspiration-visuals/web-agent-protocol.test.ts`: chunking, malformed data, and HTML-ignorance tests.
- `src/features/inspiration-visuals/web-agent-provider.ts`: deadline-bound Agent HTTP adapter.
- `src/features/inspiration-visuals/web-agent-provider.test.ts`: transport, timeout, cap, and redaction tests.
- `src/features/inspiration-visuals/web-agent-provider.real.test.ts`: opt-in one-request smoke test.
- `src/features/inspiration-visuals/remote-address.ts`: public-IP classification and DNS pin selection.
- `src/features/inspiration-visuals/remote-address.test.ts`: IPv4/IPv6 private/reserved cases.
- `src/features/inspiration-visuals/image-sniffer.ts`: MIME/magic/dimension validation.
- `src/features/inspiration-visuals/image-sniffer.test.ts`: valid/truncated/polyglot fixtures.
- `src/features/inspiration-visuals/safe-image-fetch.ts`: pinned HTTPS redirect/size/deadline reader.
- `src/features/inspiration-visuals/safe-image-fetch.test.ts`: SSRF, redirect, timeout, and bounds tests.
- `src/features/inspiration-visuals/visual-object-keys.ts`: canonical inspiration object keys and prefixes.
- `src/features/inspiration-visuals/visual-object-store.ts`: dedicated OSS put/get/delete adapter.
- `src/features/inspiration-visuals/visual-object-store.test.ts`: SDK mapping and key validation tests.
- `src/features/inspiration-visuals/web-evidence-importer.ts`: candidate import, OSS write, and safe metadata projection.
- `src/features/inspiration-visuals/web-evidence-importer.test.ts`: partial import and cleanup tests.
- `src/features/inspiration-visuals/visual-resource-service.ts`: owner/share authorization and byte reads.
- `src/features/inspiration-visuals/visual-resource-service.integration.test.ts`: tenant/share/revocation tests.
- `src/app/api/inspiration-visual-assets/[assetId]/route.ts`: authenticated byte route.
- `src/app/api/inspiration-visual-assets/[assetId]/route.test.ts`: authenticated resource contract.
- `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.ts`: active-share byte route.
- `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts`: public resource contract.
- `src/features/inspiration/inspiration-evidence-dialog.tsx`: large preview, metadata, and source action.

### Modified files

- `src/lib/env/server.ts`: Agent feature gate, ID/version, and image cap.
- `src/lib/env/server.test.ts`: enabled/disabled configuration tests.
- `src/lib/env/production-readiness.ts`: enabled Agent release checks.
- `src/lib/env/production-readiness.test.ts`: production gate tests.
- `.env.example`: disabled defaults and lifecycle note.
- `src/features/inspiration-visuals/visual-service.ts`: run provider/importer alongside library matching.
- `src/features/inspiration-visuals/visual-service.integration.test.ts`: web partial-success/refresh/compensation cases.
- `src/features/inspiration-visuals/visual-repository.ts`: web asset projection and resource lookups.
- `src/features/inspiration-visuals/contracts.ts`: web URL builders and public board DTO.
- `src/features/inspiration-visuals/contracts.test.ts`: web/public secrecy tests.
- `src/features/inspiration/share-service.ts`: compose completed public visual assets.
- `src/features/inspiration/shared-inspiration-page.tsx`: render public web evidence.
- `src/features/inspiration/shared-inspiration-page.test.tsx`: source label and private-match exclusion.
- `src/features/inspiration/inspiration-visual-board.tsx`: evidence mosaic and preview dialog.
- `src/features/inspiration/inspiration-view.test.tsx`: web loading/partial/error interactions.
- `src/features/inspiration/inspiration.module.css`: evidence tile, label, dialog, and fallback styles.
- `src/app/api/inspiration-analyses/[analysisId]/route.ts`: use visual lifecycle wrapper for deletion cleanup.
- `src/features/inspiration/analysis-service.integration.test.ts`: analysis deletion regression.
- `package.json`: opt-in real Agent smoke script.
- `README.md`: setup, feature flag, OSS lifecycle, smoke, and rollout instructions.
- `tests/e2e/inspiration-visuals-fixtures.ts`: direct database/OSS visual report fixtures.
- `tests/e2e/inspiration-visuals.spec.ts`: owner/share evidence workflow and viewport checks.

---

### Task 1: Gate and Document the Web Evidence Configuration

**Files:**
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`
- Modify: `src/lib/env/production-readiness.ts`
- Modify: `src/lib/env/production-readiness.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: typed `INSPIRATION_WEB_VISUALS_ENABLED`, Agent ID/version, and max image count.
- Consumes: existing `INSPIRATION_ENABLED`, `DASHSCOPE_API_KEY`, and OSS configuration.

- [ ] **Step 1: Write failing environment tests**

Cover disabled blank defaults; enabled mode requiring base inspiration plus API key, Agent ID, and version; ID format; `beta | release`; image bounds 4 and 12; invalid 3/13; and production readiness refusing an enabled but incomplete setup.

- [ ] **Step 2: Run focused environment tests**

Run: `npm test -- src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts`

Expected: FAIL because the new keys are absent.

- [ ] **Step 3: Implement exact schema fields**

```ts
INSPIRATION_WEB_VISUALS_ENABLED: optionalBoolean,
DASHSCOPE_WEB_SEARCH_AGENT_ID: optionalTrimmedNonBlankString,
DASHSCOPE_WEB_SEARCH_AGENT_VERSION: z.preprocess(blankToUndefined, z.enum(["beta", "release"]).optional()),
INSPIRATION_VISUAL_MAX_IMAGES: z.coerce.number().int().min(4).max(12).default(8),
```

When web visuals are enabled, require `INSPIRATION_ENABLED=true`, `DASHSCOPE_API_KEY`, an Agent ID matching `^aid-[A-Za-z0-9_-]{3,128}$`, and version. Do not add a configurable endpoint; keeping the official HTTPS host constant prevents endpoint injection.

- [ ] **Step 4: Document release behavior**

Add disabled values to `.env.example` and state that `users/*/inspiration/*/research/*` needs a 30-day OSS lifecycle rule before production enablement. Production readiness should emit a dedicated stable error when the web flag is enabled without valid Agent configuration.

- [ ] **Step 5: Run and commit configuration**

```bash
npm test -- src/lib/env/server.test.ts src/lib/env/production-readiness.test.ts
git add src/lib/env/server.ts src/lib/env/server.test.ts src/lib/env/production-readiness.ts src/lib/env/production-readiness.test.ts .env.example
git commit -m "feat: gate inspiration web evidence"
```

---

### Task 2: Parse the Qwen Web Search Agent SSE Protocol

**Files:**
- Create: `src/features/inspiration-visuals/web-agent-contracts.ts`
- Create: `src/features/inspiration-visuals/web-agent-protocol.ts`
- Create: `src/features/inspiration-visuals/web-agent-protocol.test.ts`
- Create: `src/features/inspiration-visuals/web-agent-provider.ts`
- Create: `src/features/inspiration-visuals/web-agent-provider.test.ts`

**Interfaces:**
- Produces: `WebEvidenceProvider.search`, `buildWebAgentRequest`, `parseWebAgentStream`.
- Consumes: validated analysis prompt/result and server env.

- [ ] **Step 1: Write failing protocol fixture tests**

Feed SSE split between every possible byte boundary. Test CRLF/LF, comments, blank events, multiple `data:` lines, malformed JSON, non-200 chunks, unknown messages, duplicate candidates, oversized `data_json`, more than 2 MiB, and a provider message whose HTML contains an image while `additional_kwargs` is empty. The HTML-only case must return no candidates.

- [ ] **Step 2: Run protocol tests before implementation**

Run: `npm test -- src/features/inspiration-visuals/web-agent-protocol.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Build the fixed request from validated report fields**

```ts
export function buildWebAgentRequest(input: WebAgentSearchInput, config: WebAgentConfig) {
  return {
    stream: true,
    input: {
      request_id: input.requestId,
      messages: [{ role: "user", content: buildVisualEvidencePrompt(input) }],
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
}
```

The prompt may contain only the validated user brief, headline, summary, dimension names, and direction fields. Ask for 6–8 representative fashion/product/material images with original pages. Do not include source-page bodies or provider output from the text analysis.

- [ ] **Step 4: Implement a bounded incremental SSE parser**

Read `ReadableStream<Uint8Array>` with `TextDecoder(..., { stream: true })`, cap accumulated undecoded/event bytes at 2 MiB, and parse only `data:` events. Validate this path:

```ts
output.choices[0].message.additional_kwargs = {
  data_type: "image",
  data_json: [{
    idx, query, url, title,
    image_info: { url: imageUrl, width, height },
  }],
};
```

Bound each string, URL, width/height, array length, and candidate count before deduping. Ignore `content` completely. Return candidates plus the platform `request_id`; never return the raw chunk.

- [ ] **Step 5: Implement the provider adapter and stable errors**

POST to the constant endpoint with `Authorization: Bearer ...`, `Content-Type: application/json`, and a 60-second abort deadline. Require `200` and `text/event-stream`. Map abort, transport, malformed, non-200, and empty cases to `INSPIRATION_VISUALS_UNAVAILABLE` or `INSPIRATION_VISUALS_EMPTY`. Error messages/log metadata may contain only stable code and validated request ID.

- [ ] **Step 6: Run provider tests and commit**

```bash
npm test -- src/features/inspiration-visuals/web-agent-protocol.test.ts src/features/inspiration-visuals/web-agent-provider.test.ts
git add src/features/inspiration-visuals/web-agent-*.ts
git commit -m "feat: parse inspiration web evidence"
```

---

### Task 3: Implement Rebinding-Safe Image Fetching and Byte Validation

**Files:**
- Create: `src/features/inspiration-visuals/remote-address.ts`
- Create: `src/features/inspiration-visuals/remote-address.test.ts`
- Create: `src/features/inspiration-visuals/image-sniffer.ts`
- Create: `src/features/inspiration-visuals/image-sniffer.test.ts`
- Create: `src/features/inspiration-visuals/safe-image-fetch.ts`
- Create: `src/features/inspiration-visuals/safe-image-fetch.test.ts`

**Interfaces:**
- Produces: `fetchRemoteImage(url, dependencies?) -> { bytes, contentType, extension, width, height }`.
- Consumes: Node `dns.promises.lookup`, `https.request`, and injected equivalents in tests.

- [ ] **Step 1: Write failing public-address classification tests**

Cover IPv4 loopback, RFC1918, link-local, carrier-grade NAT, documentation, multicast, unspecified, benchmark, reserved, and IPv4-mapped IPv6. Cover IPv6 loopback, unique-local, link-local, multicast, documentation, unspecified, and public addresses. A hostname is valid only when every resolved address is public; mixed public/private answers are rejected.

- [ ] **Step 2: Write failing image-sniffer tests**

Use byte fixtures for PNG, baseline/progressive JPEG, WebP VP8/VP8L/VP8X, GIF87a/GIF89a, truncated headers, MIME mismatch, HTML/SVG, huge dimensions, and malformed JPEG segment lengths. Assert exact content type/extension/dimensions.

- [ ] **Step 3: Write failing pinned-request tests**

Use an injected DNS resolver and request factory. Assert the actual request receives a `lookup` callback pinned to the validated address, `servername` and `Host` use the original hostname, redirects are revalidated, credentials/fragments/HTTP are rejected, four redirects fail, header/body/deadline/idle caps abort the socket, and bodies stop at 8 MiB plus one byte.

- [ ] **Step 4: Implement URL and address validation**

```ts
function parseRemoteHttpsUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw unsafeRemoteImage();
  }
  return url;
}
```

Resolve with `{ all: true, verbatim: true }`, reject an empty/mixed/non-public set, and choose one validated address. For IP-literal hosts, classify the literal without DNS. Do this again for every redirect target.

- [ ] **Step 5: Implement the pinned TLS request**

Use `https.request` rather than `fetch` so DNS cannot be re-resolved behind the validation step:

```ts
const request = httpsRequest({
  protocol: "https:", hostname: url.hostname, port: url.port || 443,
  path: `${url.pathname}${url.search}`, method: "GET",
  servername: url.hostname, maxHeaderSize: 16 * 1024,
  headers: { Host: url.host, Accept: "image/webp,image/png,image/jpeg,image/gif" },
  lookup: (_hostname, options, callback) => callback(null, pinned.address, pinned.family),
});
```

The concrete TypeScript callback signature must match Node 24 overloads; lock it with `npm run typecheck`. Handle redirects manually, reject non-2xx, validate `Content-Length`, disallow `multipart/*`, stream into bounded chunks, and call the sniffer after completion. Do not advertise AVIF because it is not in the allowed result set.

- [ ] **Step 6: Run security tests and commit**

```bash
npm test -- src/features/inspiration-visuals/remote-address.test.ts src/features/inspiration-visuals/image-sniffer.test.ts src/features/inspiration-visuals/safe-image-fetch.test.ts
npm run typecheck
git add src/features/inspiration-visuals/remote-address* src/features/inspiration-visuals/image-sniffer* src/features/inspiration-visuals/safe-image-fetch*
git commit -m "feat: safely import remote evidence images"
```

---

### Task 4: Add an Inspiration-Specific OSS Object Store and Importer

**Files:**
- Create: `src/features/inspiration-visuals/visual-object-keys.ts`
- Create: `src/features/inspiration-visuals/visual-object-store.ts`
- Create: `src/features/inspiration-visuals/visual-object-store.test.ts`
- Create: `src/features/inspiration-visuals/web-evidence-importer.ts`
- Create: `src/features/inspiration-visuals/web-evidence-importer.test.ts`

**Interfaces:**
- Produces: `VisualObjectStore`, Alibaba implementation, canonical research/concept keys, and `importWebEvidence`.
- Consumes: `createDefaultCredentialResolver`, OSS connection config, and `fetchRemoteImage`.

- [ ] **Step 1: Write failing key/store tests**

Test canonical UUID normalization; path traversal; wrong owner/analysis/job; put content type; get byte copying; delete batching; client recreation after credential/client failure; and rejection of pattern keys by the visual adapter.

- [ ] **Step 2: Implement the narrow store contract**

```ts
export interface VisualObjectStore {
  put(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  delete(keys: readonly string[]): Promise<void>;
}
```

Use `ali-oss` methods `put`, `get`, and `deleteMulti` with the same credential resolver/retry-zero/timeout posture as the existing adapter. Validate every key with `parseVisualObjectKey`; do not weaken `src/features/storage/object-keys.ts`.

- [ ] **Step 3: Write failing importer tests**

Given eight candidates, prove invalid images are skipped, max count is honored, duplicate image/source pairs are removed, titles/alts are bounded, one failed OSS write does not discard other imports, and returned records contain object keys only on the server-side type.

- [ ] **Step 4: Implement bounded concurrent import**

Import at concurrency three. Generate the asset UUID before fetch, derive extension from sniffed bytes, write the canonical key, and return `{ id, objectKey, contentType, width, height, sourcePageUrl, sourceSiteName, sourceQuery, title, altText, ordinal }`. A failed fetch/write yields a stable warning and never includes the remote URL in the thrown/logged message.

- [ ] **Step 5: Run store/importer tests and commit**

```bash
npm test -- src/features/inspiration-visuals/visual-object-store.test.ts src/features/inspiration-visuals/web-evidence-importer.test.ts
git add src/features/inspiration-visuals/visual-object-keys.ts src/features/inspiration-visuals/visual-object-store* src/features/inspiration-visuals/web-evidence-importer*
git commit -m "feat: cache inspiration evidence in oss"
```

---

### Task 5: Integrate Web Evidence with Research Visual Jobs

**Files:**
- Modify: `src/features/inspiration-visuals/visual-service.ts`
- Modify: `src/features/inspiration-visuals/visual-service.integration.test.ts`
- Modify: `src/features/inspiration-visuals/visual-repository.ts`
- Modify: `src/features/inspiration-visuals/contracts.ts`
- Modify: `src/features/inspiration-visuals/contracts.test.ts`

**Interfaces:**
- Produces: one combined research job with independent web/library outcomes and compensating object cleanup.
- Consumes: web provider, importer, object store, matcher, and repository transaction.

- [ ] **Step 1: Add failing integration cases**

Cover: web+library success; web only; library only with web warning; both empty -> failed; provider disabled -> warning; individual bad images skipped; database completion failure deletes every just-written object; cleanup failure does not leak a URL/error body; successful refresh switches active job only after commit; failed refresh preserves old active assets; operation replay makes no provider call.

- [ ] **Step 2: Run the service suite and verify red tests**

Run: `npm run test:integration -- src/features/inspiration-visuals/visual-service.integration.test.ts`

Expected: FAIL on the new web paths.

- [ ] **Step 3: Run web and library branches independently**

Use `Promise.allSettled` for provider/import and library matching, with separate abort signals tied to the request. A disabled provider returns the non-fatal warning `INSPIRATION_WEB_VISUALS_DISABLED`; it is not an exception. Normalize ordinals by asset kind before the completion transaction.

- [ ] **Step 4: Commit only after durable state or compensate**

Call `completeResearchJob` once with both asset groups. If it throws or loses the pending compare-and-set, delete all newly written web keys before returning the stable error. After a successful switch, best-effort delete superseded web object keys; a cleanup failure is operational telemetry, not a user-visible failed refresh.

- [ ] **Step 5: Run integration and regression suites**

```bash
npm run test:integration -- src/features/inspiration-visuals/visual-service.integration.test.ts src/features/inspiration/analysis-service.integration.test.ts
npm test -- src/features/inspiration-visuals
```

Expected: PASS.

- [ ] **Step 6: Commit orchestration**

```bash
git add src/features/inspiration-visuals/visual-service.ts src/features/inspiration-visuals/visual-service.integration.test.ts src/features/inspiration-visuals/visual-repository.ts src/features/inspiration-visuals/contracts.ts src/features/inspiration-visuals/contracts.test.ts
git commit -m "feat: attach web evidence to inspiration research"
```

---

### Task 6: Serve Authorized Visual Bytes to Owners and Active Shares

**Files:**
- Create: `src/features/inspiration-visuals/visual-resource-service.ts`
- Create: `src/features/inspiration-visuals/visual-resource-service.integration.test.ts`
- Create: `src/app/api/inspiration-visual-assets/[assetId]/route.ts`
- Create: `src/app/api/inspiration-visual-assets/[assetId]/route.test.ts`
- Create: `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.ts`
- Create: `src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts`
- Modify: `src/features/inspiration/share-service.ts`
- Modify: `src/app/(share)/share/inspiration/[shareId]/page.tsx`

**Interfaces:**
- Produces: opaque owner/share resource URLs and a public page DTO containing completed web evidence only.
- Consumes: active analysis share ID, completed asset rows, and `VisualObjectStore.get`.

- [ ] **Step 1: Write failing authorization tests**

Test valid owner, other owner 404, unknown UUID 404, library-match asset 404, failed/pending job 404, active share success, wrong/revoked share 404, share excludes private library matches, missing OSS object 404 with client-side placeholder behavior, and no bucket/key/signed URL in headers or body.

- [ ] **Step 2: Implement repository authorization lookups**

Authenticated lookup joins asset -> completed job -> analysis and filters both asset/job owner. Share lookup additionally requires `analysis.share_id = input.shareId`. Return only `{ objectKey, contentType, bytes metadata }` internally.

- [ ] **Step 3: Implement byte response helpers and routes**

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

Both routes accept UUID path parameters only. They must not accept `url`, `key`, or bucket query parameters.

- [ ] **Step 4: Compose the public visual page DTO**

Add `getSharedInspirationPage(shareId)` in the visual domain, returning `{ analysis, visuals }`. Visuals include only completed `web_evidence` (and later generated concepts); image URLs use `/share/inspiration/${shareId}/assets/${assetId}`. Keep the existing analysis share DTO unchanged and private matches absent.

- [ ] **Step 5: Run resource/share tests and commit**

```bash
npm run test:integration -- src/features/inspiration-visuals/visual-resource-service.integration.test.ts src/features/inspiration/share-service.integration.test.ts
npm test -- 'src/app/api/inspiration-visual-assets/[assetId]/route.test.ts' 'src/app/(share)/share/inspiration/[shareId]/assets/[assetId]/route.test.ts'
git add src/features/inspiration-visuals/visual-resource-service* src/app/api/inspiration-visual-assets 'src/app/(share)/share/inspiration/[shareId]/assets' src/features/inspiration/share-service.ts 'src/app/(share)/share/inspiration/[shareId]/page.tsx'
git commit -m "feat: authorize inspiration visual resources"
```

---

### Task 7: Render Evidence, Handle Lifecycle, and Verify the Rollout

**Files:**
- Create: `src/features/inspiration/inspiration-evidence-dialog.tsx`
- Modify: `src/features/inspiration/inspiration-visual-board.tsx`
- Modify: `src/features/inspiration/shared-inspiration-page.tsx`
- Modify: `src/features/inspiration/inspiration-view.test.tsx`
- Modify: `src/features/inspiration/shared-inspiration-page.test.tsx`
- Modify: `src/features/inspiration/inspiration.module.css`
- Modify: `src/app/api/inspiration-analyses/[analysisId]/route.ts`
- Modify: `src/features/inspiration/analysis-service.integration.test.ts`
- Create: `src/features/inspiration-visuals/web-agent-provider.real.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `tests/e2e/inspiration-visuals-fixtures.ts`
- Create: `tests/e2e/inspiration-visuals.spec.ts`

**Interfaces:**
- Produces: evidence mosaic/preview/source UX, analysis-level object cleanup, and real-service release gates.
- Consumes: authenticated/public resource URLs and existing delete route.

- [ ] **Step 1: Write failing UI and lifecycle tests**

Test evidence labels are textual, clicking opens a named dialog, source opens the original page with safe link attributes, image error shows a source-preserving placeholder, public view has no library match, revocation invalidates bytes, and report deletion removes rows before best-effort object deletion while saved library data remains untouched.

- [ ] **Step 2: Implement evidence presentation**

Use `next/image` with explicit provider dimensions and `unoptimized` for same-origin authorized resource paths. Preserve aspect ratio with CSS, not viewport-scaled type. The dialog displays title, query, site, “网络证据” label, and “打开原始页面”. Never render source HTML.

- [ ] **Step 3: Add the deletion lifecycle wrapper**

Implement `deleteInspirationWithVisualAssets({ ownerId, analysisId })` in the visual domain: list owned visual object keys, call the existing analysis deletion (which cascades rows), then best-effort delete those keys. Change only the API delete route to use the wrapper, avoiding a circular dependency from the core inspiration feature back to providers/storage.

- [ ] **Step 4: Add one opt-in real Agent smoke**

Add `test:inspiration:web-real` guarded by `RUN_REAL_INSPIRATION_WEB_TESTS=1`. It performs one fixed fashion-material query, asserts at least one structurally valid candidate or reports a stable empty result, and does not download images or print URLs/credentials.

- [ ] **Step 5: Document and run release gates**

Document Agent ID/version, the 30-day research-prefix OSS lifecycle, flags-off rollout, smoke command, and rollback (disable web flag; library/text remain available).

```bash
npm test -- src/features/inspiration-visuals src/features/inspiration
npm run test:integration -- src/features/inspiration-visuals/visual-service.integration.test.ts src/features/inspiration-visuals/visual-resource-service.integration.test.ts src/features/inspiration/analysis-service.integration.test.ts
npm run typecheck
npm run lint
npm run build
npm run test:e2e -- tests/e2e/inspiration-visuals.spec.ts --project=chromium
git diff --check
```

Expected: all offline gates exit 0. Run the real smoke only with explicitly supplied credentials.

- [ ] **Step 6: Inspect owner and share pages at target sizes**

At `1512x982`, `1280x800`, and `390x844`, verify six/eight/two/zero evidence images, source dialog overflow, broken-cache placeholders, public labels, and no content shift when images complete. Confirm DevTools never receives a remote image URL or OSS host.

- [ ] **Step 7: Commit UI, lifecycle, docs, and verification**

```bash
git add src/features/inspiration/inspiration-evidence-dialog.tsx src/features/inspiration/inspiration-visual-board.tsx src/features/inspiration/shared-inspiration-page.tsx src/features/inspiration/inspiration-view.test.tsx src/features/inspiration/shared-inspiration-page.test.tsx src/features/inspiration/inspiration.module.css src/features/inspiration/analysis-service.integration.test.ts src/features/inspiration-visuals/web-agent-provider.real.test.ts 'src/app/api/inspiration-analyses/[analysisId]/route.ts' package.json README.md tests/e2e/inspiration-visuals-fixtures.ts tests/e2e/inspiration-visuals.spec.ts
git commit -m "feat: deliver sourced inspiration evidence"
```

---

## Web Evidence Acceptance Checklist

- [ ] One research refresh makes at most one Agent call and requests mixed text/images.
- [ ] Only validated `additional_kwargs.data_json` candidates are considered; HTML is ignored.
- [ ] Every network connection is HTTPS, public-address validated, and DNS-pinned through TLS.
- [ ] Redirect, header, byte, time, idle, MIME, magic, dimension, and pixel limits are enforced.
- [ ] Browser DTOs and logs contain no provider image URL, API key, object key, bucket, or signed URL.
- [ ] Web failures remain non-fatal when library matches exist; total empty output is a visual-job failure only.
- [ ] Owners can read only their completed evidence; active shares can read only assets of that share.
- [ ] Revoked shares and cross-owner requests receive indistinguishable 404 responses.
- [ ] Refresh and delete clean up replaced/deleted objects without changing saved text reports.
- [ ] Owner/share mosaics are stable, labeled, sourced, and accessible at target viewports.
- [ ] Offline tests do not call or bill Alibaba Cloud; the real smoke is explicit and bounded.
