# Melon Palette Extraction and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract and display 3-5 dominant colors for every indexed image, then let users select up to five swatches and search the current library scope by whole-palette similarity.

**Architecture:** Extend the existing versioned visual-search document so embeddings and palette colors publish atomically. Keep Next.js as the authenticated public boundary, let the Python service perform exact OKLab ranking over the server-resolved Pattern scope, enrich Pattern DTOs in batches, and isolate palette-search UI state in a dedicated debounced session hook.

**Tech Stack:** Next.js 16.4, React 19, TypeScript 6, PostgreSQL 17, Drizzle ORM, Zod, TanStack Query, Python 3.10+, FastAPI, Psycopg 3, NumPy, OpenCV, Pillow, Vitest, Testing Library, pytest, Playwright

---

## Execution Prerequisites

The approved design is in `docs/superpowers/specs/2026-10-22-melon-palette-search-design.md`, committed as `4e92de7`. Begin from a clean worktree and retain `IMAGE_SEARCH_ENABLED=false` in production until the version-2 backfill and gates in Task 11 pass.

Before editing application code, reread the installed Next.js 16 route-handler guide because this repository's `AGENTS.md` requires local framework documentation rather than remembered APIs:

```bash
sed -n '1,260p' node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
sed -n '1,260p' node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md
git status --short
git log -3 --oneline
```

Run Node commands with Node 24. Run Python commands through `.venv-visual-search/bin/uv run --project services/visual-search`. Do not add a second feature flag: palette display and search use the existing `IMAGE_SEARCH_ENABLED` boundary.

## File Map

### Database and Pattern DTOs

- `src/lib/db/schema/visual-search.ts`: add palette rows, range/format checks, composite ownership foreign key, and lookup index.
- `src/lib/db/schema/visual-search.integration.test.ts`: prove palette constraints, ownership, and cascading deletion.
- `src/test/database.ts`: truncate palette rows before visual-search documents.
- `drizzle/0006_melon_palette_search.sql`: add `visual_search_palette_colors`.
- `drizzle/meta/0006_snapshot.json` and `drizzle/meta/_journal.json`: generated Drizzle metadata.
- `src/features/patterns/pattern-palette-repository.ts`: batch-load palette state for the active visual index version.
- `src/features/patterns/pattern-service.ts`: enrich list/detail/mutation Pattern DTOs and validate replayed results.
- `src/features/patterns/pattern-batch-service.ts`: include the required empty palette state in mutation results.
- `src/features/uploads/upload-service.ts`: include the required pending palette state on newly uploaded patterns.
- `src/features/library/library-types.ts`: define `PatternPaletteColor`, `PatternPaletteStatus`, and required palette fields.
- `src/features/library/pattern-mutations.ts`: preserve an already-loaded palette during metadata-only optimistic updates.

### Python Indexing and Search

- `services/visual-search/src/melon_visual_search/image_io.py`: expose decoded sRGB pixels plus the original alpha plane without changing embedding input behavior.
- `services/visual-search/src/melon_visual_search/palette.py`: deterministic sampling, sRGB/OKLab conversion, clustering, merging, and 3-color fallback.
- `services/visual-search/src/melon_visual_search/palette_search.py`: versioned config parsing and bidirectional palette-distance ranking.
- `services/visual-search/config/palette-scoring-v1.json`: checked-in weights, maximum distance, and tie tolerance.
- `services/visual-search/src/melon_visual_search/repository.py`: publish palettes in the document transaction and read scoped candidates.
- `services/visual-search/src/melon_visual_search/worker.py`: extract the palette once per decoded preview and publish it with embeddings.
- `services/visual-search/src/melon_visual_search/search.py`: add `search_palette` to the existing search service and repository protocol.
- `services/visual-search/src/melon_visual_search/app.py`: add authenticated `POST /internal/palette-search` with the existing admission, timeout, and shutdown lifecycle.
- `services/visual-search/src/melon_visual_search/palette_benchmark.py`: repeatable 10,000-pattern latency benchmark.
- `services/visual-search/src/melon_visual_search/cli.py`: expose `palette-benchmark`.
- `services/visual-search/tests/test_image_io.py`: alpha-preserving decode coverage.
- `services/visual-search/tests/test_palette.py`: deterministic extraction and edge cases.
- `services/visual-search/tests/test_repository.py`: atomic publication and scoped palette reads.
- `services/visual-search/tests/test_worker.py`: worker extraction/publication behavior.
- `services/visual-search/tests/test_palette_search.py`: ranking semantics, threshold, and stable ordering.
- `services/visual-search/tests/test_search.py`: service-level no-index and scope behavior.
- `services/visual-search/tests/test_app.py`: internal endpoint contract, auth, validation, timeout, and shutdown.
- `services/visual-search/tests/test_palette_benchmark.py`: benchmark report validation.
- `services/visual-search/tests/conftest.py`: clean palette rows before document fixtures.

### Next.js Palette Search Boundary

- `src/features/palette-search/contracts.ts`: strict public and internal JSON contracts plus stable public error codes.
- `src/features/palette-search/contracts.test.ts`: reject noncanonical colors, duplicates, unknown fields, and oversized scopes.
- `src/features/palette-search/internal-client.ts`: authenticated bounded JSON call to the Python service.
- `src/features/palette-search/internal-client.test.ts`: URL, token, abort, response-size, and contract tests.
- `src/features/palette-search/palette-search-service.ts`: resolve allowed Pattern IDs, call Python, validate returned IDs, and hydrate DTOs in rank order.
- `src/features/palette-search/palette-search-service.integration.test.ts`: filter, tenant, ordering, and error mapping tests.
- `src/features/palette-search/palette-search-client.ts`: browser JSON client with AbortSignal support.
- `src/features/palette-search/palette-search-client.test.ts`: request and public-error parsing tests.
- `src/features/visual-search/internal-json.ts`: shared bounded, abort-aware parser for internal visual-search responses.
- `src/features/visual-search/internal-json.test.ts`: byte limit, malformed JSON, abort, and reader-cancellation tests.
- `src/features/image-search/internal-client.ts`: consume the shared bounded response parser without changing its public contract.
- `src/features/image-search/internal-client.test.ts`: retain image-client regression coverage after the extraction.
- `src/features/image-search/pattern-scope.ts`: expose shared ordered Pattern hydration without changing image-search semantics.
- `src/features/image-search/pattern-scope.integration.test.ts`: cover shared hydration ownership and order.
- `src/app/api/palette-search/route.ts`: same-origin authenticated public route.
- `src/app/api/palette-search/route.test.ts`: authentication, origin, content type, validation, and no-store tests.

### Library UI

