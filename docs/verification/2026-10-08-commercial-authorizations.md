# Commercial Authorization Verification

Verified on 2026-10-14 (Asia/Shanghai), under Node.js 24.21.0. The filename follows the approved phase plan date. Base revision: `cb3f14bb640de73651170dc81d1108e2567af721`.

## Gate results

Commands ran from the repository root. Node 24 was selected with `npx -y -p node@24 -c '…'` because the host default Node is outside the project's supported range.

| Command actually run | Result |
| --- | --- |
| `npx -y -p node@24 -c 'npm test && npm run test:integration && npm run typecheck && npm run lint'` | Exit 0. Unit: 91 files / 776 tests passed, 17.74 s. Integration: 24 files / 266 tests passed; 1 opt-in real-OSS file/test skipped, 29.46 s. TypeScript and ESLint completed without diagnostics. |
| `npx -y -p node@24 -c 'npm run test:e2e:commercial -- --project=webkit-desktop --project=webkit-1024 --grep="trash preserves"'` | Exit 0. Both lifecycle regressions passed, 28.5 s. |
| `E2E_PORT=3212 E2E_DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_legacy_e2e npx -y -p node@24 -c 'npm run test:e2e'` | Exit 0. 6 passed and 6 intentionally skipped across Chrome, desktop WebKit and 1024 WebKit, 41.1 s. Real OSS uploads, previews, downloads, cleanup and Chromium server/isolation journeys passed. |
| `npx -y -p node@24 -c 'npm run test:e2e:commercial'` | Exit 0. 18/18 passed across all three projects, 1.4 min. |
| `MELON_E2E_SERVER=1 DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_commercial_e2e npx -y -p node@24 -c 'npm run build'` | Exit 0. Next.js 16.4.0 production build in `.next-e2e`: compilation 1,117 ms, TypeScript 2.5 s, 22/22 static-generation tasks completed. |
| `PERFORMANCE_DATABASE_URL=postgres://melon:melon@127.0.0.1:55432/melon_performance_test npx -y -p node@24 -c 'npm run seed:performance'` | Exit 0. Exactly 10,000 patterns / 100,000 authorizations; seed 4,517 ms; all 23 captured query plans passed the scan/index policies below. |

The legacy suite used the explicitly allowed `http://127.0.0.1:3212` OSS CORS origin and an isolated `_e2e` database; the user's development server on 3210 was neither reused nor stopped. Its six skips are deliberate: the folder workflow owns shared cross-browser fixture state and the two server-side isolation workflows run once in Chromium. The independently opt-in `RUN_REAL_OSS_TESTS=1` adapter test was not run, but it is not part of this phase gate; the browser suite exercised the configured STS upload/view/download path against real OSS.

The existing jsdom navigation diagnostic and Node `NO_COLOR`/`FORCE_COLOR` warnings appeared in test output; assertions and exit statuses above remain authoritative.

## Commercial and dashboard coverage

The four commercial journeys cover repeated ordinary licensing; editing price; field exclusivity with history confirmation, same-field rejection and other-field allowance; void and conflicting restore; buyout with history confirmation and future-write rejection; stale-version refresh; inline custom field creation and archive; trash history preservation, read-only write rejection and restore; permanent-delete impact counts, money, objects, enabled dangerous confirmation and cancellation; and another tenant's forbidden reads and create/edit/void/restore/archive attempts using schema-valid bodies.

Permanent deletion is deliberately **not executed against OSS in browser tests**. Actual deletion, authorization-history removal and the resulting historical-revenue change are covered by `src/features/trash/commercial-deletion.integration.test.ts` with fake OSS, included in the passing integration gate. No production storage injection or bypass was introduced.

The two dashboard journeys run once per theme in each configured project. Fixtures anchor dates to the current Shanghai date without changing production clocks: current-year revenue is ¥18,800.00, 4 effective authorizations, 4 patterns, average ¥4,700.00. A prior-year ¥700 record and older ¥300 record exercise the rolling-year and all-time presets; a void ¥99,999 record is excluded. A deleted pattern has no authorization rows, matching permanent-deletion semantics. Tests cover current year, rolling twelve months (including its December 31 boundary), all time and a one-day custom range; two fields and all three kinds; accessible trend-table values; state counts independent of period filters; field/pattern rankings; and actual library/trash drill-down navigation. Both themes also assert no page-level horizontal overflow.

| Browser project | Viewport | Journeys |
| --- | --- | --- |
| `chromium-desktop` | 1440 × 900 | 6/6 passed: 4 commercial + light/dark dashboard |
| `webkit-desktop` | 1440 × 900 | 6/6 passed: 4 commercial + light/dark dashboard |
| `webkit-1024` | 1024 × 1366 | 6/6 passed: the same full journeys (more than the planned smoke subset) |

Browser exploration exposed a real StrictMode deep-link bug: effect replay cleared `/library?selected=` selection while the applied-ID ref prevented reapplication. Two component regressions first failed, then passed after a minimal effect-dependency/ref reset fix. They also verify switching selected IDs and clearing selection on ordinary navigation. Subsequent failed browser iterations identified ambiguous locators, the modal inspector covering the narrow-layout bulk toolbar, and navigation before trash mutation completion; the tests now target exact semantic controls and await observable completion. Earlier failed runs are not counted as passes.

