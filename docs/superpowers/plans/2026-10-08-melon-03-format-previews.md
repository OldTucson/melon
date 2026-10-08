# melon Professional Format Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded browser previews for PSD and PDF-compatible AI files plus manual JPG/PNG previews for Procreate and unsupported files, without making preview success a condition for storing the source.

**Architecture:** Route all preview work through one browser-side pipeline with isolated workers, shared geometry/output rules, a 100 MP guard and a 30-second timeout. Workers produce only derived blobs; existing phase-01 upload contracts send those blobs directly to OSS. Manual preview replacement uses an authorized derived-asset session and never changes the source asset.

**Tech Stack:** Existing browser worker pipeline, `@webtoon/psd`, PDF.js (`pdfjs-dist`), `OffscreenCanvas` with cooperative main-thread fallback, Vitest, and Playwright.

---

## File Map

```text
src/features/preview/
├── contracts.ts                  # Shared input/output/error contracts
├── preview-pipeline.ts            # Format dispatch and timeout boundary
├── canvas-output.ts               # Geometry, alpha and encoding
├── raster-preview.worker.ts       # Existing JPG/PNG path
├── psd-preview.worker.ts          # PSD composite path
├── ai-preview.worker.ts           # PDF-compatible AI path
├── main-thread-fallback.ts        # Cooperative Canvas fallback
├── manual-preview-service.ts      # Server lifecycle for replacements
├── manual-preview-dialog.tsx      # JPG/PNG picker and status UI
└── preview-placeholder.tsx        # Honest unsupported/error states
src/app/api/patterns/[patternId]/manual-preview/
├── init/route.ts
└── complete/route.ts
scripts/generate-preview-fixtures.ts
src/test/fixtures/generated-preview/  # Generated, non-copyright fixtures
tests/e2e/format-previews.spec.ts
```

## Task 1: Unify Preview Contracts, Limits, and Worker Failure Handling

**Files:**
- Modify: `src/features/preview/contracts.ts`, `raster-preview.ts`, `raster-preview.worker.ts`
- Create: `src/features/preview/preview-pipeline.ts`, `canvas-output.ts`, `main-thread-fallback.ts`
- Test: `src/features/preview/preview-pipeline.test.ts`, `canvas-output.test.ts`

- [ ] **Step 1: Write failing dispatch, limit, and timeout tests**

```ts
expect(resolvePreviewKind("poster.psd")).toBe("psd");
expect(resolvePreviewKind("poster.ai")).toBe("ai");
expect(resolvePreviewKind("poster.procreate")).toBe("manual_only");
expect(() => assertPixelBudget({ width: 10001, height: 10000 })).toThrow("PREVIEW_PIXEL_LIMIT");
await expect(runWithPreviewTimeout(neverSettles, 10)).rejects.toMatchObject({ code: "PREVIEW_TIMEOUT" });
```

Add cases proving a worker crash becomes `PREVIEW_DECODE_FAILED`, unsupported input returns `null`, and source upload orchestration continues when preview returns null or throws a typed preview error.

- [ ] **Step 2: Define one cross-format contract**

```ts
export const PREVIEW_LONG_EDGE = 2048;
export const THUMBNAIL_LONG_EDGE = 512;
export const MAX_PIXELS = 100_000_000;
export const PREVIEW_TIMEOUT_MS = 30_000;

export type PreviewResult = {
  preview: Blob;
  thumbnail: Blob;
  width: number;
  height: number;
  contentType: "image/png" | "image/webp";
  renderer: "raster" | "psd" | "pdf-ai" | "manual";
};
```

Use discriminated worker messages `{ type:"success", result }` and `{ type:"error", code }`. Never send a decoded bitmap back to the main thread after final encoding.

- [ ] **Step 3: Extract shared canvas output behavior**

`canvas-output.ts` does not upscale, produces 2048/512 longest edges, preserves alpha as PNG, uses WebP for opaque output, closes image resources, and reports sRGB intent. Its tests use generated transparent and opaque image data, not designer files.

```ts
export function fitWithin(size: { width: number; height: number }, longestEdge: number) {
  const scale = Math.min(1, longestEdge / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}
```

- [ ] **Step 4: Implement timeout and cooperative fallback**