- `src/features/palette-search/palette-swatches.tsx`: reusable card/inspector swatches with stable dimensions and accessible selected state.
- `src/features/palette-search/palette-swatches.test.tsx`: pending/failed/ready rendering and click isolation.
- `src/features/palette-search/palette-query-bar.tsx`: selected-color controls, status, count, error, and live-region limit message.
- `src/features/palette-search/palette-query-bar.test.tsx`: removal, clear, loading, and 5-color limit behavior.
- `src/features/palette-search/palette-search-results.tsx`: ordered result grid and empty state.
- `src/features/palette-search/palette-search-results.test.tsx`: ranking preservation and card callback wiring.
- `src/features/palette-search/use-palette-search-session.ts`: snapshot, 150 ms debounce, cancellation, stale-result rejection, and restore.
- `src/features/palette-search/use-palette-search-session.test.tsx`: fake-timer session state tests.
- `src/features/library/pattern-card.tsx`: place compact swatches in grid and list cards.
- `src/features/library/pattern-grid.tsx`: pass palette selection callbacks and selected colors to cards.
- `src/features/library/inspector.tsx`: render larger labeled swatches.
- `src/features/image-search/image-search-results.tsx`: allow palette clicks in image-search result cards.
- `src/features/library/library-toolbar.tsx`: lock sort while either ranked-search mode is active.
- `src/features/library/library-view.tsx`: coordinate mutually exclusive normal, image, and palette sessions.
- `src/features/library/library-view.test.tsx`: integration coverage for switching, restoring, filtering, and mutation updates.
- `src/app/globals.css`: fixed swatch rows, query bar, focus states, wrapping, and mobile targets.

### End-to-End and Operations

- `tests/e2e/image-search-fixtures.ts`: seed version-2 ready documents and 3-5 palette colors per fixture.
- `tests/e2e/image-search-stub.ts`: serve both internal image and palette search endpoints.
- `tests/e2e/image-search.spec.ts`: retain image-search coverage after the version bump.
- `tests/e2e/palette-search.spec.ts`: desktop/mobile palette display, multi-color query, filters, restore, keyboard, and overflow checks.
- `playwright.config.ts`: include the palette spec in the isolated visual-search project.
- `src/features/image-search/index-service.ts`: bump the active version fallback to `visual-search-v2`.
- `services/visual-search/src/melon_visual_search/settings.py`: bump the worker/API version fallback to `visual-search-v2`.
- `.env.example`: document the shared flag and version-2 setting.
- `docs/operations/visual-search.md`: version-2 migration, backfill, benchmark, enablement, and rollback procedure.
- `docs/verification/2026-10-22-palette-search.md`: record commands, counts, screenshots, benchmark values, and remaining production gates.

## Phase 1: Atomic Palette Data

### Task 1: Add the palette schema and database invariants

**Files:**
- Modify: `src/lib/db/schema/visual-search.ts`
- Modify: `src/lib/db/schema/visual-search.integration.test.ts`
- Modify: `src/test/database.ts`
- Create: `drizzle/0006_melon_palette_search.sql`
- Create: `drizzle/meta/0006_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [x] **Step 1: Write failing schema tests**

Add an `insertPaletteColor` helper and tests proving that a valid 3-row palette can be stored, an owner/pattern mismatch is rejected, duplicate indexes are rejected, invalid HEX/coverage/index values are rejected by named checks, and deleting the parent document cascades to the palette rows.

```ts
const insertPaletteColor = (input: {
  documentId: string;
  ownerId: string;
  patternId: string;
  colorIndex: number;
  displayHex: string;
  oklab: readonly [number, number, number];
  coverage: number;
}) => db.execute(sql`
  insert into visual_search_palette_colors (
    document_id, owner_id, pattern_id, color_index,
    display_hex, oklab_l, oklab_a, oklab_b, coverage
  ) values (
    ${input.documentId}, ${input.ownerId}, ${input.patternId},
    ${input.colorIndex}, ${input.displayHex}, ${input.oklab[0]},
    ${input.oklab[1]}, ${input.oklab[2]}, ${input.coverage}
  )
`);
```

- [x] **Step 2: Run the focused integration test and confirm the missing-table failure**

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/lib/db/schema/visual-search.integration.test.ts'
```

Expected: FAIL with `relation "visual_search_palette_colors" does not exist`.

- [x] **Step 3: Define the Drizzle table with database checks**

Add the table after `visualSearchEmbeddings` and export it through the existing schema barrel:

```ts
export const visualSearchPaletteColors = pgTable(
  "visual_search_palette_colors",
  {
    documentId: uuid("document_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    colorIndex: integer("color_index").notNull(),
    displayHex: text("display_hex").notNull(),
    oklabL: real("oklab_l").notNull(),
    oklabA: real("oklab_a").notNull(),
    oklabB: real("oklab_b").notNull(),
    coverage: real("coverage").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.colorIndex] }),
    foreignKey({
      columns: [table.documentId, table.ownerId, table.patternId],
      foreignColumns: [
        visualSearchDocuments.id,
        visualSearchDocuments.ownerId,
        visualSearchDocuments.patternId,
      ],
      name: "visual_search_palette_colors_document_owner_fk",
    }).onDelete("cascade"),
    check(
      "visual_search_palette_colors_index_check",
      sql`${table.colorIndex} between 0 and 4`,
    ),
    check(
      "visual_search_palette_colors_hex_check",
      sql`${table.displayHex} ~ '^#[0-9A-F]{6}$'`,
    ),
    check(
      "visual_search_palette_colors_coverage_check",
      sql`${table.coverage} > 0 and ${table.coverage} <= 1`,
    ),
    check(
      "visual_search_palette_colors_oklab_check",
      sql`${table.oklabL} >= 0 and ${table.oklabL} <= 1
        and ${table.oklabA} >= -0.5 and ${table.oklabA} <= 0.5
        and ${table.oklabB} >= -0.5 and ${table.oklabB} <= 0.5`,
    ),
    index("visual_search_palette_colors_owner_pattern_idx").on(
      table.ownerId,
      table.patternId,
    ),
  ],
);
```

Import `check` from `drizzle-orm/pg-core`, and insert `"visual_search_palette_colors"` before `"visual_search_documents"` in `resetDatabase()`.

- [x] **Step 4: Generate, inspect, and apply the deterministic migration**

```bash
npx --yes --package=node@24 -c 'npm run db:generate -- --name melon_palette_search'
npx --yes --package=node@24 -c 'npm run db:migrate'
```

Confirm the generated SQL contains all four named checks, the composite cascading foreign key, primary key, and owner/pattern index. Keep the generated snapshot and journal together with `0006_melon_palette_search.sql`.

- [x] **Step 5: Run focused schema tests**

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/lib/db/schema/visual-search.integration.test.ts src/test/database.test.ts'
```

Expected: PASS.

- [x] **Step 6: Commit the schema slice**

```bash
git add drizzle src/lib/db/schema/visual-search.ts src/lib/db/schema/visual-search.integration.test.ts src/test/database.ts
git commit -m "feat: add visual search palettes"
```

### Task 2: Preserve alpha and extract deterministic palettes

**Files:**
- Modify: `services/visual-search/src/melon_visual_search/image_io.py`
- Create: `services/visual-search/src/melon_visual_search/palette.py`
- Modify: `services/visual-search/tests/test_image_io.py`
- Create: `services/visual-search/tests/test_palette.py`

- [ ] **Step 1: Write extraction tests before the implementation**

Cover these exact invariants:

```python
def test_extract_palette_is_deterministic() -> None:
    first = extract_palette(RGB_FIXTURE, None)
    second = extract_palette(RGB_FIXTURE, None)
    assert first == second
    assert 3 <= len(first) <= 5
    assert sum(color.coverage for color in first) == pytest.approx(1.0)


def test_extract_palette_ignores_fully_transparent_pixels() -> None:
    palette = extract_palette(TRANSPARENT_RED_WITH_GREEN_CENTER, ALPHA_MASK)
    assert palette[0].display_hex == "#00FF00"
    assert all(color.display_hex != "#FF0000" for color in palette)


