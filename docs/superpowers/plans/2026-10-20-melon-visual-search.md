# Melon Self-Hosted Visual Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private, self-hosted image search that finds the source pattern from compressed, blurry, or partial images and then shows visually similar patterns.

**Architecture:** Keep Next.js as the public authentication and business-query boundary. Add pgvector-backed index tables plus a loopback-only Python service using ONNX Runtime, DINOv2, OpenCV, and an asynchronous PostgreSQL job worker; the browser sends an ephemeral query image and renders ranked Pattern DTOs in the existing library workspace.

**Tech Stack:** Next.js 16, React 19, TypeScript 6, PostgreSQL 17 + pgvector, Drizzle ORM, Zod, TanStack Query, Zustand, Python 3.10+, FastAPI, Psycopg 3, ONNX Runtime, OpenCV contrib, Pillow/pillow-heif, Alibaba Cloud OSS Python SDK V2, Vitest, Testing Library, pytest, Playwright

---

## Execution Prerequisite

The current checkout contains verified but uncommitted document-preview and card-interaction work, including files this plan later modifies (`upload-service.ts`, `manual-preview-service.ts`, `library-view.tsx`, and `globals.css`). Before Task 1, commit that work as its own reviewed change on `main`. Do not stash, revert, or absorb it into visual-search commits. Confirm with:

```bash
git status --short
git log -3 --oneline
```

Every task below stages only its listed files. Run Node commands with Node 24. Keep `IMAGE_SEARCH_ENABLED=false` until Task 12 completes.

## File Map

### Existing application

- `src/lib/db/schema/visual-search.ts`: Drizzle tables, enums, ownership constraints, and vector index declarations.
- `src/features/image-search/contracts.ts`: public request/result/status schemas and stable error codes.
- `src/features/image-search/index-repository.ts`: enqueue, publication status, retry, and rebuild database operations.
- `src/features/image-search/pattern-scope.ts`: resolve filtered Pattern IDs and hydrate ranked Pattern DTOs.
- `src/features/image-search/internal-client.ts`: authenticated loopback client for the Python service.
- `src/features/image-search/search-service.ts`: Next.js orchestration and error mapping.
- `src/features/image-search/image-search-dialog.tsx`: picker, paste/drop, preview, crop, and submit flow.
- `src/features/image-search/image-search-results.tsx`: grouped result mode capped at 30 cards.
- `src/features/image-search/image-search-store.ts`: transient open/close coordination only; query blobs and results stay in `LibraryView` component memory.
- `src/features/image-search/index-settings.tsx`: index counts and retry/rebuild controls.
- `src/app/api/image-search/route.ts`: same-origin authenticated search endpoint.
- `src/app/api/settings/image-search/route.ts`: index status endpoint.
- `src/app/api/settings/image-search/retry/route.ts`: retry failed index jobs.
- `src/app/api/settings/image-search/rebuild/route.ts`: enqueue versioned rebuild.
- `scripts/backfill-image-search.ts`: explicit idempotent backfill command.

### Python service

- `services/visual-search/pyproject.toml` and `uv.lock`: locked runtime, test, and model-export dependencies.
- `services/visual-search/src/melon_visual_search/settings.py`: validated environment configuration.
- `services/visual-search/src/melon_visual_search/image_io.py`: bounded decode, orientation, color, and tiling.
- `services/visual-search/src/melon_visual_search/embedding.py`: model checksum validation and batched DINOv2 inference.
- `services/visual-search/src/melon_visual_search/local_features.py`: pHash, SIFT serialization, and geometric verification.
- `services/visual-search/src/melon_visual_search/scoring.py`: versioned classification rules.
- `services/visual-search/src/melon_visual_search/repository.py`: job leasing, vector publication, recall, and heartbeat SQL.
- `services/visual-search/src/melon_visual_search/storage.py`: OSS V2 and in-memory test adapters.
- `services/visual-search/src/melon_visual_search/worker.py`: one-job-at-a-time indexing loop.
- `services/visual-search/src/melon_visual_search/search.py`: online query pipeline.
- `services/visual-search/src/melon_visual_search/app.py`: loopback FastAPI application.
- `services/visual-search/src/melon_visual_search/benchmark.py`: deterministic real-library evaluation.
- `services/visual-search/tools/export_model.py`: pinned Hugging Face to ONNX export and checksum lock generation.

## Phase 1: Data and Runtime Foundations

### Task 1: Add pgvector and the versioned index schema

**Files:**
- Create: `src/lib/db/schema/visual-search.ts`
- Create: `src/lib/db/schema/visual-search.integration.test.ts`
- Modify: `src/lib/db/schema/index.ts`
- Modify: `src/lib/db/schema/assets.ts`
- Modify: `src/test/database.ts`
- Modify: `compose.yaml`
- Create: `drizzle/0005_melon_visual_search.sql`
- Create: `drizzle/meta/0005_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1: Write failing ownership, vector, and active-version schema tests**

Create integration tests that insert two owners, one pattern and preview per owner, then assert vector dimensions, ownership, and publication rules:

```ts
it("keeps one ready document per pattern and version", async () => {
  const first = await insertDocument({ ownerId, patternId, previewAssetId, status: "ready" });
  await expect(
    insertDocument({
      ownerId,
      patternId,
      previewAssetId,
      previewHash: "b".repeat(64),
      status: "ready",
      id: randomUUID(),
    }),
  ).rejects.toThrow();
  await db.update(visualSearchDocuments)
    .set({ status: "superseded" })
    .where(eq(visualSearchDocuments.id, first.id));
  await expect(
    insertDocument({
      ownerId,
      patternId,
      previewAssetId,
      previewHash: "b".repeat(64),
      status: "ready",
      id: randomUUID(),
    }),
  ).resolves.toBeDefined();
});

it("rejects embeddings and preview assets from another owner", async () => {
  await expect(insertForeignOwnedDocument()).rejects.toThrow();
  await expect(insertEmbedding({ dimensions: 383 })).rejects.toThrow();
});

it("cascades preview deletion into documents, embeddings, and jobs", async () => {
  await db.delete(assets).where(eq(assets.id, previewAssetId));
  expect(await countRows(visualSearchDocuments)).toBe(0);
  expect(await countRows(visualSearchEmbeddings)).toBe(0);
  expect(await countRows(visualSearchJobs)).toBe(0);
});
```

- [ ] **Step 2: Run the schema test and verify the expected failure**

Run:

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/lib/db/schema/visual-search.integration.test.ts'
```

Expected: FAIL because `visual-search.ts` and the pgvector extension do not exist.

- [ ] **Step 3: Define the Drizzle schema**

Use Drizzle's native `vector` and `bit` columns. The central declarations must have these exact shapes:

```ts
export const visualSearchDocumentStatusEnum = pgEnum(
  "visual_search_document_status",
  ["pending", "indexing", "ready", "failed", "superseded"],
);
export const visualSearchJobStatusEnum = pgEnum(
  "visual_search_job_status",
  ["pending", "leased", "complete", "failed"],
);

export const visualSearchDocuments = pgTable("visual_search_documents", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  patternId: uuid("pattern_id").notNull(),
  previewAssetId: uuid("preview_asset_id").notNull(),
  previewHash: text("preview_hash").notNull(),
  indexVersion: text("index_version").notNull(),
  status: visualSearchDocumentStatusEnum("status").notNull(),
  phash: bit("phash", { dimensions: 64 }),
  width: integer("width"),
  height: integer("height"),
  localFeatureObjectKey: text("local_feature_object_key"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  indexedAt: timestamp("indexed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.ownerId, table.patternId],
    foreignColumns: [patterns.ownerId, patterns.id],
    name: "visual_search_documents_owner_pattern_fk",
  }),
  foreignKey({
    columns: [table.ownerId, table.patternId, table.previewAssetId],
    foreignColumns: [assets.ownerId, assets.patternId, assets.id],
    name: "visual_search_documents_preview_fk",
  }).onDelete("cascade"),
  unique("visual_search_documents_identity_unique").on(
    table.id, table.ownerId, table.patternId,
  ),
  unique("visual_search_documents_fingerprint_unique").on(
    table.ownerId, table.patternId, table.indexVersion, table.previewHash,
  ),
  uniqueIndex("visual_search_documents_ready_unique")
    .on(table.ownerId, table.patternId, table.indexVersion)
    .where(sql`${table.status} = 'ready'`),
]);

export const visualSearchEmbeddings = pgTable("visual_search_embeddings", {
  documentId: uuid("document_id").notNull(),
  ownerId: uuid("owner_id").notNull(),
  patternId: uuid("pattern_id").notNull(),
  regionIndex: integer("region_index").notNull(),
  regionKind: text("region_kind", { enum: ["global", "tile"] }).notNull(),
  x: real("x").notNull(),
  y: real("y").notNull(),
  width: real("width").notNull(),
  height: real("height").notNull(),
  embedding: vector("embedding", { dimensions: 384 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.documentId, table.regionIndex] }),
  foreignKey({
    columns: [table.documentId, table.ownerId, table.patternId],
    foreignColumns: [
      visualSearchDocuments.id,
      visualSearchDocuments.ownerId,
      visualSearchDocuments.patternId,
    ],
    name: "visual_search_embeddings_document_owner_fk",
  }).onDelete("cascade"),
  index("visual_search_embeddings_owner_pattern_idx").on(table.ownerId, table.patternId),
  index("visual_search_embeddings_hnsw_idx")
    .using("hnsw", table.embedding.op("vector_cosine_ops"))
    .with({ m: 16, efConstruction: 64 }),
]);
```

Add `unique("assets_owner_pattern_id_unique").on(table.ownerId, table.patternId, table.id)` to `assets`; PostgreSQL requires that exact referenced column set for the document/job composite foreign keys. Define `visualSearchJobs` with immutable preview asset identity, nullable `previewHash` until the worker downloads legacy previews, a unique `(ownerId, patternId, previewAssetId, indexVersion)` constraint, lease timestamps, five-attempt accounting, and cascade on preview deletion. Define `visualSearchWorkers` with `workerId`, `indexVersion`, and `lastSeenAt`.

- [ ] **Step 4: Generate and inspect the migration**

Change the local image to `pgvector/pgvector:pg17`, export the schema, update `resetDatabase()` so child tables are truncated before `assets`, and generate the migration:

```bash
docker compose pull postgres
docker compose up -d postgres
npx --yes --package=node@24 -c 'npm run db:generate -- --name melon_visual_search'
```

The migration must begin with:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

It must include `vector(384)`, `bit(64)`, the partial ready-document unique index, the cosine HNSW index, composite owner foreign keys, and cascade rules. Record a deployment preflight requiring pgvector 0.8.0 or newer for iterative filtered scans. Rename the generated migration to `0005_melon_visual_search.sql` only if Drizzle did not use that deterministic name, and keep the journal/snapshot consistent.

- [ ] **Step 5: Apply the migration and rerun focused tests**

Run:

```bash
npx --yes --package=node@24 -c 'npm run db:migrate'
npx --yes --package=node@24 -c 'npm run test:integration -- src/lib/db/schema/visual-search.integration.test.ts src/test/database.test.ts'
```

Expected: migration succeeds; all focused tests PASS.

- [ ] **Step 6: Commit the schema slice**

```bash
git add compose.yaml drizzle src/lib/db/schema/assets.ts src/lib/db/schema/index.ts src/lib/db/schema/visual-search.ts src/lib/db/schema/visual-search.integration.test.ts src/test/database.ts
git commit -m "feat: add visual search index schema"
```

### Task 2: Scaffold and lock the private Python service

**Files:**
- Create: `services/visual-search/pyproject.toml`
- Create: `services/visual-search/uv.lock`
- Create: `services/visual-search/model-source.json`
- Create: `services/visual-search/model-lock.json`
- Create: `services/visual-search/src/melon_visual_search/__init__.py`
- Create: `services/visual-search/src/melon_visual_search/settings.py`
- Create: `services/visual-search/src/melon_visual_search/auth.py`
- Create: `services/visual-search/src/melon_visual_search/app.py`
- Create: `services/visual-search/tests/test_app.py`
- Create: `services/visual-search/tools/export_model.py`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing settings and internal-auth tests**

```py
def test_rejects_missing_internal_token(client):
    response = client.get("/internal/health")
    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "INTERNAL_AUTH_REQUIRED"}}

def test_health_reports_version(client, auth_headers):
    response = client.get("/internal/health", headers=auth_headers)
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "indexVersion": "visual-search-v1",
        "modelLoaded": False,
    }

def test_production_requires_loopback_service_host(monkeypatch):
    monkeypatch.setenv("VISUAL_SEARCH_ENV", "production")
    monkeypatch.setenv("VISUAL_SEARCH_HOST", "0.0.0.0")
    with pytest.raises(ValidationError):
        Settings()
```

- [ ] **Step 2: Run pytest and verify it fails**

Bootstrap `uv` in a project-local virtual environment, then run:

```bash
python3 -m venv .venv-visual-search
.venv-visual-search/bin/pip install uv
.venv-visual-search/bin/uv sync --project services/visual-search
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_app.py -q
```

Expected: FAIL because the package and app do not exist.

- [ ] **Step 3: Add the locked dependency groups**

Define `pyproject.toml` with Python `>=3.10,<3.13` and these runtime dependencies: `fastapi`, `uvicorn`, `pydantic-settings`, `python-multipart`, `numpy`, `onnxruntime`, `opencv-contrib-python-headless`, `Pillow`, `pillow-heif`, `psycopg[binary,pool]`, `pgvector`, `alibabacloud-oss-v2`, and `alibabacloud-credentials`. Add a `dev` group with `pytest`, `pytest-asyncio`, `httpx`, `ruff`, and `mypy`; add a `model` group with `torch`, `transformers`, `optimum-onnx`, and `onnx`.

Generate and commit the exact lock:

```bash
.venv-visual-search/bin/uv lock --project services/visual-search
.venv-visual-search/bin/uv sync --project services/visual-search --group dev
```

- [ ] **Step 4: Implement strict settings and constant-time internal auth**

The settings contract must include `database_url`, OSS region/bucket/endpoint, `internal_token`, `active_version`, `model_path`, `model_sha256`, `temp_dir`, `max_concurrency`, `host`, and `port`. Use a dependency so tests can override it:

```py
async def require_internal_token(
    authorization: Annotated[str | None, Header()] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    expected = f"Bearer {settings.internal_token}"
    if authorization is None or not secrets.compare_digest(authorization, expected):
        raise HTTPException(401, detail={"code": "INTERNAL_AUTH_REQUIRED"})
```

Create `/internal/health` behind this dependency and ensure production accepts only `127.0.0.1` or `::1` as the bind host.

- [ ] **Step 5: Pin the source model and create a reproducible export tool**

Commit this source identity, but do not commit the 88+ MB weights or ONNX output:

```json
{
  "repoId": "facebook/dinov2-small",
  "revision": "ed25f3a31f01632728cabb09d1542f84ab7b0056",
  "license": "Apache-2.0",
  "task": "feature-extraction",
  "inputSize": 224,
  "dimensions": 384
}
```

