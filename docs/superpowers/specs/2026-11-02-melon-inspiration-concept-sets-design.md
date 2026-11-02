# Melon Inspiration Concept Sets Design

**Date:** 2026-11-02

**Status:** Approved for implementation planning

**Scope:** Generate one coordinated fashion concept set from a selected inspiration-report direction.

## 1. Context

Melon already produces a structured inspiration report with three to five design directions. Each direction contains a title, narrative, silhouette, palette, materials, details, and source references. The visual-report domain also has placeholders for a future single concept image, but the active service returns empty concept collections and no production generation workflow exists.

The new feature turns one selected design direction into a coordinated three-image set:

1. a hand-drawn design sketch;
2. a full-body fashion effect image on a digital model;
3. a clean front-and-back technical flat.

The three images must describe the same garment. Generation must continue when the browser is closed, survive service restarts, preserve completed work when one stage fails, and never expose provider credentials or temporary result URLs.

## 2. Product Decisions

The following decisions are fixed for the first release:

- Generation starts from one explicitly selected report direction, not from an automatically selected direction.
- The full report supplies background context, but the selected direction is the binding design brief.
- Before generation, Melon proposes up to three external research images associated with that direction. The user may deselect any of them.
- Private library images are not proposed or used.
- One click creates a coordinated set containing exactly one sketch, one effect image, and one technical flat.
- The sketch is the master design. The two derivative images are generated from that sketch.
- Results are stored with the report and are not automatically saved to the user's material library.
- Every completed image can be previewed and downloaded.
- The effect image and technical flat can be retried independently.
- Retrying the sketch creates a new set and then regenerates both derivatives; it never mutates a completed set into an internally inconsistent one.
- A direction may retain at most three non-deleted sets.
- Shared reports show completed outputs with an `AI 生成` label and no generation controls.
- The default production model is `qwen-image-3.0-pro` at 2K output quality.

## 3. Goals

- Produce a visually and structurally coherent three-image fashion concept set.
- Preserve the selected direction's silhouette, palette, materials, and construction details across all outputs.
- Let a user understand progress and recover from a partial failure without losing successful images.
- Continue work independently of the browser through a durable database-backed worker.
- Reuse the existing private OSS, session ownership, report sharing, and safe image-delivery boundaries.
- Roll out behind a disabled-by-default production feature flag.
- Keep the web request path short and avoid adding Redis or another queue service.

## 4. Non-goals

- Free-form prompt editing or an advanced prompt editor.
- User-uploaded ad hoc references outside the selected report.
- Automatic generation when a report completes.
- More than one variant per output type inside the same set.
- Print-ready vector flats, graded patterns, measurements, seam allowances, or a manufacturing tech pack.
- Automatic quality scoring or automatic paid regeneration.
- Automatic saving to the material library.
- A public provider task endpoint or direct access to provider result URLs.
- A global billing dashboard in the first release.

## 5. User Experience

### 5.1 Entry point

Each completed design-direction section shows an icon-and-text `灵感成图` command in its header. The control is absent when the feature flag is disabled and disabled while that direction already has an active set.

Selecting the command opens a right-side generation panel. The panel contains:

- the direction title;
- a compact, read-only summary of silhouette, palette, materials, and details;
- up to three automatically proposed external reference images;
- a checkbox for each proposed image, selected by default;
- a primary `生成整套成图` command;
- a concise notice that three AI images will be generated and billed by the configured provider.

The panel does not expose provider names, model parameters, raw prompts, or arbitrary URL inputs.

### 5.2 Reference selection

Default references are selected deterministically from the active visual report:

1. assets whose `sourceIndexes` overlap the selected direction;
2. product-role evidence before general evidence;
3. lower report ordinal before higher ordinal;
4. report-level hero or product images as fallback.

At most three unique assets are proposed. Zero references is valid and produces a text-only sketch request.

The create request includes the active visual-job identity. If the report visuals were refreshed after the panel opened, the server rejects stale reference selection and the client refreshes the panel rather than silently using another visual version.

### 5.3 Report presentation