def test_uniform_image_gets_three_distinct_lightness_steps() -> None:
    palette = extract_palette(np.full((32, 32, 3), [40, 90, 70], dtype=np.uint8), None)
    assert len(palette) == 3
    assert len({color.display_hex for color in palette}) == 3
    assert [color.coverage for color in palette] == pytest.approx([1 / 3] * 3)
```

Also test half-transparent weighting, fewer than 16 visible alpha values falling back to the composited image, fixed-grid sampling at 16,384 pixels, coverage ordering, and uppercase HEX output.

- [ ] **Step 2: Run the focused tests and confirm import failures**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_image_io.py services/visual-search/tests/test_palette.py -q
```

Expected: FAIL because `palette.py` and `decode_image_inputs` do not exist.

- [ ] **Step 3: Add an alpha-preserving decode result without changing embeddings**

Introduce this immutable value and keep `decode_image()` as a compatibility wrapper:

```python
@dataclass(frozen=True)
class DecodedImage:
    embedding_rgb: npt.NDArray[np.uint8]
    palette_rgb: npt.NDArray[np.uint8]
    palette_alpha: npt.NDArray[np.uint8] | None


def decode_image_inputs(encoded: bytes) -> DecodedImage:
    image = _open_and_normalize(encoded)
    palette_rgb, palette_alpha = _palette_planes(image)
    embedding_rgb = _composite_for_embedding(image)
    return DecodedImage(
        embedding_rgb=embedding_rgb,
        palette_rgb=palette_rgb,
        palette_alpha=palette_alpha,
    )


def decode_image(encoded: bytes) -> npt.NDArray[np.uint8]:
    return decode_image_inputs(encoded).embedding_rgb
```

Reuse the current decode limits, EXIF transpose, ICC conversion, and deterministic embedding background. `palette_rgb` remains height-by-width-by-three sRGB; `embedding_rgb` retains the shape already expected by region generation.

- [ ] **Step 4: Implement the pure extraction module**

Use immutable output and named version constants:

```python
MAX_PALETTE_SAMPLES = 16_384
TARGET_COLOR_COUNT = 5
MIN_COLOR_COUNT = 3
ALPHA_CUTOFF = 16
MERGE_DISTANCE = 0.035
KMEANS_SEED = 20_261_022


@dataclass(frozen=True)
class PaletteColor:
    display_hex: str
    oklab: tuple[float, float, float]
    coverage: float
```

Implement fixed-grid sampling, alpha weighting, vectorized sRGB-to-OKLab and OKLab-to-sRGB conversion, one-attempt seeded OpenCV k-means, nearest-cluster weighted coverage, deterministic merge ordering, duplicate-HEX coalescing, and the specified `L - 0.03 / L / L + 0.03` fallback with `0.06` retry. Normalize coverage after the last merge and sort by `(-coverage, display_hex)`.

- [ ] **Step 5: Verify extraction, style, and types**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_image_io.py services/visual-search/tests/test_palette.py -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search/src/melon_visual_search/image_io.py services/visual-search/src/melon_visual_search/palette.py services/visual-search/tests/test_image_io.py services/visual-search/tests/test_palette.py
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src/melon_visual_search
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the extraction slice**

```bash
git add services/visual-search/src/melon_visual_search/image_io.py services/visual-search/src/melon_visual_search/palette.py services/visual-search/tests/test_image_io.py services/visual-search/tests/test_palette.py
git commit -m "feat: extract deterministic image palettes"
```

### Task 3: Publish palettes atomically with visual documents

**Files:**
- Modify: `services/visual-search/src/melon_visual_search/repository.py`
- Modify: `services/visual-search/src/melon_visual_search/worker.py`
- Modify: `services/visual-search/tests/test_repository.py`
- Modify: `services/visual-search/tests/test_worker.py`
- Modify: `services/visual-search/tests/conftest.py`

- [ ] **Step 1: Add failing repository and worker tests**

Test publication rejects 2 or 6 colors, repeated/non-contiguous indexes, lowercase HEX, nonfinite OKLab, and coverage totals outside `1 +/- 1e-5`. Force the palette insert to fail and assert the document never becomes `ready` and no embedding survives. Update the worker fake repository to record palette arguments and assert one decode supplies both embeddings and palette extraction.

```python
assert published.palette == (
    PaletteColorRecord(0, "#285947", (0.42, -0.08, 0.03), 0.50),
    PaletteColorRecord(1, "#CC9C3F", (0.72, 0.03, 0.11), 0.30),
    PaletteColorRecord(2, "#8F4038", (0.48, 0.10, 0.05), 0.20),
)
```

- [ ] **Step 2: Run the focused tests and confirm signature failures**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_repository.py services/visual-search/tests/test_worker.py -q
```

Expected: FAIL because `Repository.publish` does not accept palette records.

- [ ] **Step 3: Add publication records and strict validation**

```python
@dataclass(frozen=True)
class PaletteColorRecord:
    color_index: int
    display_hex: str
    oklab: tuple[float, float, float]
    coverage: float
```

Extend `_validate_publication` to return validated embedding and palette sequences. In the existing transaction, delete the current document's embedding and palette rows, insert both collections, supersede the prior ready document, then mark the new document ready. Use `executemany` for the 3-5 rows and keep the lease ownership predicate on the final job update.

- [ ] **Step 4: Wire extraction into the worker**

```python
decoded = decode_image_inputs(encoded)
regions = make_regions(decoded.embedding_rgb)
palette = tuple(
    PaletteColorRecord(index, color.display_hex, color.oklab, color.coverage)
    for index, color in enumerate(
        extract_palette(decoded.palette_rgb, decoded.palette_alpha)
    )
)
```

Pass `palette=palette` to `publish`. Treat extraction exceptions through the existing stable job failure/retry path; do not mutate `patterns.status` or `preview_status`.

- [ ] **Step 5: Verify publication and transaction behavior**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_repository.py services/visual-search/tests/test_worker.py -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search/src/melon_visual_search/repository.py services/visual-search/src/melon_visual_search/worker.py services/visual-search/tests/test_repository.py services/visual-search/tests/test_worker.py services/visual-search/tests/conftest.py
```

Expected: PASS, including rollback tests.

- [ ] **Step 6: Commit atomic publication**

```bash
git add services/visual-search/src/melon_visual_search/repository.py services/visual-search/src/melon_visual_search/worker.py services/visual-search/tests/test_repository.py services/visual-search/tests/test_worker.py services/visual-search/tests/conftest.py
git commit -m "feat: publish palettes with visual indexes"
```

## Phase 2: Exact Palette Ranking

### Task 4: Implement scoped OKLab palette ranking

**Files:**
- Create: `services/visual-search/config/palette-scoring-v1.json`
- Create: `services/visual-search/src/melon_visual_search/palette_search.py`
- Modify: `services/visual-search/src/melon_visual_search/repository.py`
- Modify: `services/visual-search/src/melon_visual_search/search.py`
- Create: `services/visual-search/tests/test_palette_search.py`
- Modify: `services/visual-search/tests/test_repository.py`
- Modify: `services/visual-search/tests/test_search.py`

- [ ] **Step 1: Write failing ranking and repository tests**