`export_model.py` must download only that revision, export an FP32 model with dynamic batch axis, compare a fixed image batch between Transformers and ONNX Runtime within `1e-4`, calculate SHA-256, and atomically write `services/visual-search/model-lock.json`. The lock records source revision, exporter versions, opset, input contract, output name, dimensions, and artifact checksum; the checksum, rather than an assumption of byte-identical exports across platforms, defines the deployed artifact. Add `/services/visual-search/models/` and `.venv-visual-search/` to `.gitignore`.

Run the export once during implementation:

```bash
.venv-visual-search/bin/uv sync --project services/visual-search --group model
.venv-visual-search/bin/uv run --project services/visual-search python services/visual-search/tools/export_model.py --output services/visual-search/models/dinov2-small.onnx --lock services/visual-search/model-lock.json
```

Expected: the tool prints the artifact SHA-256, writes a lock file, and the parity check passes. Commit `model-lock.json`; keep `dinov2-small.onnx` ignored.

- [ ] **Step 6: Run Python quality checks and commit**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_app.py -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src
git add .gitignore services/visual-search
git commit -m "feat: scaffold visual search service"
```

Expected: all checks PASS; the commit contains no ONNX or model-weight binary.

### Task 3: Build deterministic image features and ranking rules

**Files:**
- Create: `services/visual-search/src/melon_visual_search/image_io.py`
- Create: `services/visual-search/src/melon_visual_search/embedding.py`
- Create: `services/visual-search/src/melon_visual_search/local_features.py`
- Create: `services/visual-search/src/melon_visual_search/scoring.py`
- Create: `services/visual-search/config/scoring-v1.json`
- Create: `services/visual-search/tests/fixtures/checker.png`
- Create: `services/visual-search/tests/fixtures/checker-crop.jpg`
- Create: `services/visual-search/tests/test_image_io.py`
- Create: `services/visual-search/tests/test_embedding.py`
- Create: `services/visual-search/tests/test_local_features.py`
- Create: `services/visual-search/tests/test_scoring.py`

- [ ] **Step 1: Write failing bounded-decode and tiling tests**

```py
def test_decode_rejects_too_many_pixels():
    with pytest.raises(ImageSearchError, match="IMAGE_SEARCH_IMAGE_TOO_LARGE"):
        decode_image(encoded_png(width=9000, height=5000), max_pixels=40_000_000)

def test_regions_are_global_plus_nine_overlapping_tiles(checker_image):
    regions = make_regions(checker_image)
    assert [region.index for region in regions] == list(range(10))
    assert regions[0].kind == "global"
    assert all(region.kind == "tile" for region in regions[1:])
    assert regions[1].bounds == pytest.approx((0.0, 0.0, 0.4, 0.4), abs=0.02)
```

Also test EXIF orientation, RGBA normalization on deterministic light/dark backgrounds, HEIC registration, shortest edge 96 px, a 20 MB encoded-byte cap, and a single-frame limit.

- [ ] **Step 2: Write failing embedding, pHash, SIFT, and classifier tests**

```py
def test_embeddings_are_batched_and_l2_normalized(runtime, checker_image):
    vectors = runtime.embed(make_regions(checker_image))
    assert vectors.shape == (10, 384)
    np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), np.ones(10), atol=1e-5)

def test_crop_passes_geometric_verification(checker_image, checker_crop):
    reference = extract_local_features(checker_image, max_keypoints=256)
    query = extract_local_features(checker_crop, max_keypoints=256)
    evidence = geometric_evidence(query, reference)
    assert evidence.inliers >= 10
    assert evidence.inlier_ratio >= 0.25

def test_embedding_alone_never_claims_source():
    result = classify(MatchEvidence(best_visual=0.99, global_visual=0.98))
    assert result.kind == "visually_similar"
```

- [ ] **Step 3: Run focused tests and verify failure**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_image_io.py services/visual-search/tests/test_embedding.py services/visual-search/tests/test_local_features.py services/visual-search/tests/test_scoring.py -q
```

Expected: FAIL because feature modules are absent.

- [ ] **Step 4: Implement the feature pipeline**

Implement these stable public types:

```py
@dataclass(frozen=True)
class Region:
    index: int
    kind: Literal["global", "tile"]
    bounds: tuple[float, float, float, float]
    image: np.ndarray

@dataclass(frozen=True)
class LocalFeatures:
    phash: str
    keypoints: np.ndarray
    descriptors: np.ndarray

@dataclass(frozen=True)
class MatchEvidence:
    best_visual: float
    global_visual: float = 0.0
    phash_distance: int | None = None
    inliers: int = 0
    inlier_ratio: float = 0.0
    coverage: float = 0.0
```

Derive resize, interpolation, RGB conversion, mean, and standard-deviation values from the pinned DINOv2 preprocessor config and record them in `model-lock.json`; the ONNX parity test must exercise the same preprocessing code used at runtime. Batch the ten 224x224 regions through one ONNX call, take the CLS token, and L2-normalize. Use 64-bit pHash, SIFT capped at 256 strongest keypoints, Lowe ratio filtering, and RANSAC homography. Serialize numeric arrays with `numpy.savez_compressed`; load with `numpy.load(..., allow_pickle=False)` and reject archives with unexpected names, dtypes, dimensions, or counts.

`scoring-v1.json` must contain explicit thresholds and weights. `classify()` may return `probable_source` only when pHash or verified geometry passes; it returns no result below `minimumVisualSimilarity`.

- [ ] **Step 5: Run the real model smoke test**

```bash
RUN_VISUAL_MODEL_TESTS=1 VISUAL_SEARCH_MODEL_PATH="$PWD/services/visual-search/models/dinov2-small.onnx" .venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_embedding.py -q
```

Expected: a ten-region batch returns finite `(10, 384)` normalized vectors and the model SHA matches the lock.

- [ ] **Step 6: Run Python checks and commit**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src
git add services/visual-search
git commit -m "feat: extract visual search features"
```

## Phase 2: Index Lifecycle and Search Core

### Task 4: Connect preview lifecycle events to idempotent jobs

**Files:**
- Create: `src/features/image-search/index-repository.ts`
- Create: `src/features/image-search/index-service.ts`
- Create: `src/features/image-search/index-service.integration.test.ts`
- Modify: `src/features/uploads/upload-service.ts`
- Modify: `src/features/uploads/upload-service.integration.test.ts`
- Modify: `src/features/preview/manual-preview-service.ts`
- Modify: `src/features/preview/manual-preview-service.integration.test.ts`
- Modify: `src/features/trash/trash-purge-repository.ts`
- Modify: `src/features/trash/trash-purge-service.integration.test.ts`
- Create: `scripts/backfill-image-search.ts`
- Create: `scripts/backfill-image-search.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing enqueue, replacement, replay, and purge tests**

Cover these exact cases:

```ts
it("enqueues one job when upload completion publishes a preview", async () => {
  await service.complete(sourceAndPreviewCompletion(initialized));
  await service.complete(sourceAndPreviewCompletion(initialized));
  expect(await jobsFor(initialized.pattern.id)).toHaveLength(1);
});

it("removes the old preview index before enqueuing a manual replacement", async () => {
  await seedReadyDocument(oldPreviewId);
  await completeManualPreview(newPreview);
  expect(await documentStatus(oldPreviewId)).toBeUndefined();
  expect(await pendingJob(newPreview.assetId)).toMatchObject({
    indexVersion: "visual-search-v1",
    status: "pending",
  });
});

it("removes search rows during permanent purge but not ordinary trash", async () => {
  await trashPattern(patternId);
  expect(await readyDocuments(patternId)).toHaveLength(1);
  await purgePattern(patternId);
  expect(await readyDocuments(patternId)).toHaveLength(0);
});
```