Each direction renders an unframed `灵感成图` subsection below its textual design details. A compact tab or segmented control selects `方案 01`, `方案 02`, or `方案 03`. The latest set is selected by default.

The selected set reserves a stable three-column desktop layout:

- `设计草图`, aspect ratio 3:4;
- `服装效果图`, aspect ratio 3:4;
- `服装款式图`, aspect ratio 4:3.

Each slot has fixed dimensions and one of these states:

- queued;
- generating;
- completed;
- failed;
- retrying while the previous completed output remains visible.

Completed figures offer preview and download. Effect-image and flat failures offer a local retry. The sketch action is labeled `以新草图重做整套` because it creates a new version. A set-level menu provides `重新生成整套` and `删除此方案`.

Deleting a set hides it immediately and schedules private-object cleanup. It does not delete the report or any other set.

### 5.4 Sharing

The shared report includes only completed outputs. A partially completed set may show its completed images, but it never shows placeholders, failures, task status, reference-selection state, or retry controls. Every generated figure carries an `AI 生成 · 设计推演` label.

## 6. Generation Brief

The server builds and stores an immutable, versioned `inspiration-concept-brief-v1` snapshot when a set is created. Browser-supplied descriptive text is not trusted.

The snapshot contains only validated report data:

- report headline and summary;
- the strongest bounded market-signal names and rationales;
- selected direction index and title;
- direction narrative;
- silhouette;
- ordered palette;
- ordered materials;
- ordered construction details;
- selected reference asset identities in display order;
- prompt-template version;
- model and output-size policy.

Raw web HTML, source-page bodies, arbitrary source URLs, provider responses, private library fields, owner identifiers, and OSS object keys never enter the prompt snapshot.

The selected direction is authoritative. Global report context may enrich the visual mood but may not override the direction's garment category, silhouette, palette, materials, or details.

## 7. Coordinated Generation Pipeline

### 7.1 Stage one: design sketch

The sketch task uses the frozen brief and zero to three selected external references.

Output requirements:

- `1536x2048` PNG;
- full garment visible;
- fashion-designer hand-drawn presentation;
- legible construction intent without relying on generated text;
- no logo, watermark, UI, recognizable public figure, or copied brand identity;
- original synthesis rather than reproduction of one reference.

The references are described as mood, color, material, and silhouette inspiration only.

### 7.2 Stage two: derivative outputs

After the sketch is safely persisted, the worker enqueues both derivative tasks. They may run concurrently at the provider even though the local worker submits work conservatively.

Each derivative receives at most three images in this order:

1. the completed master sketch;
2. the first selected external reference, if present;
3. the second selected external reference, if present.

The third external reference influences the sketch but is omitted from derivative requests because the Qwen Image 3.0 series accepts at most three input images.

The effect-image prompt requires:

- `1536x2048` PNG;
- a full-body digital fashion model in a restrained studio setting;
- the same silhouette, seams, closures, palette, material behavior, and key details as the sketch;
- physically plausible garment construction and drape;
- no brand mark, watermark, unrelated props, public figure, or caption text.

The technical-flat prompt requires:

- `2048x1536` PNG;
- front and back views side by side on a clean white background;
- no model, pose, scenery, text labels, dimensions, or decorative layout;
- clear outline and construction lines;
- exact preservation of the master sketch's silhouette, closures, panels, pockets, seams, and color blocking.

Prompt extension may be enabled for sketch and effect generation. The technical-flat adapter uses the strict tested provider configuration that gives the best adherence; it must not be changed through browser input.

### 7.3 Retry semantics

- A failed or unsatisfactory effect image creates a new effect task in the same set.
- A failed or unsatisfactory flat creates a new flat task in the same set.
- A completed previous derivative remains visible while its replacement is generating.
- A replacement becomes current only after the new file is stored and its database row commits.
- Replacing an output schedules the superseded private object for cleanup.
- A sketch retry creates a new set with a new version and operation ID. The original set remains unchanged.
- No task is automatically regenerated because of subjective quality.

## 8. Persistence Model

The new workflow uses additive tables. Existing inspiration visual jobs/assets remain readable and are not destructively migrated during rollout.

### 8.1 `inspiration_concept_sets`

Fields:

- `id UUID PRIMARY KEY`
- `owner_id UUID NOT NULL`
- `analysis_id UUID NOT NULL`
- `operation_id UUID NOT NULL`
- `direction_index INTEGER NOT NULL`
- `version INTEGER NOT NULL`
- `status ENUM('queued','generating','partial','completed','failed','deleting')`
- `brief_snapshot JSONB NOT NULL`
- `prompt_template_version TEXT NOT NULL`
- `model TEXT NOT NULL`
- `created_at`, `updated_at`, `completed_at`, `deleted_at`

Constraints:

- composite owner/analysis foreign keys preserve tenant ownership;
- unique `(owner_id, operation_id)`;
- unique `(analysis_id, direction_index, version)`;
- direction index must be `0..4` and must be validated against the stored report before insert;
- a partial unique index permits only one `queued` or `generating` set per analysis/direction;
- at most three non-deleted sets per direction is enforced transactionally while locking that direction's rows;
- model and prompt-template version are immutable after insert.

### 8.2 `inspiration_concept_references`

This supporting relation normalizes selected inputs:

- `set_id UUID NOT NULL`
- `visual_asset_id UUID NOT NULL`
- `ordinal INTEGER NOT NULL CHECK ordinal BETWEEN 0 AND 2`
- unique `(set_id, ordinal)` and `(set_id, visual_asset_id)`

Every referenced asset must be a completed `web_evidence` asset from the same owner, analysis, and active research-visual job. `library_match` and generated assets are rejected.

Research-visual completion and concept-set creation use the same transaction-scoped analysis lock. A visual refresh may delete a superseded evidence object only when no non-deleted concept set references that asset. This prevents refresh/create races from leaving queued generation or later derivative retries with a missing reference. Once the final referencing set is deleted, scheduled cleanup may remove the now-unreferenced superseded evidence object.

### 8.3 `inspiration_concept_tasks`

Fields:

- `id UUID PRIMARY KEY`
- `owner_id UUID NOT NULL`
- `set_id UUID NOT NULL`
- `operation_id UUID NOT NULL`
- `output_kind ENUM('sketch','effect','flat')`
- `attempt INTEGER NOT NULL`
- `status ENUM('queued','submitting','submitted','completed','failed')`
- `available_at TIMESTAMPTZ NOT NULL`
- `lease_owner TEXT`, `lease_until TIMESTAMPTZ`
- `provider_task_id TEXT`, `provider_request_id TEXT`
- `error_code TEXT`
- `submit_started_at`, `created_at`, `updated_at`, `completed_at`

Constraints:

- unique `(owner_id, operation_id)`;
- unique `(set_id, output_kind, attempt)`;
- only one non-terminal task per set/output kind;
- provider identifiers are server-only and length bounded;
- terminal state, completion timestamp, and error-code combinations are checked in the database.

`submitting` is explicit. If a worker dies after the provider may have accepted a request but before the task ID is stored, recovery marks the task `INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN` and does not automatically submit another billable request.

### 8.4 `inspiration_concept_outputs`

Fields:

- `id UUID PRIMARY KEY`
- `owner_id UUID NOT NULL`
- `analysis_id UUID NOT NULL`
- `set_id UUID NOT NULL`
- `source_task_id UUID NOT NULL`
- `output_kind ENUM('sketch','effect','flat')`
- `title TEXT NOT NULL`
- `alt_text TEXT NOT NULL`
- `object_key TEXT NOT NULL`
- `content_type TEXT NOT NULL`
- `width INTEGER NOT NULL`
- `height INTEGER NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`

There is one current output per `(set_id, output_kind)`. A retry imports a new object first and then atomically swaps the current row. Object keys are server-only.

Private objects use the deterministic scope:

```text
users/{ownerId}/inspiration/{analysisId}/concept-sets/{setId}/{outputKind}/{outputId}.png
```

## 9. Worker Architecture

The release adds a Node.js process managed by `melon-inspiration-concept-worker.service`. It uses the same release directory and server-only environment boundary as the web process but has no listening port.

The worker loop:

1. updates a low-frequency heartbeat;
2. claims one due task with `FOR UPDATE SKIP LOCKED` and a bounded lease;
3. commits the lease before provider or OSS I/O;
4. advances exactly one state transition;
5. releases or renews the lease and schedules the next poll with bounded exponential backoff;
6. sleeps briefly when no due task exists.

Initial local concurrency is one. Provider submissions are rate-limited below the configured workspace allowance. `429` and service-unavailable responses use jittered backoff. The worker handles `SIGTERM`, stops claiming new work, and lets the current bounded step finish before systemd's stop timeout.

Task advancement rules:

- `queued`: validate dependencies, set `submitting`, then create the provider task;
- `submitting`: persist the returned provider identifiers and become `submitted`;
- `submitted`: query the provider; pending states schedule another poll;
- provider success: fetch the temporary result through the safe importer, validate it, store it in private OSS, and atomically publish the output;
- sketch publication: enqueue the missing effect and flat tasks in the same transaction;
- terminal provider rejection: store a stable public error code;
- lease expiry in a safe state: another worker resumes the task;
- lease expiry during ambiguous submission: fail without automatic resubmission.

No full prompt, API key, Base64 input, provider response body, temporary image URL, or OSS object key is written to ordinary logs.

## 10. Provider and Image Safety

The provider adapter is server-only and allows `qwen-image-3.0-pro` for this release. The model, workspace ID, API key, native base URL, and region must belong to the same DashScope workspace.

Selected references are loaded from Melon's private object store. Before provider submission they are decoded, orientation-normalized, bounded to the provider's supported dimensions, and encoded under the input-size limit. Arbitrary user URLs are never accepted.

Provider result URLs are temporary capabilities. They are never returned to the browser or stored as report data. The importer:

- permits only the expected HTTPS result-host policy;
- resolves and validates remote addresses;
- disallows credentials and fragments;
- applies redirect, timeout, byte, and pixel limits;
- sniffs the actual file signature rather than trusting headers;
- accepts only PNG, JPEG, or WebP input;
- normalizes the durable result to PNG;
- imports the result before marking the task completed.

Database publication occurs only after OSS storage succeeds. If the database transaction loses a race or fails, the worker deletes the just-written object. A periodic cleanup command handles rare orphan objects left by process or network failure.

## 11. API Contracts

All management endpoints require an authenticated session and derive `ownerId` from it.

### 11.1 Create a set

`POST /api/inspiration-analyses/[analysisId]/concept-sets`

```json
{
  "operationId": "00000000-0000-4000-8000-000000000000",
  "directionIndex": 0,
  "visualJobId": "00000000-0000-4000-8000-000000000000",
  "referenceAssetIds": []
}
```

`visualJobId` is nullable only when the reference list is empty. The server validates a completed owned report, the direction, active visual version, reference ownership, active-set limit, and version limit before creating the set and sketch task in one transaction.

Replaying the same operation ID returns the original set. Reusing it with different input returns `OPERATION_ID_REUSED`.

### 11.2 Read sets

`GET /api/inspiration-analyses/[analysisId]/concept-sets`

Returns at most three sets per direction with public task state and current output resource paths. It never returns the brief snapshot, prompt, provider identifiers, reference object keys, or internal error details.

The existing report query may embed the same bounded DTO to avoid a second render-blocking request. TanStack Query continues polling only while any visible set has active tasks; the worker does not depend on this polling.

### 11.3 Retry a derivative

`POST /api/inspiration-analyses/[analysisId]/concept-sets/[setId]/outputs/[outputKind]/retry`

```json
{ "operationId": "00000000-0000-4000-8000-000000000000" }
```

Only `effect` and `flat` are accepted. The current output remains readable during retry. A pending retry for the same kind returns busy rather than creating another paid task.

### 11.4 Regenerate from a new sketch

`POST /api/inspiration-analyses/[analysisId]/concept-sets/[setId]/regenerate`

Creates a new version using the same direction and currently selected references. It follows the same idempotency and three-version rules as normal creation.

### 11.5 Delete and download

- `DELETE /api/inspiration-analyses/[analysisId]/concept-sets/[setId]`
- `GET /api/inspiration-concept-assets/[assetId]`
- `GET /api/inspiration-concept-assets/[assetId]/download`