Use fixed OKLab candidates to prove this order: exact group, small color shifts, one missing query color, unrelated palette. Add tests showing candidate coverage changes only the candidate-side term, ties sort by canonical `pattern_id`, candidates above the threshold disappear, non-ready/wrong-version/wrong-owner/out-of-scope rows never load, and a scope over 10,000 IDs is rejected.

```python
assert [item.pattern_id for item in rank_palettes(query, candidates, config)] == [
    EXACT_ID,
    NEAR_ID,
    MISSING_ID,
]
assert rank_palettes(query, unrelated, config) == ()
```

- [ ] **Step 2: Run the tests and confirm missing-module failures**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_palette_search.py services/visual-search/tests/test_repository.py services/visual-search/tests/test_search.py -q
```

Expected: FAIL because palette ranking and repository reads are absent.

- [ ] **Step 3: Add and validate the versioned scoring config**

Create exactly this initial contract:

```json
{
  "schemaVersion": 1,
  "version": "palette-scoring-v1",
  "weights": {
    "queryCoverage": 0.8,
    "candidateFit": 0.2
  },
  "thresholds": {
    "maximumDistance": 0.24,
    "tieTolerance": 1e-9
  },
  "resultLimit": 30
}
```

Reject unknown keys, nonfinite values, weights not summing to one, nonpositive thresholds, or a result limit other than 30. Resolve the file from settings instead of the process working directory.

- [ ] **Step 4: Implement pure vectorized ranking**

```python
distance = (
    config.query_coverage_weight
    * np.min(pairwise, axis=1).mean()
    + config.candidate_fit_weight
    * np.average(np.min(pairwise, axis=0), weights=candidate.coverages)
)
```

Convert query HEX to OKLab with the same conversion used by extraction. Return immutable `PaletteSearchItem(pattern_id, distance)` values. Sort with a comparator that treats distances within `tie_tolerance` as equal and then compares the UUID string; cap at 30 after applying `maximum_distance`.

- [ ] **Step 5: Add one scoped repository query and service method**

Add `Repository.list_ready_palettes(owner_id, index_version, allowed_pattern_ids)` using `pattern_id = ANY(%s::uuid[])`, ready documents only, and deterministic `ORDER BY pattern_id, color_index`. Group 3-5 rows per candidate and reject malformed stored palettes as `PALETTE_DATA_INVALID` rather than silently ranking them.

Extend the current `SearchRepository` protocol and service:

```python
@dataclass(frozen=True)
class PaletteSearchResult:
    colors: tuple[str, ...]
    items: tuple[PaletteSearchItem, ...]


def search_palette(
    self,
    owner_id: UUID,
    allowed_pattern_ids: tuple[UUID, ...],
    colors: tuple[str, ...],
) -> PaletteSearchResult:
    candidates = self._repository.list_ready_palettes(
        owner_id=owner_id,
        index_version=self._settings.active_version,
        allowed_pattern_ids=allowed_pattern_ids,
    )
    if not candidates:
        raise NoIndexError()
    return PaletteSearchResult(colors, rank_palettes(colors, candidates, self._palette_config))
```

- [ ] **Step 6: Verify scoring, scope, style, and types**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_palette_search.py services/visual-search/tests/test_repository.py services/visual-search/tests/test_search.py -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search/src/melon_visual_search services/visual-search/tests
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src/melon_visual_search
```

Expected: all commands PASS.

- [ ] **Step 7: Commit exact palette ranking**

```bash
git add services/visual-search/config/palette-scoring-v1.json services/visual-search/src/melon_visual_search/palette_search.py services/visual-search/src/melon_visual_search/repository.py services/visual-search/src/melon_visual_search/search.py services/visual-search/tests/test_palette_search.py services/visual-search/tests/test_repository.py services/visual-search/tests/test_search.py
git commit -m "feat: rank images by palette similarity"
```

### Task 5: Expose the authenticated internal palette endpoint

**Files:**
- Modify: `services/visual-search/src/melon_visual_search/app.py`
- Modify: `services/visual-search/tests/test_app.py`

- [ ] **Step 1: Add failing endpoint contract tests**

Test missing/wrong Bearer token, non-JSON content type, malformed JSON, unknown fields, noncanonical UUIDs, empty/duplicate/lowercase/over-five colors, duplicate/over-10,000 allowed IDs, no-index, timeout, unavailable service, success order, and graceful shutdown waiting for an accepted palette task.

```python
response = await client.post(
    "/internal/palette-search",
    headers={"Authorization": f"Bearer {TOKEN}"},
    json={
        "ownerId": str(OWNER_ID),
        "allowedPatternIds": [str(PATTERN_ID)],
        "requestId": str(REQUEST_ID),
        "colors": ["#285947", "#CC9C3F"],
    },
)
assert response.json()["items"][0]["patternId"] == str(PATTERN_ID)
```

- [ ] **Step 2: Run the focused app tests and confirm 404**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_app.py -q
```

Expected: the new endpoint tests FAIL with 404.

- [ ] **Step 3: Add strict Pydantic models and endpoint**

Define models with `ConfigDict(extra="forbid", populate_by_name=True)`, field aliases matching the JSON contract, and field validators enforcing canonical UUID text and uppercase unique HEX values. Return only request ID, query colors, pattern IDs, and finite distances.

```python
@app.post(
    "/internal/palette-search",
    response_model=InternalPaletteSearchResponse,
    dependencies=[Depends(require_internal_token), Depends(_require_search_running)],
)
async def palette_search(
    body: InternalPaletteSearchRequest,
    service: SearchService = Depends(get_search_service),
    limiter: SearchConcurrencyLimiter = Depends(get_search_limiter),
) -> InternalPaletteSearchResponse:
    if not await limiter.try_acquire():
        raise _error(503, "UNAVAILABLE")
    task = _create_palette_search_task(service, limiter, body)
    result = await _await_palette_search(task)
    return _palette_response(body.request_id, result)
```

Generalize the active task set to the union of image and palette results so the existing lifespan still blocks closure until every accepted thread finishes. Map validation to `INVALID_COLORS`, no ready palette to `NO_INDEX`, timeout to `TIMEOUT`, and other controlled failures to `UNAVAILABLE`.

- [ ] **Step 4: Verify the API and the existing image endpoint together**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_app.py services/visual-search/tests/test_search.py -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search/src/melon_visual_search/app.py services/visual-search/tests/test_app.py
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src/melon_visual_search
```

Expected: PASS with no image-search regressions.

- [ ] **Step 5: Commit the internal endpoint**

```bash
git add services/visual-search/src/melon_visual_search/app.py services/visual-search/tests/test_app.py
git commit -m "feat: expose internal palette search"
```

## Phase 3: Server DTO and Public API

### Task 6: Batch-enrich Pattern DTOs with palette state

**Files:**
- Create: `src/features/patterns/pattern-palette-repository.ts`
- Create: `src/features/patterns/pattern-palette-repository.integration.test.ts`
- Modify: `src/features/patterns/pattern-service.ts`
- Modify: `src/features/patterns/pattern-service.integration.test.ts`
- Modify: `src/features/patterns/pattern-batch-service.ts`
- Modify: `src/features/patterns/pattern-batch-service.integration.test.ts`
- Modify: `src/features/uploads/upload-service.ts`
- Modify: `src/features/uploads/upload-service.integration.test.ts`
- Modify: `src/features/library/library-types.ts`
- Modify: `src/features/library/pattern-mutations.ts`
- Modify: `src/features/library/library-view.test.tsx`