- [ ] **Step 2: Run the focused integration tests and verify failure**

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/image-search/index-service.integration.test.ts src/features/uploads/upload-service.integration.test.ts src/features/preview/manual-preview-service.integration.test.ts src/features/trash/trash-purge-service.integration.test.ts'
```

Expected: FAIL because lifecycle hooks and the job repository do not exist.

- [ ] **Step 3: Implement transaction-scoped enqueue helpers**

Expose functions that require the caller's existing transaction:

```ts
export async function enqueueVisualSearchIndex(
  tx: DbTransaction,
  input: {
    ownerId: string;
    patternId: string;
    previewAssetId: string;
    indexVersion: string;
    now: Date;
  },
) {
  return tx.insert(visualSearchJobs).values({
    id: randomUUID(),
    ...input,
    status: "pending",
    attemptCount: 0,
    availableAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflictDoNothing({
    target: [
      visualSearchJobs.ownerId,
      visualSearchJobs.patternId,
      visualSearchJobs.previewAssetId,
      visualSearchJobs.indexVersion,
    ],
  });
}
```

Upload completion calls it only when the committed assets include role `preview`. Manual replacement relies on the preview-asset cascade to remove stale documents/jobs, then enqueues the new preview in the same transaction. Permanent purge explicitly deletes search rows before assets so tests can assert deterministic cleanup; ordinary trash does nothing.

- [ ] **Step 4: Add safe idempotent backfill**

`scripts/backfill-image-search.ts` must require `--version`, select owned preview assets only for `preview_status IN ('ready','manual')` and non-deleted patterns, process pages of 500, use `onConflictDoNothing`, and print JSON counts. It must never delete or supersede a ready document.

Add:

```json
"image-search:backfill": "node --conditions=react-server --import tsx scripts/backfill-image-search.ts"
```

Test that two runs enqueue the same number of unique jobs and that `--version visual-search-v1` cannot affect another version.

- [ ] **Step 5: Run lifecycle tests and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- scripts/backfill-image-search.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/image-search/index-service.integration.test.ts src/features/uploads/upload-service.integration.test.ts src/features/preview/manual-preview-service.integration.test.ts src/features/trash/trash-purge-service.integration.test.ts'
git add package.json scripts/backfill-image-search.ts scripts/backfill-image-search.test.ts src/features/image-search src/features/uploads/upload-service.ts src/features/uploads/upload-service.integration.test.ts src/features/preview/manual-preview-service.ts src/features/preview/manual-preview-service.integration.test.ts src/features/trash/trash-purge-repository.ts src/features/trash/trash-purge-service.integration.test.ts
git commit -m "feat: enqueue visual search indexing"
```

### Task 5: Implement the crash-safe indexing worker and OSS artifacts

**Files:**
- Create: `services/visual-search/src/melon_visual_search/repository.py`
- Create: `services/visual-search/src/melon_visual_search/storage.py`
- Create: `services/visual-search/src/melon_visual_search/worker.py`
- Create: `services/visual-search/src/melon_visual_search/cli.py`
- Create: `services/visual-search/tests/conftest.py`
- Create: `services/visual-search/tests/test_repository.py`
- Create: `services/visual-search/tests/test_storage.py`
- Create: `services/visual-search/tests/test_worker.py`

- [ ] **Step 1: Write failing job lease and recovery tests**

```py
def test_workers_cannot_claim_the_same_job(repository, seeded_job):
    first = repository.claim_next("worker-a", now=NOW)
    second = repository.claim_next("worker-b", now=NOW)
    assert first.id == seeded_job.id
    assert second is None

def test_expired_lease_is_reclaimed(repository, seeded_job):
    repository.claim_next("worker-a", now=NOW)
    reclaimed = repository.claim_next("worker-b", now=NOW + timedelta(minutes=6))
    assert reclaimed.id == seeded_job.id

def test_fifth_failure_is_terminal(repository, seeded_job):
    for attempt in range(5):
        job = repository.claim_next("worker-a", now=NOW + timedelta(hours=attempt))
        repository.fail(job, "INDEX_IMAGE_DECODE_FAILED", retryable=True)
    assert repository.get_job(seeded_job.id).status == "failed"
```

- [ ] **Step 2: Write the failing worker publication test**

Use an in-memory storage adapter and deterministic fake embedder. Assert the worker downloads the current preview, computes SHA-256, writes one `.npz`, inserts exactly ten vectors, then atomically marks the document ready. Simulate a transaction failure and assert the newly uploaded `.npz` is deleted and no ready document exists.

- [ ] **Step 3: Run focused pytest and verify failure**

```bash
VISUAL_SEARCH_DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_test .venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_repository.py services/visual-search/tests/test_storage.py services/visual-search/tests/test_worker.py -q
```

Expected: FAIL because worker modules do not exist.

- [ ] **Step 4: Implement leasing and atomic publication**

The claim query must use one transaction and this locking shape:

```sql
SELECT *
FROM visual_search_jobs
WHERE (
  status = 'pending' AND available_at <= %(now)s
) OR (
  status = 'leased' AND lease_until < %(now)s
)
ORDER BY available_at, created_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

Set a five-minute lease, heartbeat the worker every 15 seconds, and extend the active lease during slow inference. Retry delays are `min(3600, 30 * 2 ** (attempt_count - 1))` seconds. Treat network/OSS/temporary database errors as retryable; invalid image bytes, dimension violations, wrong preview ownership, and model checksum mismatch are terminal.

Publication order is: download and hash the preview; extract features; upload the versioned `.npz`; then open one database transaction that locks and revalidates the current preview asset, upserts the non-ready document for that fingerprint, replaces its ten vectors, supersedes any different ready document for the same active version, marks the new document ready, and completes the job. A replay that finds the same fingerprint already ready completes the job without rewriting vectors. On transaction failure, roll back and best-effort delete the newly uploaded object; a crash between upload and commit leaves only an unreferenced object for the orphan cleaner. Search queries join only `status='ready'`.

- [ ] **Step 5: Implement production OSS V2 credentials**

`AlibabaOssStorage` uses `alibabacloud_credentials` with `type='ecs_ram_role'` in production and the existing environment/default provider chain locally. It may read the canonical preview key and read/write/delete only:

```text
users/{ownerId}/patterns/{patternId}/derived/search/{indexVersion}/{previewHash}.npz
```

Validate every segment and reject traversal, foreign owner/pattern IDs, non-hex hashes, and versions outside `[a-z0-9-]{1,64}`. Never accept an arbitrary object key from an HTTP caller.

- [ ] **Step 6: Add worker and orphan-cleanup commands**

Expose:

```bash
uv run --project services/visual-search melon-visual-search worker
uv run --project services/visual-search melon-visual-search cleanup-orphans --older-than-hours 24
```

The cleanup command builds its keep-set from documents and live jobs, scans only canonical `derived/search/` prefixes, and refuses to run when the database name ends in neither `_test` nor the explicitly configured production database.

- [ ] **Step 7: Run checks and commit**

```bash
VISUAL_SEARCH_DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_test .venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src
git add services/visual-search
git commit -m "feat: index previews for visual search"
```

### Task 6: Implement candidate recall, geometric reranking, and internal search

**Files:**
- Create: `services/visual-search/src/melon_visual_search/search.py`
- Modify: `services/visual-search/src/melon_visual_search/repository.py`
- Modify: `services/visual-search/src/melon_visual_search/app.py`
- Create: `services/visual-search/tests/test_recall.py`
- Create: `services/visual-search/tests/test_search.py`
- Modify: `services/visual-search/tests/test_app.py`

- [ ] **Step 1: Write failing owner/filter isolation and ranking tests**

```py
def test_search_never_returns_a_disallowed_pattern(search_service, indexed_patterns):
    result = search_service.search(
        owner_id=OWNER_A,
        allowed_pattern_ids=[PATTERN_A],
        image=partial_query,
    )
    assert [item.pattern_id for item in result.items] == [PATTERN_A]
    assert PATTERN_B not in {item.pattern_id for item in result.items}

def test_verified_crop_ranks_before_visual_neighbor(search_service):
    result = search_service.search(OWNER_A, [SOURCE, NEIGHBOR], partial_query)
    assert result.items[0].pattern_id == SOURCE
    assert result.items[0].kind in {"probable_source", "possible_source"}
    assert result.items[1].kind == "visually_similar"
```

Also test zero allowed IDs, no ready indexes, no candidate above minimum similarity, 10,001 allowed IDs, corrupt `.npz`, service concurrency exhaustion, and temporary-file deletion after success, decode failure, cancellation, and timeout.

- [ ] **Step 2: Run focused pytest and verify failure**

```bash
VISUAL_SEARCH_DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_test .venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_recall.py services/visual-search/tests/test_search.py services/visual-search/tests/test_app.py -q
```

Expected: FAIL because online search is absent.

- [ ] **Step 3: Implement bounded vector recall**

For each of the ten query vectors, retrieve at most 100 rows under `owner_id`, `index_version`, ready-document, and `pattern_id = ANY(%s::uuid[])`. Merge by Pattern ID using the best region similarity and retain at most 50 candidates. Use `<=>` cosine distance and set transaction-local `hnsw.ef_search = 100` plus `hnsw.iterative_scan = 'relaxed_order'` for broad sets; require pgvector 0.8.0 or newer in deployment checks. For 500 or fewer allowed IDs, materialize the filtered rows before ordering so PostgreSQL performs exact cosine ranking.

Register pgvector with every Psycopg pool connection:

```py
def configure_connection(connection: psycopg.Connection) -> None:
    register_vector(connection)
    connection.execute("SET statement_timeout = '10s'")
```

- [ ] **Step 4: Implement reranking and result limits**

Load local features only for the 50 candidates, use a bounded LRU cache keyed by `(document_id, preview_hash, index_version)`, classify with `scoring-v1.json`, order categories `probable_source`, `possible_source`, `visually_similar`, then score descending and Pattern ID ascending for stability. Return at most 30 results and never fill below the minimum similarity threshold.

- [ ] **Step 5: Add the authenticated internal endpoint**

Define a multipart `/internal/search` endpoint accepting one image, canonical owner UUID, JSON array of at most 10,000 canonical Pattern UUIDs, and request ID. Enforce 20 MiB encoded bytes, 40 MP, shortest edge 96 px, one frame, and the service semaphore. Map failures to these internal codes: `INVALID_FILE`, `IMAGE_TOO_LARGE`, `NO_INDEX`, `BUSY`, `TIMEOUT`, `UNAVAILABLE`.

Use `asyncio.timeout(11)` inside the service; always close the upload and remove the random `0600` temporary file in `finally`.

- [ ] **Step 6: Run the service suite and commit**

```bash
VISUAL_SEARCH_DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_test .venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src
git add services/visual-search
git commit -m "feat: search indexed pattern images"
```

## Phase 3: Next.js Boundary and Library Experience

### Task 7: Add the authenticated Next.js image-search API

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/features/image-search/contracts.ts`
- Create: `src/features/image-search/contracts.test.ts`
- Create: `src/features/image-search/bounded-multipart.ts`
- Create: `src/features/image-search/bounded-multipart.test.ts`
- Create: `src/features/image-search/pattern-scope.ts`
- Create: `src/features/image-search/pattern-scope.integration.test.ts`
- Create: `src/features/image-search/internal-client.ts`
- Create: `src/features/image-search/internal-client.test.ts`
- Create: `src/features/image-search/search-service.ts`
- Create: `src/features/image-search/search-service.integration.test.ts`
- Create: `src/app/api/image-search/route.ts`
- Create: `src/app/api/image-search/route.test.ts`
- Modify: `src/features/patterns/pattern-repository.ts`
- Modify: `src/features/patterns/pattern-service.ts`
- Modify: `src/lib/env/server.ts`
- Modify: `src/lib/env/server.test.ts`
- Modify: `src/lib/http/app-error.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install a structured multipart parser and write failing boundary tests**

```bash
npx --yes --package=node@24 -c 'npm install busboy'
npx --yes --package=node@24 -c 'npm install --save-dev @types/busboy'
```

The public schema must reject cursor/scope-trash, more than 20 tags, malformed request IDs, unknown result categories, duplicate Pattern IDs, and more than 30 results. Test `bounded-multipart.ts` with chunked bodies, a forged small `Content-Length`, a second file, an oversized image, oversized text fields, malformed boundaries, and client cancellation; it must stop reading and release listeners on every error. Add conditional environment assertions:

```ts
expect(() => parseServerEnv({ ...base, IMAGE_SEARCH_ENABLED: "true" })).toThrow();
expect(parseServerEnv({
  ...base,
  IMAGE_SEARCH_ENABLED: "true",
  IMAGE_SEARCH_SERVICE_URL: "http://127.0.0.1:8091",
  IMAGE_SEARCH_INTERNAL_TOKEN: "x".repeat(32),
  IMAGE_SEARCH_ACTIVE_VERSION: "visual-search-v1",
  IMAGE_SEARCH_MODEL_SHA256: "a".repeat(64),
}).IMAGE_SEARCH_ENABLED).toBe(true);
```

- [ ] **Step 2: Write failing scope and hydration integration tests**

Seed folders, tags, commercial states, two owners, trashed patterns, and 10,001 active patterns. Assert that `resolveImageSearchPatternIds()` exactly follows current folder descendants, tag mode, favorite, format, preview, text, authorization field, and commercial filters; excludes trash and deleted patterns; caps at 10,000; and never returns another owner. Assert `hydrateRankedPatterns()` preserves rank while returning the existing commercial summary and asset IDs.

- [ ] **Step 3: Run tests and verify failure**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/image-search/contracts.test.ts src/features/image-search/bounded-multipart.test.ts src/features/image-search/internal-client.test.ts src/app/api/image-search/route.test.ts src/lib/env/server.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/image-search/pattern-scope.integration.test.ts src/features/image-search/search-service.integration.test.ts'
```

Expected: FAIL because the feature boundary does not exist.

- [ ] **Step 4: Refactor the Pattern repository once, then reuse it**

Extract the existing library-filter predicate builder and commercial-summary subquery from `listPatternRows()`. Reuse them in:

```ts
export async function listImageSearchPatternIds(
  ownerId: string,
  query: PatternQuery,
): Promise<string[]>;

export async function listPatternRowsByIds(
  ownerId: string,
  ids: readonly string[],
): Promise<PatternRowWithAssetsAndCommercial[]>;
```

The ID query ignores `cursor`, `limit`, and sort, adds `scope='library'`, returns at most 10,001 rows, and throws `IMAGE_SEARCH_SCOPE_TOO_LARGE` rather than silently truncating. Hydration accepts at most 30 IDs and reorders in TypeScript from a rank map after the owner-scoped query.

- [ ] **Step 5: Implement the loopback client and service**

Use `AbortSignal.any([request.signal, AbortSignal.timeout(12_000)])`, internal bearer auth, multipart `File`, owner ID, JSON allowed IDs, active version, and request ID. Require an HTTP loopback URL in production. Map internal codes to public AppErrors:

```ts
const publicErrors = {
  INVALID_FILE: ["IMAGE_SEARCH_INVALID_FILE", 415],
  IMAGE_TOO_LARGE: ["IMAGE_SEARCH_IMAGE_TOO_LARGE", 413],
  NO_INDEX: ["IMAGE_SEARCH_NO_INDEX", 409],
  BUSY: ["IMAGE_SEARCH_BUSY", 429],
  TIMEOUT: ["IMAGE_SEARCH_TIMEOUT", 504],
  UNAVAILABLE: ["IMAGE_SEARCH_UNAVAILABLE", 503],
} as const;
```

Never log the multipart body, bearer token, internal scores, feature keys, or signed OSS locations.

- [ ] **Step 6: Implement the public route**

Call `requireApiUser()` and `assertSameOrigin()` before consuming the body. Quickly reject a declared `Content-Length` above 21 MiB, but do not trust or require that header. Feed the Web stream through a 21-MiB total-byte counter into `busboy`, with limits of one 20-MiB file, three bounded fields, and no unrecognized parts; construct the bounded in-memory `File` only after parsing succeeds. Then validate `image`, `filters`, and `requestId`, resolve allowed IDs, call the internal service, hydrate returned IDs, and return grouped Pattern DTOs. The route must check that every internal result belongs to the requested owner and allowed set.

- [ ] **Step 7: Run focused tests and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/image-search/contracts.test.ts src/features/image-search/bounded-multipart.test.ts src/features/image-search/internal-client.test.ts src/app/api/image-search/route.test.ts src/lib/env/server.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/image-search/pattern-scope.integration.test.ts src/features/image-search/search-service.integration.test.ts'
git add package.json package-lock.json .env.example src/app/api/image-search src/features/image-search src/features/patterns/pattern-repository.ts src/features/patterns/pattern-service.ts src/lib/env/server.ts src/lib/env/server.test.ts src/lib/http/app-error.ts
git commit -m "feat: expose authenticated image search"
```

### Task 8: Build the picker, paste/drop, and crop workflow

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/features/image-search/image-search-store.ts`
- Create: `src/features/image-search/image-search-store.test.ts`
- Create: `src/features/image-search/image-search-client.ts`
- Create: `src/features/image-search/image-search-client.test.ts`
- Create: `src/features/image-search/crop-image.ts`
- Create: `src/features/image-search/crop-image.test.ts`
- Create: `src/features/image-search/image-search-dialog.tsx`
- Create: `src/features/image-search/image-search-dialog.test.tsx`
- Modify: `src/features/library/topbar.tsx`
- Modify: `src/features/library/library-view.tsx`
- Modify: `src/features/library/library-view.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Install the crop control and write failing transient-store tests**

```bash
npx --yes --package=node@24 -c 'npm install react-image-crop'
```

Test that the store contains only `dialogOpen` and an incrementing open request, has no persistence middleware, and resets on owner change. It must not store the `File`, Blob URL, pixels, response, or result selection globally.

- [ ] **Step 2: Write failing dialog tests**

Cover click selection, drag/drop, clipboard paste, wrong type, >20 MiB, removal, object-URL revocation, optional crop, HEIC no-preview fallback, submit cancellation, Escape, and phase/status accessibility:

```tsx
await user.upload(screen.getByLabelText("选择搜索图片"), jpgFile);
expect(screen.getByRole("img", { name: "搜索图片预览" })).toBeVisible();
await user.click(screen.getByRole("button", { name: "开始搜索" }));
expect(screen.getByRole("status")).toHaveTextContent(/分析图片|查找候选|精确比对/);
expect(onSearch).toHaveBeenCalledWith(expect.objectContaining({ file: expect.any(File) }));
```

- [ ] **Step 3: Run focused tests and verify failure**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/image-search/image-search-store.test.ts src/features/image-search/image-search-client.test.ts src/features/image-search/crop-image.test.ts src/features/image-search/image-search-dialog.test.tsx'
```

Expected: FAIL because UI modules do not exist.

- [ ] **Step 4: Implement bounded client validation and crop export**

Accept `.jpg,.jpeg,.png,.webp,.heic,.heif` and validate both `File.type` and extension before sending; the server remains authoritative. `cropImage()` uses an offscreen canvas, applies natural/display scale, encodes WebP at 0.92 quality with a PNG fallback, rejects outputs above 20 MiB, and always revokes temporary URLs.

If `createImageBitmap()` and `<img>` both reject HEIC/HEIF, show the filename and “此浏览器无法裁剪 HEIC，将搜索整张图片”; allow submit of the original file.

- [ ] **Step 5: Implement the dialog and topbar trigger**

Use Radix Dialog, `react-image-crop`, and Lucide `ScanSearch`. Add the icon button inside `.global-search` only on `/library`; tooltip and accessible name are “以图搜图”. `LibraryView` mounts one portal-backed dialog and listens to the small Zustand open request emitted by `Topbar`. It owns the accepted query `Blob`, thumbnail URL, response, and abort controller in component memory; unmounting the library aborts the request and revokes the URL.

The actual phases are:

1. `分析图片`: active only while validating/decoding/cropping locally.
2. `查找候选` and `精确比对`: shown together as one active server-processing status after submission because the single HTTP response does not expose a trustworthy phase boundary.

All three labels remain visible, but the UI must not advance a timer-driven phase, percentage, or completion checkmark that the service did not report.

Cancel aborts fetch. Uploading a search image never invokes `useUploadManager`, never writes Dexie, and never opens the inspector.

- [ ] **Step 6: Run tests and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/image-search/image-search-store.test.ts src/features/image-search/image-search-client.test.ts src/features/image-search/crop-image.test.ts src/features/image-search/image-search-dialog.test.tsx src/features/library/library-view.test.tsx src/features/library/mobile-panels.test.tsx'
git add package.json package-lock.json src/features/image-search src/features/library/topbar.tsx src/features/library/library-view.tsx src/features/library/library-view.test.tsx src/app/globals.css
git commit -m "feat: add image search picker"
```

### Task 9: Add grouped image-search result mode without selection regressions

**Files:**
- Create: `src/features/image-search/image-search-results.tsx`
- Create: `src/features/image-search/image-search-results.test.tsx`
- Modify: `src/features/library/library-types.ts`
- Modify: `src/features/library/library-view.tsx`
- Modify: `src/features/library/library-view.test.tsx`
- Modify: `src/features/library/pattern-grid.tsx`
- Modify: `src/features/library/pattern-card.tsx`
- Modify: `src/features/library/pattern-card-assets.test.tsx`
- Modify: `src/features/library/library-toolbar.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing grouped-result and restoration tests**

Test three ordered groups, omitted empty groups, 30-result cap, “未找到可能的原图”, fixed match ordering, query thumbnail, filter-triggered rerun, mutation reconciliation, and exit restoration. Record the normal grid scroll offset, enter search, exit, and assert the same URL query, inspector state, normal-grid selection, view mode, and scroll offset return. Search-result checkbox selection is separate and is discarded on exit; a saved normal selection is restored only for Pattern IDs that still exist after mutations/refetch.

Add explicit event regressions:

```tsx
await user.click(within(resultCard).getByRole("checkbox"));
expect(openInspector).not.toHaveBeenCalled();
await user.click(within(resultCard).getByRole("button", { name: /打开.*检查器/ }));
expect(onSelect).not.toHaveBeenCalled();
expect(openInspector).toHaveBeenCalledWith(result.id);
```

Search completion itself must leave the saved normal-grid selection and inspector ID unchanged. Opening a result card may change the active inspector during result mode, but exiting restores the saved inspector if its Pattern still exists.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/image-search/image-search-results.test.tsx src/features/library/library-view.test.tsx src/features/library/pattern-card-assets.test.tsx'
```

Expected: FAIL because result mode is not wired.

- [ ] **Step 3: Implement a 30-item non-virtual grouped grid**

Do not force headings into the existing virtual row model. `ImageSearchResults` renders up to three unframed sections using the same `PatternCard`, responsive grid sizing, and handlers. Flatten group IDs once for Shift/multi-select ordering. Add `matchKind` as an optional display-only field on `PatternItem`; render a restrained label on result cards only.

- [ ] **Step 4: Make the normal grid scroll position controllable**

Expose a focused ref instead of leaking the DOM node:

```ts
export type PatternGridHandle = {
  getScrollOffset(): number;
  restoreScrollOffset(offset: number): void;
};
```

Capture it before entering result mode and restore in `requestAnimationFrame()` after the normal grid remounts. Keep the ordinary TanStack infinite query active so its data cache stays warm, but unmount its virtualized grid while results are shown. Do not encode the query image or search state into the URL.

- [ ] **Step 5: Integrate active results into LibraryView**

`LibraryView` owns an `ImageSearchSession` containing the in-memory query `Blob`, thumbnail URL, grouped response, result-only selected IDs, abort controller, and the pre-search workspace snapshot. While results are active, use their flattened items for `orderedIds`, `patternsById`, result selection, preview, inspector, favorite, and download. Filter changes abort the old request and rerun search with the in-memory Blob; sort controls are disabled with label “以图搜图按匹配度排序”. Successful mutations patch the returned Pattern DTO into the session; mutations that can change active-filter membership rerun search, and deletion immediately removes the Pattern and result selection.

Exiting aborts in-flight search, revokes the thumbnail URL, discards result-only selection, restores the saved URL/view/inspector/normal selection, and restores scroll after the normal grid remounts. Owner change, sign-out, and library unmount perform the same resource cleanup without trying to restore stale UI state.

- [ ] **Step 6: Run focused and broad UI tests, then commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/image-search src/features/library'
git add src/features/image-search/image-search-results.tsx src/features/image-search/image-search-results.test.tsx src/features/library/library-types.ts src/features/library/library-view.tsx src/features/library/library-view.test.tsx src/features/library/pattern-grid.tsx src/features/library/pattern-card.tsx src/features/library/pattern-card-assets.test.tsx src/features/library/library-toolbar.tsx src/app/globals.css
git commit -m "feat: show ranked image search results"
```

## Phase 4: Operations, Quality, and Release

### Task 10: Add index status, retry, and rebuild controls

**Files:**
- Create: `src/features/image-search/index-settings.tsx`
- Create: `src/features/image-search/index-settings.test.tsx`
- Create: `src/features/image-search/index-admin-service.ts`
- Create: `src/features/image-search/index-admin-service.integration.test.ts`
- Create: `src/app/api/settings/image-search/route.ts`
- Create: `src/app/api/settings/image-search/route.test.ts`
- Create: `src/app/api/settings/image-search/retry/route.ts`
- Create: `src/app/api/settings/image-search/rebuild/route.ts`
- Modify: `src/app/(workspace)/settings/page.tsx`
- Modify: `src/app/(workspace)/settings/page.test.tsx`
- Modify: `src/lib/query/keys.ts`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing status and mutation tests**

Assert counts for eligible, ready, pending, leased, failed, and stale current-version documents; heartbeat freshness; owner isolation; retry only failed current-preview jobs; rebuild idempotency; same-origin protection; and no raw model/OSS data in responses.

```ts
expect(await getImageSearchIndexStatus(ownerA)).toEqual({
  indexVersion: "visual-search-v1",
  eligible: 4,
  ready: 2,
  pending: 1,
  indexing: 0,
  failed: 1,
  worker: "online",
});
```

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/image-search/index-settings.test.tsx src/app/api/settings/image-search/route.test.ts "src/app/(workspace)/settings/page.test.tsx"'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/image-search/index-admin-service.integration.test.ts'
```

Expected: FAIL because admin services and UI do not exist. Quote parenthesized paths if the shell expands them.

- [ ] **Step 3: Implement owner-scoped admin operations**

`retryFailedImageSearchJobs(ownerId)` creates new pending jobs for the current preview/version after validating that the asset still exists; it never resets completed history in place. `rebuildImageSearchIndex(ownerId)` calls the same paged enqueue primitive as the CLI and leaves ready documents serving until replacements publish. Both use current active version from server configuration.

Worker state is `online` when any heartbeat for the active version is at most 45 seconds old, `stale` when a heartbeat exists but is older, and `offline` when none exists.

- [ ] **Step 4: Implement quiet settings UI**

Add an unframed “图像搜索索引” section showing version and counts. Use icon+text buttons `RotateCcw 重试失败项` and `RefreshCw 重建索引`; rebuilding requires a Radix confirmation dialog that states it runs in the background and does not delete current results. Poll status every 15 seconds only while pending/indexing counts are non-zero and never in a hidden tab.

- [ ] **Step 5: Run tests and commit**

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/image-search/index-settings.test.tsx src/app/api/settings/image-search/route.test.ts "src/app/(workspace)/settings/page.test.tsx"'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/image-search/index-admin-service.integration.test.ts'
git add src/features/image-search src/app/api/settings/image-search 'src/app/(workspace)/settings/page.tsx' 'src/app/(workspace)/settings/page.test.tsx' src/lib/query/keys.ts src/app/globals.css
git commit -m "feat: manage image search indexes"
```

### Task 11: Build the real-library benchmark and lock quality thresholds

**Files:**
- Modify: `services/visual-search/src/melon_visual_search/benchmark.py`
- Create: `services/visual-search/src/melon_visual_search/calibration.py`
- Create: `services/visual-search/tests/test_benchmark.py`
- Create: `services/visual-search/tests/test_calibration.py`
- Modify: `services/visual-search/config/scoring-v1.json`
- Create: `docs/verification/2026-10-20-visual-search.md`

- [ ] **Step 1: Write failing deterministic transform and metric tests**

For a fixed seed, assert exact counts and labels for resize, JPEG compression, Gaussian blur, 5-degree rotation, and at least three crops retaining 25% or more of source area. Assert Top 1, Top 5, false-probable-source rate, and latency percentiles from known ranked fixtures.

- [ ] **Step 2: Run focused pytest and verify failure**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_benchmark.py services/visual-search/tests/test_calibration.py -q
```

Expected: FAIL because benchmark/calibration code is absent.

- [ ] **Step 3: Implement benchmark sampling without persisting private queries**

The command selects 100 ready indexed previews for one owner using a fixed seed, streams them from OSS, generates variants in the temp directory, searches with the source Pattern ID included for positive metrics and excluded for negative metrics, aggregates JSON metrics, and deletes every image in `finally`. It writes only IDs, transform names, ranks, categories, scores, timings, model SHA, index version, and aggregate metrics.

Expose:

```bash
uv run --project services/visual-search melon-visual-search benchmark --owner-id "$OWNER_ID" --count 100 --seed 20261020 --output /tmp/melon-visual-search-report.json
```

- [ ] **Step 4: Calibrate on a train split and evaluate a locked validation split**

Use 70 deterministic patterns for threshold selection and 30 untouched patterns for validation. Search a bounded grid of visual, pHash, inlier, ratio, and coverage thresholds; choose the configuration with highest partial-crop Top 5 subject to false probable-source rate below 5%. Write the winning numeric configuration atomically to `scoring-v1.json`, then rerun validation without further changes.

Do not continue when any approved gate fails:

- Exact/resize/compression Top 1 >= 98%.
- 25%-content crop Top 5 >= 90%.
- Medium blur Top 5 >= 85%.
- Negative false `probable_source` < 5%.
- Same-input classification is reproducible.

- [ ] **Step 5: Record evidence and commit**

`docs/verification/2026-10-20-visual-search.md` records model SHA, index version, corpus size (not image contents), transform counts, metrics, ECS/local hardware distinction, command lines, exit codes, and any test explicitly not run. Do not claim the production P95 gate from a development Mac.

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests -q
git add services/visual-search/config/scoring-v1.json services/visual-search/src/melon_visual_search/benchmark.py services/visual-search/src/melon_visual_search/calibration.py services/visual-search/tests/test_benchmark.py services/visual-search/tests/test_calibration.py docs/verification/2026-10-20-visual-search.md
git commit -m "test: calibrate visual search quality"
```

### Task 12: Package, deploy, backfill, and verify the complete feature

**Files:**
- Create: `services/visual-search/Dockerfile`
- Create: `deploy/compose.visual-search.yaml`
- Create: `deploy/systemd/melon-visual-search.service`
- Create: `deploy/systemd/melon-visual-search-worker.service`
- Create: `deploy/systemd/melon-visual-search-cleanup.service`
- Create: `deploy/systemd/melon-visual-search-cleanup.timer`
- Create: `docs/operations/visual-search.md`
- Modify: `docs/operations/aliyun-oss.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/verification/2026-10-20-visual-search.md`
- Modify: `src/features/storage/operations-doc.test.ts`
- Create: `tests/e2e/image-search.spec.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Add deployment and secret-safety tests before packaging**

Extend documentation/operation tests to assert that production examples use an ECS instance RAM role, bind the Python API to loopback, disable IMDSv1, never contain AccessKey-shaped literals, keep the browser STS policy unchanged, and grant the ECS role server-side access only under the existing `users/*/patterns/*` tree.

```bash
npx --yes --package=node@24 -c 'npm test -- src/features/storage/operations-doc.test.ts'
```

Expected: FAIL because the visual-search operations guide, container definition, and service units do not exist.

- [ ] **Step 2: Build a non-root service image**

Use Python 3.12 slim, `uv sync --frozen --no-dev`, OpenCV runtime libraries, an unprivileged UID, a read-only model mount at `/models/dinov2-small.onnx`, and separate API/worker commands from one image. Do not download model weights during container startup. Add an entrypoint preflight that verifies the mounted file against both committed `model-lock.json` and `IMAGE_SEARCH_MODEL_SHA256` before serving.

- [ ] **Step 3: Add systemd units and cleanup timer**

`deploy/compose.visual-search.yaml` defines API, single-concurrency worker, and one-shot CLI/cleanup services from the same pinned image, mounts the model and temp directories explicitly, and publishes only `127.0.0.1:8091`. The API systemd unit has `MemoryMax`, restart backoff, private temp space, and a readiness probe; the worker unit restarts on failure. The daily cleanup timer invokes the one-shot CLI service with `cleanup-orphans --older-than-hours 24`. Secrets come from a root-readable environment file outside Git.

- [ ] **Step 4: Document production sequence and RAM changes**

The operations guide must give this order:

1. Back up PostgreSQL, verify `CREATE EXTENSION vector` support, and require pgvector 0.8.0 or newer.
2. Deploy the migration while `IMAGE_SEARCH_ENABLED=false`.
3. Attach/verify the ECS instance role and IMDSv2; do not add search-object write permission to the browser STS role.
4. Install the checksum-verified ONNX artifact.
5. Start API and worker; verify loopback health.
6. Run `npm run image-search:backfill -- --version visual-search-v1`.
7. Watch ready/failed counts and run the 100-pattern benchmark.
8. Measure production ECS P95 and memory; require P95 <= 8 seconds without OOM.
9. Enable `IMAGE_SEARCH_ENABLED=true` and smoke test.

Rollback disables the flag and stops the two services; it does not drop tables or delete artifacts.

- [ ] **Step 5: Add end-to-end browser coverage**

Use deterministic seeded JPG fixtures and a stub internal search service for ordinary CI. Test picker, paste, crop, three result groups, no-source message, filter rerun, result inspection, checkbox isolation, download, exit restoration, narrow/mobile layout, and light/dark mode. Add one opt-in real-model E2E guarded by `RUN_REAL_VISUAL_SEARCH_TESTS=1`.

- [ ] **Step 6: Run the complete verification gate**

```bash
npx --yes --package=node@24 -c 'npm test'
npx --yes --package=node@24 -c 'npm run test:integration'
npx --yes --package=node@24 -c 'npm run typecheck'
npx --yes --package=node@24 -c 'npm run lint'
npx --yes --package=node@24 -c 'npm run build'
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src
docker build -f services/visual-search/Dockerfile -t melon-visual-search:test .
docker compose -f deploy/compose.visual-search.yaml config --quiet
npx --yes --package=node@24 -c 'npm run test:e2e -- tests/e2e/image-search.spec.ts'
```

Expected: all commands exit 0. Also inspect Playwright screenshots at desktop 1440x900, iPad 1024x1366, and phone 390x844 in light and dark themes; verify no overlap, clipped text, nested cards, or automatic inspector opening.

- [ ] **Step 7: Perform production-only gates before enabling**

On the target ECS, record:

```bash
curl -fsS -H "Authorization: Bearer $IMAGE_SEARCH_INTERNAL_TOKEN" http://127.0.0.1:8091/internal/health
npm run image-search:backfill -- --version visual-search-v1
docker compose -f deploy/compose.visual-search.yaml run --rm visual-search-cli benchmark --owner-id "$MELON_OWNER_ID" --count 100 --seed 20261020 --output /tmp/melon-visual-search-production.json
```

Confirm ready coverage, zero cross-owner results, P95 <= 8 seconds, no OOM/restarts, no query files older than the request timeout, and no secrets/images in logs. Only then set `IMAGE_SEARCH_ENABLED=true`.

- [ ] **Step 8: Commit deployment and verification artifacts**

```bash
git add services/visual-search/Dockerfile deploy/compose.visual-search.yaml deploy/systemd docs/operations/visual-search.md docs/operations/aliyun-oss.md README.md .env.example src/features/storage/operations-doc.test.ts tests/e2e/image-search.spec.ts playwright.config.ts docs/verification/2026-10-20-visual-search.md
git commit -m "chore: package visual search for production"
```

## References

- DINOv2 small model card and Apache-2.0 license: <https://huggingface.co/facebook/dinov2-small>
- Pinned DINOv2 model revision: <https://huggingface.co/facebook/dinov2-small/commit/ed25f3a31f01632728cabb09d1542f84ab7b0056>
- Hugging Face ONNX export guide: <https://huggingface.co/docs/optimum-onnx/onnx/usage_guides/export_a_model>
- pgvector PostgreSQL extension: <https://github.com/pgvector/pgvector>
- pgvector Psycopg integration: <https://github.com/pgvector/pgvector-python>
- Alibaba Cloud OSS Python SDK V2 credentials: <https://www.alibabacloud.com/help/en/oss/developer-reference/2-0-manual-preview-version/>