The pipeline creates one worker per job, terminates it in `finally`, and terminates immediately on timeout. When `OffscreenCanvas` is absent, the fallback uses a normal Canvas and yields between decode, preview render, thumbnail render and encode:

```ts
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
```

It enforces the same pixel/time limits and never silently chooses a lower-quality unbounded parser.

- [ ] **Step 5: Verify and commit the shared boundary**

```bash
npm test -- src/features/preview/preview-pipeline.test.ts src/features/preview/canvas-output.test.ts src/features/preview/raster-preview.test.ts
npm run typecheck
npm run lint
git add src/features/preview
git commit -m "refactor: unify preview worker boundaries"
```

## Task 2: Add PSD Composite Preview

**Files:**
- Create: `src/features/preview/psd-preview.worker.ts`, `psd-preview.ts`
- Create: `scripts/generate-preview-fixtures.ts`
- Generate: `src/test/fixtures/generated-preview/simple.psd`, `large-dimensions.psd`, `corrupt.psd`
- Test: `src/features/preview/psd-preview.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Install parser/test writer and write failing PSD tests**

```bash
npm install @webtoon/psd
npm install --save-dev ag-psd
```

Register the deterministic fixture command:

```json
{ "scripts": { "fixtures:preview": "tsx scripts/generate-preview-fixtures.ts" } }
```

The fixture script uses `ag-psd` only in development to create a 16×16 layered PSD with known composite colors and a header fixture declaring dimensions above 100 MP. Tests expect the known output dimensions/color sample, `PREVIEW_PIXEL_LIMIT` before full decode for the large header, and `PREVIEW_DECODE_FAILED` for corrupt data.

- [ ] **Step 2: Inspect PSD dimensions before expensive decode**

Read the PSD header in the worker, require signature `8BPS`, version 1, positive width/height, and call `assertPixelBudget` before passing bytes to the parser. Reject PSB/version 2 in MVP with `PREVIEW_UNSUPPORTED` rather than attempting an unbounded parse.

```ts
const view = new DataView(buffer);
const signature = new TextDecoder("ascii").decode(buffer.slice(0, 4));
const version = view.getUint16(4, false);
const height = view.getUint32(14, false);
const width = view.getUint32(18, false);
if (signature !== "8BPS" || version !== 1) throw previewError("PREVIEW_UNSUPPORTED");
assertPixelBudget({ width, height });
```

- [ ] **Step 3: Render the composite through `@webtoon/psd`**

Load the document from an `ArrayBuffer`, request the merged/composite representation, copy it to the shared canvas output helper, and release parser buffers after encoding. Do not enumerate or retain layer names, text, or editable layer data. Mark renderer as `psd` and document that Photoshop effects may differ.

```ts
import Psd from "@webtoon/psd";
const psd = Psd.parse(buffer);
const pixels = await psd.composite();
if (!pixels) throw previewError("PREVIEW_UNSUPPORTED");
const image = new ImageData(pixels, psd.width, psd.height);
const result = await encodeImageData(image, { renderer: "psd" });
```

- [ ] **Step 4: Wire PSD dispatch and honest fallback**

`preview-pipeline.ts` sends `.psd` only to the PSD worker. Typed unsupported/decode errors set pattern `previewStatus` to `unsupported` or `failed` while source completion remains `ready`. The placeholder says “PSD 预览不可用” and retains metadata/download/manual-preview actions.

```ts
const workerByKind = { raster: rasterWorkerUrl, psd: psdWorkerUrl, ai: aiWorkerUrl } satisfies Record<Exclude<PreviewKind, "manual_only">, URL>;
```

- [ ] **Step 5: Verify and commit PSD support**

```bash
npm run fixtures:preview
npm test -- src/features/preview/psd-preview.test.ts src/features/preview/preview-pipeline.test.ts
npm run typecheck
npm run lint
git add package.json package-lock.json scripts/generate-preview-fixtures.ts src/features/preview src/test/fixtures/generated-preview
git commit -m "feat: add bounded PSD previews"
```

Expected: generated fixtures are small, deterministic, and contain no external artwork.

## Task 3: Add PDF-Compatible AI Preview

**Files:**
- Create: `src/features/preview/ai-signature.ts`, `ai-preview.worker.ts`, `ai-preview.ts`
- Modify: `scripts/generate-preview-fixtures.ts`, `src/features/preview/preview-pipeline.ts`
- Generate: `src/test/fixtures/generated-preview/pdf-compatible.ai`, `postscript-only.ai`, `corrupt.ai`
- Test: `src/features/preview/ai-preview.test.ts`

- [ ] **Step 1: Install PDF.js/test generator and write failing tests**

```bash
npm install pdfjs-dist
npm install --save-dev pdf-lib
```

Generate a one-page 32×20 PDF saved with `.ai`, a short `%!PS-Adobe` non-PDF AI fixture, and corrupt bytes. Assert the PDF fixture renders page one, PostScript returns `PREVIEW_UNSUPPORTED`, corrupt PDF returns `PREVIEW_DECODE_FAILED`, and no worker attempts PostScript interpretation.

- [ ] **Step 2: Detect compatibility before loading PDF.js**

```ts
export function classifyAiPrefix(bytes: Uint8Array): "pdf" | "postscript" | "unknown" {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  if (prefix.startsWith("%PDF-")) return "pdf";
  if (prefix.startsWith("%!PS-Adobe")) return "postscript";
  return "unknown";
}
```

Only `pdf` proceeds. Both other results map to unsupported, not failed.

- [ ] **Step 3: Render the first PDF page within limits**

Load PDF.js lazily inside the worker with scripting, external links and network fetching disabled. Read page-one viewport, calculate pixel dimensions at the target scale, enforce the 100 MP budget before render, draw to OffscreenCanvas, pass through shared output and destroy the PDF document in `finally`.

```ts
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const loading = getDocument({ data: new Uint8Array(buffer), disableAutoFetch: true, disableStream: true, isEvalSupported: false });
const pdf = await loading.promise;
try {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  assertPixelBudget({ width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
  await page.render({ canvasContext: context, viewport }).promise;
} finally { await pdf.destroy(); }
```

- [ ] **Step 4: Wire AI status and UI copy**

Compatible AI reports renderer `pdf-ai`. Non-compatible AI shows “该 AI 文件未包含 PDF 兼容内容” with manual-preview and download actions. Never label the source corrupt solely because preview is unavailable.

```ts
const aiMessage = classification === "postscript" || classification === "unknown"
  ? "该 AI 文件未包含 PDF 兼容内容"
  : "AI 预览生成失败";
```

- [ ] **Step 5: Verify and commit AI support**

```bash
npm run fixtures:preview
npm test -- src/features/preview/ai-preview.test.ts src/features/preview/preview-pipeline.test.ts
npm run typecheck
npm run lint
git add package.json package-lock.json scripts/generate-preview-fixtures.ts src/features/preview src/test/fixtures/generated-preview
git commit -m "feat: add PDF-compatible AI previews"
```

## Task 4: Add Manual Preview Replacement

**Files:**
- Create: `src/features/preview/manual-preview-service.ts`, `manual-preview-dialog.tsx`
- Create: `src/app/api/patterns/[patternId]/manual-preview/init/route.ts`
- Create: `src/app/api/patterns/[patternId]/manual-preview/complete/route.ts`
- Modify: `src/features/library/inspector.tsx`, `src/features/library/pattern-card.tsx`
- Test: `src/features/preview/manual-preview-service.integration.test.ts`
- Test: `src/features/preview/manual-preview-dialog.test.tsx`

- [ ] **Step 1: Write failing replacement and ownership tests**

Test JPG/PNG acceptance, other-format rejection, 100 MP rejection, cross-owner 404, idempotent completion, replacement of both preview/thumbnail roles, source asset identity unchanged, and old derived keys queued for deletion only after the new assets commit.

```ts
expect(result.sourceAssetId).toBe(originalSourceAssetId);
expect(result.previewStatus).toBe("manual");
expect(await currentAssetRoles(patternId)).toEqual(["preview", "source", "thumbnail"]);
expect(fakeOss.deletedKeys).toEqual(expect.arrayContaining(oldDerivedKeys));
```

- [ ] **Step 2: Reuse the secure derived-asset upload boundary**

Initialization locks an owned `ready` pattern and issues credentials only for two new derived keys under its existing prefix. Completion verifies magic bytes/dimensions through OSS, inserts new derived rows, switches current-role references, sets `previewStatus=manual`, appends a change, and returns old keys for best-effort idempotent deletion after commit.

```ts
const committed = await db.transaction((tx) => replaceDerivedAssets(tx, { ownerId, patternId, preview, thumbnail, previewStatus: "manual" }));
await oss.deleteObjects(committed.oldObjectKeys).catch((error) => enqueueObjectCleanup(committed.oldObjectKeys, error));
```

- [ ] **Step 3: Implement the manual preview dialog**

Accept one JPG/PNG, show real image preview, crop nothing, generate the standard derived sizes locally, upload with progress and allow retry. Copy states explicitly that replacing preview does not replace the PSD/AI/Procreate source. Disable while offline.

```tsx
<Dialog.Description>仅替换图库预览，不会替换原文件。</Dialog.Description>
<input aria-label="选择 JPG 或 PNG 预览" type="file" accept="image/jpeg,image/png" disabled={!capabilities.manualPreview} />
```

- [ ] **Step 4: Integrate placeholders and cache invalidation**

Expose manual preview from unsupported/failed placeholders and inspector file actions. On success invalidate the pattern detail, list thumbnail URL and cached Cache Storage entry for the old asset. Append a version query parameter to the authorized thumbnail URL so stale browser images cannot survive replacement.

```ts
await thumbnailCache.delete(oldThumbnailAssetId);
await queryClient.invalidateQueries({ queryKey: queryKeys.pattern(patternId) });
await queryClient.invalidateQueries({ queryKey: ["patterns"] });
const src = `/api/assets/${newThumbnailAssetId}/view?v=${newAssetVersion}`;
```

- [ ] **Step 5: Verify and commit manual previews**

```bash
npm run test:integration -- src/features/preview/manual-preview-service.integration.test.ts
npm test -- src/features/preview/manual-preview-dialog.test.tsx
npm run typecheck
npm run lint
git add src/features/preview src/features/library src/app/api/patterns
git commit -m "feat: add manual preview replacement"
```

## Task 5: Run Cross-Browser Preview QA and Record the Phase

**Files:**
- Create: `tests/e2e/format-previews.spec.ts`
- Create: `docs/verification/2026-10-08-format-previews.md`
- Modify: `README.md`

- [ ] **Step 1: Write browser preview journeys**

Upload each generated fixture and assert: JPG/PNG transparency/orientation, PSD thumbnail, compatible AI thumbnail, incompatible AI honest placeholder, corrupt-file fallback, and Procreate manual preview. Downloaded source hashes must match uploaded source hashes after every preview operation.

```ts
for (const fixture of previewFixtures) {
  await uploadFixture(page, fixture.path);
  await fixture.assertion(page);
  expect(await downloadSha256(page, fixture.originalFilename)).toBe(fixture.sha256);
}
```

- [ ] **Step 2: Exercise worker failure and fallback paths**

In a test-only browser hook, force worker timeout, worker exception and missing OffscreenCanvas. Assert the UI remains responsive, source reaches ready, the placeholder/action is correct, and main-thread fallback yields between phases. Run Chromium and WebKit desktop plus 1024 px WebKit.

```ts
await page.addInitScript(() => { Object.defineProperty(globalThis, "OffscreenCanvas", { value: undefined, configurable: true }); });
await uploadFixture(page, "src/test/fixtures/generated-preview/simple.psd");
await expect(page.getByText("上传完成")).toBeVisible();
```

- [ ] **Step 3: Check layout and pixels**

Capture light/dark screenshots of grid, quick preview dialog and manual-preview dialog. Use Playwright image assertions plus a canvas pixel sample to prove the decoded image is nonblank and alpha checkerboard is visible. Confirm no dialog text or controls overlap at each viewport.

```ts
await expect(page).toHaveScreenshot(`format-preview-${theme}-${projectName}.png`);
const nonBlank = await page.locator("canvas").evaluate((canvas) => Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data).some((value) => value !== 0));
expect(nonBlank).toBe(true);
```

- [ ] **Step 4: Run the phase gate**

```bash
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Expected: all required commands exit 0; generated format fixtures work in Chromium and WebKit.

- [ ] **Step 5: Record evidence and commit**

Document fixture provenance, commands, counts, browser projects, screenshots and any expected parser limitations.

```bash
git add tests/e2e/format-previews.spec.ts docs/verification/2026-10-08-format-previews.md README.md
git commit -m "test: verify professional format previews"
git status --short --branch
```

Expected: clean branch with source-file management still independent of preview success.