- [ ] **Step 1: Write failing repository and DTO tests**

Seed four patterns: ready document with 3 colors, indexing job, terminal failed job, and old-version ready document. Assert one batch query returns `ready`, `pending`, `failed`, and `pending` respectively; wrong-owner rows never appear. Verify list/detail responses include required fields and list hydration performs a fixed number of queries rather than one per pattern.

```ts
expect(response.items.map(({ paletteStatus, palette }) => ({ paletteStatus, palette }))).toEqual([
  {
    paletteStatus: "ready",
    palette: [
      { hex: "#285947", coverage: 0.5 },
      { hex: "#CC9C3F", coverage: 0.3 },
      { hex: "#8F4038", coverage: 0.2 },
    ],
  },
  { paletteStatus: "pending", palette: [] },
  { paletteStatus: "failed", palette: [] },
  { paletteStatus: "pending", palette: [] },
]);
```

- [ ] **Step 2: Run focused tests and confirm missing fields**

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/patterns/pattern-palette-repository.integration.test.ts src/features/patterns/pattern-service.integration.test.ts src/features/patterns/pattern-batch-service.integration.test.ts src/features/uploads/upload-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm run test -- src/features/library/library-view.test.tsx'
```

Expected: FAIL because palette state is not part of `PatternItem`.

- [ ] **Step 3: Define required public palette types and defaults**

```ts
export type PatternPaletteStatus = "pending" | "ready" | "failed";

export type PatternPaletteColor = {
  hex: string;
  coverage: number;
};
```

Append `paletteStatus: PatternPaletteStatus` and `palette: PatternPaletteColor[]` as required properties on the existing `PatternItem`. Use `{ paletteStatus: "pending", palette: [] }` for new uploads and mutation paths that have not loaded a visual document. Update replay schemas so stored results remain strict and old malformed operation payloads fail closed.

- [ ] **Step 4: Implement the batch palette-state loader**

Expose:

```ts
export async function loadPatternPaletteStates(input: {
  ownerId: string;
  patternIds: readonly string[];
  indexVersion: string;
  executor?: Pick<typeof db, "execute">;
}): Promise<Map<string, PatternPaletteState>>;
```

Use two bounded queries, never per-pattern queries: one for ready documents plus ordered colors, one for the latest active-version job status among IDs without ready colors. Validate that ready palettes contain 3-5 consecutive, unique uppercase colors with finite positive coverage summing to `1 +/- 1e-5`; treat malformed stored data as an internal error. Return pending when the feature is disabled or no current-version document/job exists.

- [ ] **Step 5: Enrich list, detail, and transactional mutation DTOs**

Load one map for each list page, one entry for detail, and use the transaction executor for update/batch results before storing idempotency payloads. Add a `withPalette(dto, state)` helper so all required fields are set in one place. In the client mutation merge, preserve current `paletteStatus` and `palette` when a metadata-only response contains the pending default.

- [ ] **Step 6: Verify server DTOs and client mutation behavior**

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/patterns/pattern-palette-repository.integration.test.ts src/features/patterns/pattern-service.integration.test.ts src/features/patterns/pattern-batch-service.integration.test.ts src/features/uploads/upload-service.integration.test.ts'
npx --yes --package=node@24 -c 'npm run test -- src/features/library/library-view.test.tsx'
npx --yes --package=node@24 -c 'npm run typecheck'
```

Expected: PASS.

- [ ] **Step 7: Commit Pattern DTO enrichment**

```bash
git add src/features/patterns/pattern-palette-repository.ts src/features/patterns/pattern-palette-repository.integration.test.ts src/features/patterns/pattern-service.ts src/features/patterns/pattern-service.integration.test.ts src/features/patterns/pattern-batch-service.ts src/features/patterns/pattern-batch-service.integration.test.ts src/features/uploads/upload-service.ts src/features/uploads/upload-service.integration.test.ts src/features/library/library-types.ts src/features/library/pattern-mutations.ts src/features/library/library-view.test.tsx
git commit -m "feat: expose palette state on patterns"
```

### Task 7: Add the public palette-search boundary

**Files:**
- Create: `src/features/palette-search/contracts.ts`
- Create: `src/features/palette-search/contracts.test.ts`
- Create: `src/features/palette-search/internal-client.ts`
- Create: `src/features/palette-search/internal-client.test.ts`
- Create: `src/features/palette-search/palette-search-service.ts`
- Create: `src/features/palette-search/palette-search-service.integration.test.ts`
- Create: `src/features/palette-search/palette-search-client.ts`
- Create: `src/features/palette-search/palette-search-client.test.ts`
- Create: `src/features/visual-search/internal-json.ts`
- Create: `src/features/visual-search/internal-json.test.ts`
- Modify: `src/features/image-search/internal-client.ts`
- Modify: `src/features/image-search/internal-client.test.ts`
- Modify: `src/features/image-search/pattern-scope.ts`
- Modify: `src/features/image-search/pattern-scope.integration.test.ts`
- Create: `src/app/api/palette-search/route.ts`
- Create: `src/app/api/palette-search/route.test.ts`

- [ ] **Step 1: Write failing contract, service, route, and browser-client tests**

Require exactly 1-5 unique uppercase colors and a strict object. Reuse the current image-search filter schema. Test auth and same-origin checks occur before body parsing, JSON content type is required, service results outside the allowed set are rejected, missing rows fail closed, server ranking survives DTO hydration, responses are `no-store`, and AbortSignal reaches both browser and internal fetch calls.

```ts
expect(
  paletteSearchRequestSchema.safeParse({
    requestId,
    colors: ["#285947", "#CC9C3F"],
    filters: {},
  }).success,
).toBe(true);

for (const colors of [[], ["#285947", "#285947"], ["#285947".toLowerCase()]]) {
  expect(paletteSearchRequestSchema.safeParse({ requestId, colors, filters: {} }).success).toBe(false);
}
```

- [ ] **Step 2: Run focused tests and confirm module/route failures**

```bash
npx --yes --package=node@24 -c 'npm run test -- src/features/visual-search/internal-json.test.ts src/features/image-search/internal-client.test.ts src/features/palette-search/contracts.test.ts src/features/palette-search/internal-client.test.ts src/features/palette-search/palette-search-client.test.ts src/app/api/palette-search/route.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/palette-search/palette-search-service.integration.test.ts src/features/image-search/pattern-scope.integration.test.ts'
```

Expected: FAIL because the palette-search boundary does not exist.

- [ ] **Step 3: Extract the bounded internal JSON reader**

Move the existing body-stream loop from `image-search/internal-client.ts` into a shared visual-search helper with this exact public boundary:

```ts
export const MAX_INTERNAL_SEARCH_RESPONSE_BYTES = 64 * 1024;

export async function readBoundedInternalJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes = MAX_INTERNAL_SEARCH_RESPONSE_BYTES,
): Promise<unknown>;
```

Keep cancellation best-effort, always remove the abort listener and release the reader lock, reject the first chunk that exceeds the remaining allowance, and collapse malformed bodies only in the calling client. Re-export `MAX_INTERNAL_IMAGE_SEARCH_RESPONSE_BYTES` as an alias from the image client so existing imports remain compatible. Make both clients use this single helper.

- [ ] **Step 4: Implement strict shared contracts**