Delete is idempotent and soft-deletes the set before asynchronous object cleanup. Asset reads require current ownership. Downloads use a server-controlled filename and `Content-Disposition: attachment`.

The existing shared resource route may stream a completed concept output only when its set belongs to the shared analysis and is not deleted.

## 12. Public DTO and State Semantics

The report-facing set status is derived consistently:

- `queued`: sketch has not been submitted;
- `generating`: at least one current task is active;
- `completed`: all three current outputs exist and no replacement is active;
- `partial`: the sketch exists, all tasks are terminal, and one or both derivatives are missing;
- `failed`: no usable sketch exists and the sketch task is terminal;
- deleted sets are omitted.

Each output slot exposes only:

- output kind;
- current task state and stable error code;
- completed asset ID, title, alt text, local image URL, dimensions, and creation time;
- whether a replacement is in progress.

Stable error codes include:

- `INSPIRATION_CONCEPT_DISABLED`
- `INSPIRATION_CONCEPT_BUSY`
- `INSPIRATION_CONCEPT_LIMIT_REACHED`
- `INSPIRATION_CONCEPT_REFERENCES_STALE`
- `INSPIRATION_CONCEPT_REFERENCE_INVALID`
- `INSPIRATION_CONCEPT_REJECTED`
- `INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN`
- `INSPIRATION_CONCEPT_TIMEOUT`
- `INSPIRATION_CONCEPT_IMPORT_FAILED`
- `INSPIRATION_CONCEPT_UNAVAILABLE`

Provider messages and raw failure details remain server-only.

## 13. Configuration and Cost Controls

Server configuration adds or finalizes:

- `INSPIRATION_CONCEPT_IMAGES_ENABLED=false`
- `INSPIRATION_IMAGE_MODEL=qwen-image-3.0-pro`
- `INSPIRATION_CONCEPT_WORKER_ID`
- bounded worker lease, poll, and shutdown settings where operationally necessary

Output sizes and maximum references are product constants, not arbitrary environment input.

At current Beijing list prices, the maximum-reference estimate for one full set is:

- nine image inputs across three calls at `0.02 CNY` each: `0.18 CNY`;
- three 2K Pro outputs at `0.50 CNY` each: `1.50 CNY`;
- estimated total: `1.68 CNY`, excluding retries and provider promotions.

This estimate is informational and must not be treated as a billing guarantee. The production runbook links to the provider pricing page and requires checking the actual workspace region and account price before launch.

Cost controls:

- one active set per direction;
- three retained sets per direction;
- one current task per output kind;
- operation-ID idempotency;
- no automatic subjective-quality regeneration;
- conservative worker concurrency and provider backoff;
- explicit user action for every paid retry.

## 14. Security and Privacy

- Every create, retry, delete, read, and download path enforces owner scope on the server.
- Cross-owner report, set, task, reference, and output identifiers return the same not-found response as nonexistent records.
- Only completed reports can create concept sets.
- Only active, imported external evidence from the same report can be used as references.
- Private library assets cannot enter the concept pipeline.
- API keys, provider task IDs, prompts, brief snapshots, Base64 inputs, temporary URLs, and object keys never enter client DTOs.
- Private OSS remains the durable source of generated bytes.
- Shared pages expose only completed local asset routes and never private generation state.
- Generated images remain clearly labeled as AI output.
- Normal application CSRF, same-site session, content-security, and response-hardening policies apply to all new routes.

## 15. Observability and Operations

Structured, redacted worker events record:

- set ID, task ID, output kind, attempt, and state transition;
- queue wait time and stage duration;
- provider status class and stable internal error category;
- import duration and validated byte/dimension counts;
- lease recovery and ambiguous-submission count.

Operational checks report:

- worker heartbeat age;
- queued, submitting, submitted, failed, and oldest-task counts;
- sets completed and partial over a bounded period;
- provider rejection, timeout, rate-limit, and import-failure rates.

The main web readiness probe does not depend on the worker. A stopped worker prevents new results from advancing but must not take the library, text research, or existing reports offline.