The real-OSS journey also exposed the completed upload tray obscuring repeated library actions. The tray now has an accessible collapse/expand control that preserves task state. A component regression covers both states, and the Chrome, desktop WebKit and 1024 WebKit journeys use the control through normal pointer interaction; the narrow journey first closes its modal inspector before interacting with the page behind it. A later full-suite rerun exposed that the test started tag creation before its preceding rename request had settled; the journey now awaits the successful rename response before beginning the independent tag workflow, and the complete suite then passed.

Dashboard screenshots were visually inspected in light/dark desktop Chromium and light/dark 1024 WebKit. No overlapping controls or horizontal page overflow were observed. Screenshots are regenerated in the ignored `test-results/` directory by each run.

## Test isolation and storage safety

Commercial E2E defaults to port 3211 and database `melon_commercial_e2e`; `E2E_PORT` can override the port. Both E2E commands use `.next-e2e` and refuse server reuse. `E2E_METADATA_ONLY=1` selects only these new specs and supplies nonfunctional test storage credentials. Startup and teardown reject databases without an `_e2e` suffix and reject any asset rows or upload-session object keys before skipping OSS cleanup, then assert emptiness again after reset. Each browser context blocks external requests. Fixtures contain no assets and use project-specific commercial IDs; dashboard fixtures reseed serially for the second test user.

After the final browser runs, `lsof -nP -iTCP:3210 -iTCP:3211 -iTCP:3212 -sTCP:LISTEN` showed only the existing user server on 3210; no test server remained on 3211 or 3212. Global teardown cleaned both dedicated E2E databases and the legacy suite's isolated OSS objects.

Performance seeding requires an explicit `PERFORMANCE_DATABASE_URL` whose database name ends `_performance_test`. It does not load `.env.local`, fall back to `DATABASE_URL`, create OSS objects or issue OSS calls. Only the reserved synthetic owner `eeeeeeee-0000-4000-8000-000000000001` is reseeded; unrelated owners are never truncated. Owner identity collisions or attached assets, uploads, folders or tags abort before deletion. The seeded owner cannot log in. Test rows are recoverable by rerunning the seed; the performance dataset remains in its dedicated test database for inspection.

Safety helpers were exercised with expected failures first: unsafe database URLs, unbounded sequential scans, missing expected indexes, and unfinished-upload object references are rejected. The final helper and component tests are part of the unit gate above.

## Target-scale query evidence

The seed generates 10,000 ready metadata patterns and 100,000 ordinary authorization rows for one owner, spread deterministically across ten years and twelve fields, with 10% void records. The benchmark date is fixed at `2026-10-08`. It runs the actual dashboard service, captures its parameterized repository SQL, and executes `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for each statement. No copied benchmark SQL, forced indexes or `enable_seqscan` overrides are used. The comparison-period query is checked in addition to the five requested metric families.

Execution times (milliseconds), from the successful seed run:

| Metric | Current year | Current year, field 1 | Current year, standard kind | All time |
| --- | ---: | ---: | ---: | ---: |
| Period KPIs | 6.557 | 2.168 | 6.163 | 47.814 |
| Comparison KPIs | 5.932 | 2.665 | 6.209 | Not applicable |
| Trend | 5.658 | 2.338 | 5.275 | 32.145 |
| Current state | 24.761 | 24.099 | 24.454 | 26.222 |
| Field ranking | 5.628 | 2.414 | 5.053 | 18.316 |
| Top patterns | 8.190 | 2.103 | 8.172 | 39.017 |

Observed and enforced access policy:

- Selective period, comparison, trend, field-ranking and top-pattern queries used `authorizations_owner_status_date_idx`. Adding a field used `authorizations_owner_field_status_date_idx`. The script requires the corresponding index and rejects authorization sequential scans for these statements. The standard-kind fixture retains the date index because every seeded kind is standard; this run does not prove selectivity of the kind index.
- Current-state counts deliberately ignore period/field/kind filters. PostgreSQL chose owner-filtered sequential scans of 10,000 patterns and 90,000 active authorization rows (10,000 void rows removed). This is explicitly allowed for current state.
- All-time statements also used owner-filtered full-range scans. These are allowed because the single-owner fixture selects most of the table; the field-ranking parallel scan reports 30,000 rows and 3,333 removed per worker. Any patterns/authorizations sequential scan without an `owner_id = …` filter fails in every scenario.
- Pattern joins may scan the owner's 10,000 patterns. They must also retain an owner filter. Full-range scans are not described as index hits.

Shared-buffer evidence: unfiltered current-year period/trend used 2,754 hit blocks (comparison 2,782, field ranking 2,757); field-filtered period/trend/field-ranking/top-pattern queries used 1,655 and comparison used 1,640. Current-state plans used 5,288. All-time plans used 5,288 except field ranking at 6,142. Shared read blocks were zero in this warmed run.

These are local, warm-cache observations for a single large owner, not cold-storage latency guarantees or a multi-tenant selectivity benchmark. The executable checks prove that selective date/field queries retain intended indexes and that any allowed full scan remains owner bounded. Raw JSON summaries are emitted on every rerun for review.