```ts
export const paletteHexSchema = z.string().regex(/^#[0-9A-F]{6}$/);

export const paletteSearchRequestSchema = z
  .object({
    requestId: publicOperationIdSchema,
    colors: z.array(paletteHexSchema).min(1).max(5),
    filters: imageSearchFiltersSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.colors).size !== value.colors.length) {
      context.addIssue({ code: "custom", path: ["colors"], message: "duplicate colors" });
    }
  });
```

Define internal request/response schemas with canonical UUIDs, finite nonnegative distances, at most 30 unique items, and exact request ID echo. Define only the four public errors approved in the design.

- [ ] **Step 5: Share ordered hydration and implement server orchestration**

Extract `hydratePatternIdsInOrder({ ownerId, patternIds })` from the current ranked image hydration and keep the image-specific `kind` wrapper intact. The shared hydrator must load the active-version palette-state map once, apply `withPalette` to every DTO, and preserve `listPatternRowsByIds` input order so image-search results also gain color cards without an N+1 query. Palette orchestration must:

1. Resolve allowed IDs with existing library filters and the 10,000 cap.
2. Short-circuit to `PALETTE_SEARCH_NO_INDEX` for an empty scope.
3. Send owner, allowed IDs, colors, and request ID to `/internal/palette-search` using the existing service URL/token configuration.
4. Reject request-ID mismatch, duplicate IDs, or any ID outside the allowed set.
5. Hydrate by owner in service order and require every returned row.
6. Return `{ query: { colors }, items, timing: { totalMs } }` without distance values.

- [ ] **Step 6: Implement the browser client and route handler**

```ts
export async function searchPatternsByPalette(
  input: PaletteSearchRequest & { signal: AbortSignal },
  dependencies: { fetcher?: typeof fetch } = {},
) {
  return readApiResponse<PaletteSearchResponse>(
    await (dependencies.fetcher ?? fetch)("/api/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: input.requestId,
        colors: input.colors,
        filters: input.filters,
      }),
      signal: input.signal,
    }),
  );
}
```

The route follows the installed Next.js 16 `POST` handler API, calls the same authentication and origin guards as `/api/image-search`, rejects non-JSON media types before parsing, maps Zod failures to `PALETTE_SEARCH_INVALID_COLORS`, and sets `Cache-Control: no-store` on success and errors.

- [ ] **Step 7: Verify the full public boundary**

```bash
npx --yes --package=node@24 -c 'npm run test -- src/features/visual-search/internal-json.test.ts src/features/image-search/internal-client.test.ts src/features/palette-search/contracts.test.ts src/features/palette-search/internal-client.test.ts src/features/palette-search/palette-search-client.test.ts src/app/api/palette-search/route.test.ts'
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/palette-search/palette-search-service.integration.test.ts src/features/image-search/pattern-scope.integration.test.ts'
npx --yes --package=node@24 -c 'npm run typecheck'
```

Expected: PASS.

- [ ] **Step 8: Commit the public boundary**

```bash
git add src/features/palette-search src/features/visual-search/internal-json.ts src/features/visual-search/internal-json.test.ts src/features/image-search/internal-client.ts src/features/image-search/internal-client.test.ts src/features/image-search/pattern-scope.ts src/features/image-search/pattern-scope.integration.test.ts src/app/api/palette-search
git commit -m "feat: add palette search api"
```

## Phase 4: Accessible Palette UI

### Task 8: Render reusable swatches on cards and the inspector

**Files:**
- Create: `src/features/palette-search/palette-swatches.tsx`
- Create: `src/features/palette-search/palette-swatches.test.tsx`
- Modify: `src/features/library/pattern-card.tsx`
- Modify: `src/features/library/pattern-card-interactions.test.tsx`
- Modify: `src/features/library/pattern-grid.tsx`
- Modify: `src/features/library/inspector.tsx`
- Modify: `src/features/library/library-view.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing component and interaction tests**

Assert ready palettes render 3-5 native buttons in coverage order; pending renders five fixed placeholders; failed renders disabled segments with a tooltip; card buttons expose `aria-label="按颜色 #285947 搜索"` and `aria-pressed`; inspector labels include HEX and rounded percent. Clicking or pressing a swatch must not select the card, open preview, or open the inspector.

```tsx
await user.click(screen.getByRole("button", { name: "按颜色 #285947 搜索" }));
expect(onPaletteToggle).toHaveBeenCalledWith("#285947");
expect(onSelect).not.toHaveBeenCalled();
expect(onInspect).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run focused component tests and confirm missing UI**

```bash
npx --yes --package=node@24 -c 'npm run test -- src/features/palette-search/palette-swatches.test.tsx src/features/library/pattern-card-interactions.test.tsx src/features/library/library-view.test.tsx'
```

Expected: FAIL because no swatches are rendered.

- [ ] **Step 3: Implement the focused `PaletteSwatches` component**

Use these props and no API knowledge:

```ts
type PaletteSwatchesProps = {
  colors: readonly PatternPaletteColor[];
  status: PatternPaletteStatus;
  selectedColors?: ReadonlySet<string>;
  size: "compact" | "detail";
  interactive: boolean;
  onToggle?: (hex: string) => void;
};
```

Render a stable five-track container for pending/failed states and an equal-width 3-5 track container for ready colors. Use native buttons, `title` only for the failed explanation, visible text only in detail mode, and stop propagation for click, pointer-down, and Enter/Space key handling.

- [ ] **Step 4: Wire cards, grid, and inspector**

Add optional `selectedPaletteColors` and `onPaletteToggle` props through `PatternGrid` and `PatternCard`. In `Inspector`, use detail mode and show the same colors. When `IMAGE_SEARCH_ENABLED` is false, omit the interactive palette row entirely; pending space is reserved only when the feature is enabled.

- [ ] **Step 5: Add stable responsive styles**

Use a fixed row height, maximum 8 px card radius, 44 px touch hit targets on narrow viewports, a 2 px high-contrast selected ring, and zero letter-spacing changes. Ensure list rows and grid cards retain stable dimensions when palette state changes.

- [ ] **Step 6: Verify components, accessibility behavior, and types**

```bash
npx --yes --package=node@24 -c 'npm run test -- src/features/palette-search/palette-swatches.test.tsx src/features/library/pattern-card-assets.test.tsx src/features/library/pattern-card-interactions.test.tsx src/features/library/library-view.test.tsx'
npx --yes --package=node@24 -c 'npm run typecheck'
npx --yes --package=node@24 -c 'npm run lint -- src/features/palette-search/palette-swatches.tsx src/features/library/pattern-card.tsx src/features/library/pattern-grid.tsx src/features/library/inspector.tsx'
```

Expected: PASS.

- [ ] **Step 7: Commit swatch rendering**

```bash
git add src/features/palette-search/palette-swatches.tsx src/features/palette-search/palette-swatches.test.tsx src/features/library/pattern-card.tsx src/features/library/pattern-card-interactions.test.tsx src/features/library/pattern-grid.tsx src/features/library/inspector.tsx src/features/library/library-view.test.tsx src/app/globals.css
git commit -m "feat: display pattern color palettes"
```

### Task 9: Add the debounced multi-color search session