## 16. Testing Strategy

### 16.1 Unit tests

- strict create, retry, delete, and DTO contracts;
- brief construction and deterministic truncation;
- reference ranking and stale-version validation;
- three stage-specific prompts and negative constraints;
- provider create/query protocol fixtures;
- response size, malformed JSON, timeout, rejection, and redaction behavior;
- image preprocessing, signature validation, pixel/byte bounds, and object-key scope.

### 16.2 Database integration tests

- owner isolation and composite foreign keys;
- operation-ID replay and conflicting reuse;
- active-set and three-version limits under concurrency;
- task claiming with `SKIP LOCKED`;
- lease expiry and safe recovery;
- ambiguous submission is never automatically resubmitted;
- sketch completion creates exactly two derivative tasks;
- concurrent publication has one winner and cleans the losing object;
- partial, completed, failed, retrying, replacement, and deletion transitions;
- report deletion and private-object cleanup boundaries.

### 16.3 Route and UI tests

- authentication and same-owner authorization;
- create, read, retry, regenerate, delete, preview, download, and share contracts;
- reference panel default selection and user deselection;
- stable three-slot layout and progress states;
- completed output remains visible during derivative retry;
- local failure does not hide sibling outputs;
- page reload restores state from the server;
- public share is read-only and displays only completed assets.

### 16.4 Browser and real-provider verification

Playwright verifies the private and shared flows at a 14-inch MacBook-class viewport and a larger desktop viewport, including non-overlap, stable aspect ratios, keyboard access, dialogs, and long Chinese labels.

Offline tests use a fake provider and fake object store. A separately gated real smoke test creates at most one full three-image set, verifies all durable resources, restarts the worker between stages, and records only redacted evidence.

## 17. Deployment and Rollback

Rollout order:

1. keep `INSPIRATION_CONCEPT_IMAGES_ENABLED=false`;
2. back up the production database and verify restore prerequisites;
3. apply additive schema migrations;
4. deploy the web release and concept worker unit;
5. run production configuration checks with secrets redacted;
6. start the worker with generation disabled and verify heartbeat/empty queue behavior;
7. enable the flag only for the controlled internal smoke path;
8. generate one full set with an internal account;
9. verify private preview, download, share projection, restart recovery, OSS persistence, logs, and provider billing;
10. enable the normal UI only after the smoke gates pass.

Rollback:

- set `INSPIRATION_CONCEPT_IMAGES_ENABLED=false` to stop new paid work;
- let already submitted tasks finish and import, or explicitly stop the worker after recording their state;
- roll back the web release if needed;
- keep additive tables and durable objects in place;
- preserve existing generated outputs as readable/downloadable;
- never run a destructive schema downgrade during an incident.

## 18. Acceptance Criteria

The feature is complete when:

- a user can choose any completed report direction and confirm zero to three proposed external references;
- one command creates a durable set and returns immediately;
- generation continues after the browser closes and after a worker restart;
- the sketch completes before derivative submission;
- effect and flat outputs visibly preserve the same garment design as the sketch in the controlled smoke;
- each output has the specified presentation and aspect ratio;
- a derivative can fail or retry without hiding completed siblings;
- a new sketch creates a separate version;
- no direction can exceed one active or three retained sets;
- no private library image participates in generation;
- no credential, provider identifier, raw prompt, temporary URL, or object key appears in browser responses or ordinary logs;
- shared reports show only completed AI-labeled outputs;
- the feature can be disabled without affecting text research, existing reports, the material library, or previously generated images;
- all focused unit, integration, route, UI, Playwright, production-readiness, and controlled real-smoke gates pass.

## 19. Primary References

- Qwen Image generation and editing API: <https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference>
- Alibaba Cloud Model Studio image-model guidance: <https://help.aliyun.com/zh/model-studio/image-model/>
- Alibaba Cloud Model Studio pricing: <https://help.aliyun.com/zh/model-studio/model-pricing>
- Next.js 16.4.1 Route Handlers guide: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- Next.js 16.4.1 backend-for-frontend guide: `node_modules/next/dist/docs/01-app/02-guides/backend-for-frontend.md`
