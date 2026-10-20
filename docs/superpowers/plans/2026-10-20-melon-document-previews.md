# Melon Document Preview Implementation Plan

**Goal:** Store PDF sources and generate flat previews for PDF, PDF-compatible AI, PSD, and Procreate files while keeping source upload independent from preview success.

**Boundaries:** PDF and AI render page/artboard one. PSD renders the composite image. Procreate reads `QuickLook/Thumbnail.png` from its package. Layers, editing, animation, and PostScript-only AI rendering are out of scope. Unsupported or failed previews remain downloadable and can receive a manual JPG/PNG cover.

**Architecture:** A browser-side preview dispatcher selects an isolated worker per format. Every renderer returns the existing preview/thumbnail blob contract, uses the shared 2048/512 limits, enforces the 100 MP pixel budget, and is terminated after 30 seconds. Upload completion remains valid with only the source asset. Manual covers use pattern-scoped temporary OSS credentials, server-side signature/dimension verification, and an atomic derived-asset replacement.

## Task 1: PDF Source Contract

- [x] Add `pdf` to upload, storage, filename, MIME, and signature contracts.
- [x] Add contract, object-key, signature, and runner tests before implementation.
- [x] Update upload picker copy and accepted extensions.

## Task 2: Unified Preview Pipeline

- [x] Add format classification and dependency-injected dispatch tests.
- [x] Generalize the raster result contract without changing OSS completion payloads.
- [x] Share worker lifecycle, timeout, and stable error mapping.

## Task 3: Automatic Professional-Format Previews

- [x] Render PSD composite images with `ag-psd`.
- [x] Render the first page of PDF and PDF-compatible AI with PDF.js.
- [x] Extract and resize the Procreate QuickLook thumbnail with `fflate`.
- [x] Keep PostScript-only AI and packages without a QuickLook thumbnail as unsupported.

## Task 4: Manual Preview Fallback

- [x] Add authenticated init/complete contracts and routes for derived assets only.
- [x] Verify ownership, optimistic version, OSS object keys, signatures, dimensions, and sizes.
- [x] Replace preview and thumbnail atomically without changing the source asset.
- [x] Add the JPG/PNG cover action to the inspector with retry/error feedback.

## Task 5: Verification

- [x] Run focused unit and integration tests during each slice.
- [x] Run `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- [x] Exercise PDF, PSD, AI, and Procreate in Chromium/WebKit, including 1024 px and light/dark UI checks.
- [x] Request code review and resolve all high-confidence findings before handoff.
