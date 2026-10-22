# Visual Search Verification

Verified locally on 2026-10-22 (Asia/Shanghai). The filename follows the approved implementation-plan date.

## Locked inputs

- Index version: `visual-search-v1`
- Model SHA-256: `e306c964ab0a1a9bdb334af89ab657d58448417b830a6a7f7b742f85d4441ae8`
- Model artifact: DINOv2 small, FP32 ONNX, 88,453,010 bytes
- Benchmark seed: `20261020`
- Required real-library corpus: exactly 100 ready previews for one owner
- Local host: Apple M1 Pro, 32 GiB RAM, arm64 macOS

`shasum -a 256` matched the committed model lock. The opt-in real-model test also loaded that artifact and produced ten finite, normalized 384-dimensional embeddings.

## Automated evidence

Commands ran from the repository root.

| Command | Exit | Evidence |
| --- | ---: | --- |
| `.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_benchmark.py services/visual-search/tests/test_calibration.py services/visual-search/tests/test_search.py services/visual-search/tests/test_worker.py::test_cli_exposes_worker_cleanup_and_benchmark_commands -q` | 0 | 21 tests passed. Covers deterministic transforms, known metrics, quality gates, 70/30 calibration, atomic config publication, evidence reuse, the CLI contract, and a synthetic 100-pattern/1,600-query runner exercise. |
| `.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_recall.py::test_benchmark_sampling_is_deterministic_and_owner_version_scoped -q` | 0 | Deterministic PostgreSQL sampling passed with owner and index-version isolation. |
| `.venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests -q` | 0 | 325 passed and 1 opt-in real-model test skipped, including the container model-artifact preflight. The dedicated `melon_test` database was reset with the repository's `_test`-guarded helper before the successful calibration run because an interrupted earlier run had left two jobs behind. |
| `RUN_VISUAL_MODEL_TESTS=1 .venv-visual-search/bin/uv run --project services/visual-search pytest services/visual-search/tests/test_embedding.py::test_real_model_produces_ten_finite_normalized_embeddings -q` | 0 | 1 passed against the checksum-locked ONNX artifact. |
| `.venv-visual-search/bin/uv run --project services/visual-search ruff check services/visual-search` | 0 | No diagnostics. |
| `.venv-visual-search/bin/uv run --project services/visual-search mypy --no-incremental --config-file services/visual-search/pyproject.toml services/visual-search/src` | 0 | All 16 production source files passed strict type checking. |
| `npm test` | 0 | 118 files and 984 unit tests passed. |
| `npm run test:integration` | 0 | 30 files and 315 integration tests passed; 1 opt-in test skipped. An initial run had one unrelated 5-second `ILIKE` test timeout; the exact test then passed in 99 ms, its full 25-test file passed, and the unchanged full suite passed on rerun. |
| `npm run typecheck` | 0 | TypeScript completed without diagnostics. |
| `npm run lint` | 0 | Full-repository ESLint completed without diagnostics. |
| `npm run build` | 0 | Next.js 16.4 production build compiled, type-checked, generated all pages, and registered the image-search API/settings routes. |
| `npm test -- src/features/storage/operations-doc.test.ts src/test/e2e-environment.test.ts` | 0 | 15 deployment-policy and E2E cleanup-safety tests passed. |
| `npm run test:e2e -- tests/e2e/image-search.spec.ts` | 0 | The deterministic stub workflow passed in desktop Chromium, desktop WebKit, 1024x1366 WebKit, and 390x844 Chromium. Four real-model variants were skipped behind their explicit opt-in flag. |
| `ruby -e 'require "yaml"; YAML.safe_load(File.read("deploy/compose.visual-search.yaml"), aliases: true)'` | 0 | Compose YAML parsed successfully. |
| `git diff --check` | 0 | No whitespace errors. |

The runner creates `0600` query files in a private temporary directory, removes each generated image in `finally`, and removes the directory on every exit. Its JSON record allowlist contains only source/matched Pattern IDs, transform/family, negative flag, rank, category, score, and latency. Tests assert that OSS object keys and temporary paths are absent.

For a 100-pattern run, the deterministic transform inventory is 100 exact, 100 resize, 100 JPEG, 100 medium blur, 100 five-degree rotation, and 300 crops retaining at least 25% source area. Every positive query is repeated with its source Pattern ID excluded, yielding 800 positive and 800 negative records.

## Packaging and browser evidence

The container entrypoint tests prove that commands are not executed until the mounted ONNX file matches the committed lock size/SHA and the environment SHA. The deployment-policy tests assert Python 3.12 slim, frozen production dependencies, an unprivileged user, no model download, a read-only model mount/root filesystem, loopback-only publication, systemd memory/private-temp/restart/readiness controls, IMDSv2 with IMDSv1 disabled, the unchanged write-only browser STS actions, and daily one-shot cleanup.

The browser test covers file picking, removal, paste, crop, all three result groups, isolated result selection, source download, explicit result inspection, format-filter rerun, the no-source message, and exit restoration. Light and dark screenshots were inspected at CSS viewports 1440x900, 1024x1366, and 390x844. No application overlap, clipped text, horizontal overflow, blank result surface, or automatic inspector opening was observed. WebKit's high-DPI desktop screenshot is 2880x1800 pixels for the same 1440x900 CSS viewport.

Docker and `systemd-analyze` are not installed on this macOS host. Consequently, `docker build`, `docker compose config --quiet`, and native unit verification were not run here; the successful YAML parse and static deployment-policy tests do not replace those target-host checks. The opt-in browser test against a live real-model deployment was also not run because no external deployment credentials/base URL were supplied.

## Quality and calibration status

The real-library benchmark was **not run** in this workspace. No authenticated owner with 100 production-quality, ready indexed previews and OSS access was available. Therefore there are no honest real-corpus Top 1, Top 5, false-probable-source, or latency values to record.

The committed `scoring-v1.json` thresholds remain the pre-benchmark locked values. Synthetic fixtures verify the bounded 27-point grid, deterministic 70/30 split, false-probable-source constraint, untouched validation gate, and atomic write behavior; they are not evidence that the numeric thresholds meet production quality.

Run the real gate only after backfill supplies the required corpus:

```bash
uv run --project services/visual-search melon-visual-search benchmark \
  --owner-id "$OWNER_ID" \
  --count 100 \
  --seed 20261020 \
  --output /tmp/melon-visual-search-report.json
```

The command must exit `0` before publication. It enforces exact/resize/JPEG Top 1 at 98% or higher, crop Top 5 at 90% or higher, blur Top 5 at 85% or higher, negative false `probable_source` below 5%, and repeatable classification. A failed validation or aggregate gate does not replace the scoring configuration.

## Production gate

Production-equivalent ECS P95 search latency, peak memory, and OOM behavior were **not measured**. Local Apple Silicon timings are deliberately not reported as production evidence. Release remains blocked until the same image and model pass P95 at 8 seconds or less without OOM on the target ECS instance.

Keep `IMAGE_SEARCH_ENABLED=false` until both the real-library report and production ECS gate pass. The deployment sequence and rollback procedure are recorded in the visual-search operations guide added by the packaging phase.