**Files:**
- Create: `src/features/palette-search/palette-query-bar.tsx`
- Create: `src/features/palette-search/palette-query-bar.test.tsx`
- Create: `src/features/palette-search/palette-search-results.tsx`
- Create: `src/features/palette-search/palette-search-results.test.tsx`
- Create: `src/features/palette-search/use-palette-search-session.ts`
- Create: `src/features/palette-search/use-palette-search-session.test.tsx`
- Modify: `src/features/image-search/image-search-results.tsx`
- Modify: `src/features/image-search/image-search-results.test.tsx`
- Modify: `src/features/library/library-toolbar.tsx`
- Modify: `src/features/library/library-view.tsx`
- Modify: `src/features/library/library-view.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing hook and UI tests**

With fake timers, test first-color entry, unique add, selected-color removal, last-color exit, clear, sixth-color rejection with live text, exactly one request after 150 ms, abort on change, stale response rejection, previous-result retention on rerun failure, first-run failure restoration, filter-triggered rerun, owner reset, and unmount cleanup. Component tests must assert server order is unchanged and empty/error states stay inside the palette result area.

```ts
act(() => result.current.toggle("#285947"));
act(() => result.current.toggle("#CC9C3F"));
await act(async () => vi.advanceTimersByTimeAsync(149));
expect(search).not.toHaveBeenCalled();
await act(async () => vi.advanceTimersByTimeAsync(1));
expect(search).toHaveBeenCalledTimes(1);
expect(search.mock.calls[0]?.[0].colors).toEqual(["#285947", "#CC9C3F"]);
```

- [ ] **Step 2: Run focused tests and confirm missing modules**

```bash
npx --yes --package=node@24 -c 'npm run test -- src/features/palette-search/palette-query-bar.test.tsx src/features/palette-search/palette-search-results.test.tsx src/features/palette-search/use-palette-search-session.test.tsx src/features/image-search/image-search-results.test.tsx src/features/library/library-view.test.tsx'
```

Expected: FAIL because the session and result surface do not exist.

- [ ] **Step 3: Implement the generic snapshot-aware session hook**

The hook's public input and result must use these explicit contracts:

```ts
export type PaletteSearchSessionInput<TSnapshot> = {
  ownerId: string;
  filters: ImageSearchFiltersInput;
  filterSignature: string;
  prepareEnter: () => TSnapshot;
  restoreSnapshot: (snapshot: TSnapshot) => void;
  search?: typeof searchPatternsByPalette;
};

export type PaletteSearchSession = {
  active: boolean;
  colors: readonly string[];
  response: PaletteSearchResponse | null;
  busy: boolean;
  error: string | null;
  retry: { colors: readonly string[]; message: string } | null;
  limitMessage: string | null;
  toggleColor: (hex: string) => void;
  removeColor: (hex: string) => void;
  clear: () => void;
  retryInitialFailure: () => void;
};
```

The hook stores one snapshot on first entry, keeps colors in insertion order, derives a canonical request signature from colors plus filters, waits 150 ms, creates a UUID and AbortController per request, and compares both run counter and echoed request state before committing. On rerun errors retain the last response. On initial failure, retain the failed colors in `retry`, restore the snapshot, and deactivate; `LibraryView` renders the retry message below the toolbar and calls `retryInitialFailure` to re-enter with the same colors.

- [ ] **Step 4: Implement query bar and result surface**

Use `X` icons from Lucide for per-color removal and exit/clear actions, tooltip labels for icon-only controls, selected color swatches rather than text pills, `role="status"` for progress/count, `role="alert"` for errors, and a polite live region for the five-color limit. `PaletteSearchResults` renders one `PatternGrid` in response order and does not expose distance values.

- [ ] **Step 5: Coordinate mutually exclusive search modes in `LibraryView`**

Extract existing normal-workspace capture/restore helpers so both ranked modes use the same selection, inspector, view mode, scroll, query, and URL behavior. Required transitions:

```text
normal -> palette: capture normal snapshot, start palette
image  -> palette: release image Blob/results, reuse image session's normal snapshot
palette -> image: abort palette, restore normal snapshot, then open image dialog
palette -> normal: abort, clear colors, restore snapshot
```

Pass palette callbacks through normal `PatternGrid`, `ImageSearchResults`, palette results, and `Inspector`. While palette search is active, use palette result items for selection/inspection and disable the ordinary sort control exactly as image search already does. Current filters trigger a rerun without replacing the saved snapshot.

- [ ] **Step 6: Style and verify the complete session**

```bash
npx --yes --package=node@24 -c 'npm run test -- src/features/palette-search/palette-query-bar.test.tsx src/features/palette-search/palette-search-results.test.tsx src/features/palette-search/use-palette-search-session.test.tsx src/features/image-search/image-search-results.test.tsx src/features/library/library-view.test.tsx'
npx --yes --package=node@24 -c 'npm run typecheck'
npx --yes --package=node@24 -c 'npm run lint -- src/features/palette-search src/features/library/library-view.tsx src/features/library/library-toolbar.tsx src/features/image-search/image-search-results.tsx'
```

Expected: PASS; no request survives owner change or unmount.

- [ ] **Step 7: Commit palette-search interaction**

```bash
git add src/features/palette-search/palette-query-bar.tsx src/features/palette-search/palette-query-bar.test.tsx src/features/palette-search/palette-search-results.tsx src/features/palette-search/palette-search-results.test.tsx src/features/palette-search/use-palette-search-session.ts src/features/palette-search/use-palette-search-session.test.tsx src/features/image-search/image-search-results.tsx src/features/image-search/image-search-results.test.tsx src/features/library/library-toolbar.tsx src/features/library/library-view.tsx src/features/library/library-view.test.tsx src/app/globals.css
git commit -m "feat: add multi-color palette search ui"
```

## Phase 5: Capacity, End-to-End, and Rollout

### Task 10: Add latency benchmark and browser acceptance coverage

**Files:**
- Create: `services/visual-search/src/melon_visual_search/palette_benchmark.py`
- Modify: `services/visual-search/src/melon_visual_search/cli.py`
- Create: `services/visual-search/tests/test_palette_benchmark.py`
- Modify: `tests/e2e/image-search-fixtures.ts`
- Modify: `tests/e2e/image-search-stub.ts`
- Modify: `tests/e2e/image-search.spec.ts`
- Create: `tests/e2e/palette-search.spec.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write failing benchmark and E2E expectations**

The benchmark test requires a JSON report with count, colors per candidate, warmups, iterations, individual milliseconds, p50, and p95. The browser test must verify 3-5 swatches in grid/list/inspector, one-color entry, three-color addition, repeated-color removal, current format filtering, ordered results, clear-and-restore behavior, image-search mutual exclusion, keyboard activation, light/dark screenshots, and no horizontal overflow at 1440, 1024, and 390 widths.

- [ ] **Step 2: Run focused tests and confirm missing benchmark/spec support**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_palette_benchmark.py -q
E2E_IMAGE_SEARCH=1 npx --yes --package=node@24 -c 'npm run test:e2e -- tests/e2e/palette-search.spec.ts --project=chromium-desktop'
```

Expected: FAIL because the benchmark command and palette E2E route are absent.

- [ ] **Step 3: Implement the deterministic benchmark**

Generate 10,000 candidates with five seeded valid OKLab colors, warm up five times, run 30 measured searches with one, three, and five query colors in rotation, and calculate nearest-rank p50/p95. The command must not access image bytes or log actual user colors.

```bash
.venv-visual-search/bin/uv run --project services/visual-search melon-visual-search palette-benchmark --count 10000 --iterations 30 --seed 20261022 --output /tmp/melon-palette-benchmark.json
```

The CLI exits nonzero when count exceeds 10,000, colors per candidate exceed five, results contain nonfinite values, or output cannot be written. Timing acceptance is recorded, not asserted in unit tests, to avoid machine-speed flakes.

- [ ] **Step 4: Extend isolated E2E fixtures and stub**

Seed `visual-search-v2` ready documents plus deterministic 3-color palettes for every fixture pattern. Route `/internal/search` and `/internal/palette-search` separately in the stub; validate Bearer auth and exact JSON fields, intersect with allowed IDs, and return a deterministic order that changes for the PNG filter so the browser test proves scope recomputation.

- [ ] **Step 5: Implement and run responsive E2E acceptance**

```bash
E2E_IMAGE_SEARCH=1 npx --yes --package=node@24 -c 'npm run test:e2e -- tests/e2e/image-search.spec.ts tests/e2e/palette-search.spec.ts'
```

Expected: both specs PASS across the configured isolated visual-search projects. Inspect every generated light/dark screenshot for text clipping, overlapping controls, broken swatches, and blank thumbnails.

- [ ] **Step 6: Verify benchmark tests and commit acceptance tooling**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_palette_benchmark.py -q
git add services/visual-search/src/melon_visual_search/palette_benchmark.py services/visual-search/src/melon_visual_search/cli.py services/visual-search/tests/test_palette_benchmark.py tests/e2e/image-search-fixtures.ts tests/e2e/image-search-stub.ts tests/e2e/image-search.spec.ts tests/e2e/palette-search.spec.ts playwright.config.ts
git commit -m "test: cover palette search end to end"
```

### Task 11: Bump the index version, backfill, and run final gates

**Files:**
- Modify: `src/features/image-search/index-service.ts`
- Modify: `src/features/image-search/index-service.integration.test.ts`
- Modify: `services/visual-search/src/melon_visual_search/settings.py`
- Modify: `services/visual-search/tests/test_app.py`
- Modify: `.env.example`
- Modify: `docs/operations/visual-search.md`
- Create: `docs/verification/2026-10-22-palette-search.md`

- [ ] **Step 1: Write failing active-version tests**

Update Node and Python settings tests to require `visual-search-v2` as the fallback, while still accepting an explicitly configured older version during a staged deployment.

```ts
expect(getActiveVisualSearchIndexVersion()).toBe("visual-search-v2");
```

```python
settings = Settings(internal_token="x" * 32)
assert settings.active_version == "visual-search-v2"
```

- [ ] **Step 2: Run focused version tests and confirm old defaults**

```bash
npx --yes --package=node@24 -c 'npm run test:integration -- src/features/image-search/index-service.integration.test.ts'
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_app.py -q
```

Expected: FAIL because defaults still reference `visual-search-v1`.

- [ ] **Step 3: Bump defaults and document staged rollout**

Change the two fallbacks and examples to `visual-search-v2`. Update the operations guide with this exact safe sequence: migrate schema; deploy API and worker with v2 support but keep the application active version at v1; enqueue `visual-search-v2`; wait for every eligible preview to reach complete or an investigated terminal failure; run quality and 10k benchmark gates; switch API, worker, and Next.js active version together; then enable the existing feature flag. Rollback changes the active version/flag only and never drops palette data.

- [ ] **Step 4: Run all automated verification before touching local runtime state**

```bash
.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests -q
.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search
.venv-visual-search/bin/uv run --project services/visual-search mypy services/visual-search/src/melon_visual_search
npx --yes --package=node@24 -c 'npm run test'
npx --yes --package=node@24 -c 'npm run test:integration'
npx --yes --package=node@24 -c 'npm run typecheck'
npx --yes --package=node@24 -c 'npm run lint'
npx --yes --package=node@24 -c 'npm run build'
E2E_IMAGE_SEARCH=1 npx --yes --package=node@24 -c 'npm run test:e2e -- tests/e2e/image-search.spec.ts tests/e2e/palette-search.spec.ts'
```

Expected: every command PASS. Record exact counts and durations in the verification document.

- [ ] **Step 5: Rebuild the local index and verify publication counts**

Stop any stale local API/worker processes, migrate the database, set the Next.js, API, and worker active-version environments to `visual-search-v2`, restart the API and single worker, and run:

```bash
npx --yes --package=node@24 -c 'npm run db:migrate'
npx --yes --package=node@24 -c 'npm run image-search:backfill -- --version visual-search-v2'
```

Wait until the queue is drained. Query counts by owner/version and assert every v2 `ready` document has 3-5 palette rows, consecutive indexes, unique HEX values, and coverage sum within tolerance. Investigate terminal failures rather than hiding them.

- [ ] **Step 6: Run local smoke tests and inspect screenshots**

Open `http://127.0.0.1:3000/library`. Verify normal grid, list, inspector, one/three/five colors, remove/clear, current filters, no-result state, service-down error, image-search switching, manual-preview replacement, keyboard operation, mobile width, light theme, and dark theme. Use Playwright screenshots and inspect them visually before recording the result.

- [ ] **Step 7: Run and record the 10,000-pattern performance gate**

```bash
.venv-visual-search/bin/uv run --project services/visual-search melon-visual-search palette-benchmark --count 10000 --iterations 30 --seed 20261022 --output /tmp/melon-palette-benchmark.json
```

Local results are diagnostic. Repeat the same command on the production-equivalent ECS and require palette API P95 at or below 1,000 ms before enabling the feature in production. Record CPU, memory, p50, p95, image digest, and host class without recording query colors.

- [ ] **Step 8: Review the complete diff and commit rollout evidence**

```bash
git diff --check
git status --short
git diff --stat 4e92de7..HEAD
git log --oneline 4e92de7..HEAD
git add src/features/image-search/index-service.ts src/features/image-search/index-service.integration.test.ts services/visual-search/src/melon_visual_search/settings.py services/visual-search/tests/test_app.py .env.example docs/operations/visual-search.md docs/verification/2026-10-22-palette-search.md
git commit -m "docs: verify palette search rollout"
```

Do not claim production readiness if the ECS performance or real-library quality gate remains outstanding; record it explicitly as a remaining gate while leaving `IMAGE_SEARCH_ENABLED=false` in production.

## Final Acceptance Checklist

- [ ] Every active-version ready preview has exactly 3-5 valid, unique, deterministic colors.
- [ ] Embeddings and palettes become visible in one publication transaction.
- [ ] Public and internal endpoints enforce authentication, tenant scope, canonical contracts, result bounds, cancellation, and no-store behavior.
- [ ] One to five selected colors rank by `0.8 * queryCoverage + 0.2 * candidateFit`, with stable ties and a 30-item cap.
- [ ] Card, list, inspector, image-search results, and palette-search results use the same accessible swatch component.
- [ ] Palette and image search are mutually exclusive and both restore the pre-search workspace correctly.
- [ ] Current folder, tag, favorite, format, authorization, and trash filters continue to define the allowed Pattern scope.
- [ ] Fast changes cannot let an old request overwrite the current palette result.
- [ ] Automated Python, Vitest, integration, typecheck, lint, build, and Playwright gates pass.
- [ ] Production-equivalent 10,000-pattern P95 is at most one second before the existing feature flag is enabled.
