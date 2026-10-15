# Upload Processing Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading selection error for processing patterns with accurate status feedback, add low-cost targeted status refresh, and make upload completion safely recoverable without re-uploading files.

**Architecture:** Keep the existing server completion endpoint and its idempotency contract. Persist the exact completion payload in the existing Dexie checkpoint before calling the endpoint, expose a completion-only recovery path, and use a single-pattern React Query only while one transient pattern is selected. Selection UI consumes a small shared status classifier so transient state and missing selection cannot be conflated again.

**Tech Stack:** Next.js 16, React 19, TypeScript, TanStack Query 5, Zustand, Dexie, Vitest, Testing Library

---

### Task 1: Separate transient upload state from stale selection state

**Status:** Complete

**Files:**
- Create: `src/features/library/selection-availability.ts`
- Create: `src/features/library/selection-availability.test.ts`
- Modify: `src/features/library/bulk-action-bar.tsx:79-90,244-250`
- Modify: `src/features/library/inspector.tsx:300-355`
- Modify: `src/features/library/library-view.test.tsx:310-332`

- [ ] **Step 1: Write the failing status-classification test**

```ts
import { describe, expect, it } from "vitest";
import { selectionAvailability } from "./selection-availability";

describe("selection availability", () => {
  it("distinguishes a missing selection from a transient upload", () => {
    expect(selectionAvailability(["one"], [])).toBe("missing");
    expect(selectionAvailability(["one"], [{ id: "one", status: "processing" }])).toBe("transient");
    expect(selectionAvailability(["one"], [{ id: "one", status: "ready" }])).toBe("editable");
    expect(selectionAvailability(["one"], [{ id: "one", status: "failed" }])).toBe("editable");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- src/features/library/selection-availability.test.ts`

Expected: FAIL because `selection-availability.ts` does not exist.

- [ ] **Step 3: Implement the shared classifier**

```ts
type SelectablePattern = { id: string; status: string };

const editableStatuses = new Set(["ready", "failed"]);

export function selectionAvailability(
  selectedIds: readonly string[],
  patterns: readonly SelectablePattern[],
) {
  if (patterns.length !== selectedIds.length) return "missing" as const;
  if (patterns.some((pattern) => !editableStatuses.has(pattern.status))) {
    return "transient" as const;
  }
  return "editable" as const;
}
```

- [ ] **Step 4: Use the classifier in both action surfaces**

Replace the shared boolean meaning with an explicit reason:

```ts
const availability = selectionAvailability(selectedIds, selected);
const disabled = mutation.isPending || tooMany || availability !== "editable";
```

Render distinct messages:

```tsx
{availability === "missing" ? (
  <span className="bulk-inline-error" role="alert">
    选择内容已变化，请重新选择
  </span>
) : availability === "transient" ? (
  <span className="bulk-inline-status" role="status">
    图案正在完成上传
  </span>
) : null}
```

For `SelectionActions`, derive availability from `patterns.map(({ id }) => id)` so the same transient wording is shown while actions remain disabled.

- [ ] **Step 5: Update the library regression assertion and run focused tests**

Change the existing processing assertion to:

```ts
expect(inspector.getByText("图案正在完成上传")).toBeInTheDocument();
expect(inspector.queryByText(/选择.*变化/)).not.toBeInTheDocument();
```

Run: `npm test -- src/features/library/selection-availability.test.ts src/features/library/library-view.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/library/selection-availability.ts src/features/library/selection-availability.test.ts src/features/library/bulk-action-bar.tsx src/features/library/inspector.tsx src/features/library/library-view.test.tsx
git commit -m "fix: distinguish processing selections"
```

### Task 2: Add targeted adaptive status refresh

**Status:** Complete

**Files:**
- Create: `src/features/library/pattern-status-watch.ts`
- Create: `src/features/library/pattern-status-watch.test.ts`
- Modify: `src/features/library/library-view.tsx:35-160,260-325`
- Modify: `src/features/library/inspector.tsx:30-80,300-360`
- Modify: `src/features/library/library-view.test.tsx`

- [ ] **Step 1: Write failing interval-policy tests**

```ts
import { describe, expect, it } from "vitest";
import { patternStatusRefreshInterval } from "./pattern-status-watch";

describe("pattern status refresh interval", () => {
  it("uses 5 seconds for a recent transient state and 15 seconds afterward", () => {
    const now = Date.parse("2026-10-15T00:00:30.000Z");
    expect(patternStatusRefreshInterval("processing", "2026-10-15T00:00:10.000Z", now)).toBe(5_000);
    expect(patternStatusRefreshInterval("processing", "2026-10-14T23:59:00.000Z", now)).toBe(15_000);
  });

  it("stops for terminal states", () => {
    expect(patternStatusRefreshInterval("ready", "2026-10-15T00:00:00.000Z", Date.now())).toBe(false);
    expect(patternStatusRefreshInterval("failed", "2026-10-15T00:00:00.000Z", Date.now())).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- src/features/library/pattern-status-watch.test.ts`

Expected: FAIL because the interval policy does not exist.

- [ ] **Step 3: Implement the pure interval policy**

```ts
export const transientPatternStatuses = new Set([
  "draft",
  "hashing",
  "uploading",
  "processing",
]);

export function patternStatusRefreshInterval(
  status: string | undefined,
  updatedAt: string | undefined,
  now = Date.now(),
) {
  if (!status || !transientPatternStatuses.has(status)) return false;
  const changedAt = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(changedAt) && now - changedAt < 30_000
    ? 5_000
    : 15_000;
}
```

- [ ] **Step 4: Generalize the detail query to the selected transient pattern**

In `LibraryView`, calculate `items` before the detail query, choose the watch ID from either the deep link or the sole selected transient item, and configure:

```ts
const selectedPatternQuery = useQuery({
  queryKey: queryKeys.pattern(ownerId, watchedPatternId ?? "none"),
  queryFn: () => fetchPattern(watchedPatternId!),
  enabled: Boolean(watchedPatternId),
  retry: 2,
  refetchInterval: (query) =>
    patternStatusRefreshInterval(
      query.state.data?.status,
      query.state.data?.updatedAt,
    ),
  refetchIntervalInBackground: false,
});
```

Merge returned detail into the displayed list and `patternsById`. The terminal response must replace the processing card immediately. Do not add a list-level interval.

- [ ] **Step 5: Pass manual refresh state to the inspector**

Add a focused status object:

```ts
type PatternStatusCheck = {
  isError: boolean;
  isFetching: boolean;
  refetch(): void;
};
```

When the selected pattern remains transient, show either “图案正在完成上传” or “状态暂时无法更新” and an icon/text button named “重新检查”. The button calls only `selectedPatternQuery.refetch()`.

- [ ] **Step 6: Test one-item polling and terminal stop with fake timers**

Stub `fetch` so `/api/patterns/:id` returns `processing` once and `ready` next. Select that card, advance 5 seconds, and assert:

```ts
expect(fetchMock).toHaveBeenCalledTimes(2);
expect(screen.queryByText("图案正在完成上传")).not.toBeInTheDocument();
expect(screen.getByRole("textbox", { name: "图案名称" })).toBeEnabled();
```

Also assert no `/api/patterns?` list polling occurs, `onlineManager.setOnline(false)` prevents the scheduled request until it is restored in test cleanup, and a hidden document does not issue interval requests while `refetchIntervalInBackground` is false.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- src/features/library/pattern-status-watch.test.ts src/features/library/library-view.test.tsx`

Expected: PASS.

```bash
git add src/features/library/pattern-status-watch.ts src/features/library/pattern-status-watch.test.ts src/features/library/library-view.tsx src/features/library/inspector.tsx src/features/library/library-view.test.tsx
git commit -m "feat: refresh selected processing pattern"
```

### Task 3: Persist and replay the exact completion request

**Status:** Complete

**Files:**
- Modify: `src/features/uploads/upload-db.ts:3-23,75-86`
- Modify: `src/features/uploads/upload-db.test.ts:15-69`
- Modify: `src/features/uploads/upload-runner.ts:18-43,202-457`
- Modify: `src/features/uploads/upload-runner.test.ts:23-220`

- [ ] **Step 1: Write failing checkpoint assertions**

Add `completionAssets` and `completionStartedAt` to the fixture, then assert the round trip preserves them while the serialized record still contains no credential or Blob field:

```ts
expect(restored?.completionAssets).toEqual(row().completionAssets);
expect(restored?.completionStartedAt).toBe(700);
```

- [ ] **Step 2: Add a failing completion-only recovery test**

Import `recoverUploadCompletion`, return a checkpoint containing an exact source asset declaration, call recovery, then assert:

```ts
expect(harness.dependencies.api.complete).toHaveBeenCalledWith(checkpoint.sessionId, {
  operationId: task.operationId,
  assets: checkpoint.completionAssets,
});
expect(harness.initialize).not.toHaveBeenCalled();
expect(harness.upload).not.toHaveBeenCalled();
expect(harness.dependencies.hashFile).not.toHaveBeenCalled();
expect(harness.dependencies.checkpoints.delete).toHaveBeenCalledWith(task.localTaskId);
```

- [ ] **Step 3: Run upload tests and verify they fail**

Run: `npm test -- src/features/uploads/upload-db.test.ts src/features/uploads/upload-runner.test.ts`

Expected: FAIL because checkpoint completion metadata and `recoverUploadCompletion` do not exist.

- [ ] **Step 4: Extend the checkpoint and task types**

```ts
import type { UploadCompletionAsset } from "./contracts";

export type UploadCheckpointRow = {
  completionAssets?: UploadCompletionAsset[];
  completionStartedAt?: number;
};
```

Add these two optional members to the existing `UploadCheckpointRow` declaration, and add optional `completionStartedAt` and `canRecoverCompletion` fields to `UploadTask`.

- [ ] **Step 5: Persist completion metadata before the request**

Immediately after all assets are uploaded:

```ts
const completionStartedAt = Date.now();
checkpoint = checkpointRow(task, dependencies.ownerId, contentHash, checkpoint, {
  completionAssets: assets,
  completionStartedAt,
});
await dependencies.checkpoints.save(checkpoint);
dependencies.onUpdate({
  status: "processing",
  progress: 99,
  completionStartedAt,
  canRecoverCompletion: true,
});
```

Only then call `api.complete`.

- [ ] **Step 6: Implement completion-only recovery**

```ts
export async function recoverUploadCompletion(
  task: UploadTask,
  dependencies: UploadRunnerDependencies,
) {
  const checkpoint = await dependencies.checkpoints.load(task.localTaskId);
  if (!checkpoint?.sessionId || !checkpoint.completionAssets) {
    throw new Error("UPLOAD_COMPLETION_NOT_RECOVERABLE");
  }
  dependencies.onUpdate({ status: "processing", error: undefined });
  await dependencies.api.complete(checkpoint.sessionId, {
    operationId: checkpoint.operationId,
    assets: checkpoint.completionAssets,
  });
  await dependencies.checkpoints.delete(task.localTaskId);
  dependencies.onUpdate({ status: "ready", progress: 100 });
  return { status: "ready" as const, patternId: checkpoint.patternId };
}
```

Use a `completionAssetsForCheckpoint` helper that returns `checkpoint.completionAssets` when present. For a legacy checkpoint, it may reconstruct a source-only declaration only when `source` is marked complete and neither preview nor thumbnail object keys exist:

```ts
function completionAssetsForCheckpoint(checkpoint: UploadCheckpointRow) {
  if (checkpoint.completionAssets) return checkpoint.completionAssets;
  if (
    checkpoint.objectKeys.source &&
    checkpoint.sdkCheckpoints.source?.completed === true &&
    !checkpoint.objectKeys.preview &&
    !checkpoint.objectKeys.thumbnail
  ) {
    return [{
      assetId: checkpoint.sourceAssetId,
      role: "source" as const,
      objectKey: checkpoint.objectKeys.source,
      extension: checkpoint.extension as UploadSourceExtension,
      sizeBytes: checkpoint.size,
    }];
  }
  return null;
}
```

Do not reconstruct legacy derived assets because their exact byte sizes and dimensions are unavailable. At the beginning of `runUpload`, if `completionAssetsForCheckpoint` returns a payload and the checkpoint has a session, delegate directly to completion recovery before hashing or initialization.

- [ ] **Step 7: Test legacy checkpoint boundaries**

Add one test showing a source-only legacy checkpoint recovers without initialization, and one showing a legacy checkpoint with a preview key rejects with `UPLOAD_COMPLETION_NOT_RECOVERABLE` instead of guessing a payload.

- [ ] **Step 8: Verify exact-payload replay and run the existing server idempotency test**

Run: `npm test -- src/features/uploads/upload-db.test.ts src/features/uploads/upload-runner.test.ts`

Expected: PASS.

Run: `npm run test:integration -- src/features/uploads/upload-service.integration.test.ts -t "allows the same completion payload"`

Expected: PASS when the integration database is available; otherwise record the environment blocker without changing code.

- [ ] **Step 9: Commit**

```bash
git add src/features/uploads/upload-db.ts src/features/uploads/upload-db.test.ts src/features/uploads/upload-runner.ts src/features/uploads/upload-runner.test.ts
git commit -m "feat: recover upload completion idempotently"
```

### Task 4: Expose safe recovery in the upload queue

**Status:** Complete

**Files:**
- Modify: `src/features/uploads/upload-store.ts:8-50`
- Modify: `src/features/uploads/upload-manager.tsx:27-233`
- Modify: `src/features/uploads/upload-tray.tsx:3-128`
- Modify: `src/features/uploads/upload-ui.test.tsx:11-89`

- [ ] **Step 1: Write failing upload tray tests**

Use fake timers at a fixed system time. Render a recoverable processing task with `completionStartedAt` 31 seconds ago and assert “恢复上传” is enabled. Render one started 29 seconds ago, advance two seconds, and assert the button appears without another task update. Assert a task without `canRecoverCompletion` never shows the action.

- [ ] **Step 2: Run the focused UI test and verify it fails**

Run: `npm test -- src/features/uploads/upload-ui.test.tsx`

Expected: FAIL because the tray has no completion recovery action.

- [ ] **Step 3: Restore recoverable completion tasks accurately**

In `upload-store.ts`, map a checkpoint with `sessionId` and `completionAssets` to:

```ts
status: "processing",
progress: 99,
completionStartedAt: row.completionStartedAt,
canRecoverCompletion: true,
needsReselect: false,
```

Keep legacy checkpoints as paused tasks requiring file reselection.

- [ ] **Step 4: Add the 30-second tray action**

Extend `UploadTrayTask` with `completionStartedAt`, `canRecoverCompletion`, and `recoveryPending`. Schedule one timeout for the nearest remaining threshold so the tray rerenders when the action becomes available. Render a `RefreshCw` button named “恢复上传 <filename>” only when the threshold has passed, and disable it while recovery is pending.

- [ ] **Step 5: Wire manager recovery to the completion-only runner**

Import `recoverUploadCompletion`. The new `recover` callback sets `recoveryPending`, calls the recovery function with `dependenciesFor`, invalidates `['owner', ownerId, 'patterns']` on success, selects the recovered pattern, and always clears `recoveryPending`. Do not require a `File` and do not call `start`.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- src/features/uploads/upload-ui.test.tsx src/features/uploads/upload-runner.test.ts src/features/uploads/upload-db.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/uploads/upload-store.ts src/features/uploads/upload-manager.tsx src/features/uploads/upload-tray.tsx src/features/uploads/upload-ui.test.tsx
git commit -m "feat: add stalled upload recovery action"
```

### Task 5: Full verification and browser regression

**Status:** Complete for automated verification; browser and database-backed checks are blocked by the unavailable local PostgreSQL service.

**Files:**
- Modify only if verification exposes a defect in the files above.

- [x] **Step 1: Run all unit tests**

Run: `npm test`

Expected: all Vitest suites pass.

- [x] **Step 2: Run static checks**

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run lint`

Expected: exit 0.

- [x] **Step 3: Run the production build**

Run: `npm run build`

Expected: Next.js build completes successfully.

- [ ] **Step 4: Verify the browser behavior**

Blocked on 2026-10-15: the local PostgreSQL service at `localhost:55432` is unavailable, Docker is not installed, and browser automation cannot authenticate in the current Codex environment. The targeted UI behavior is covered by Vitest regressions, but this manual step remains unverified.

With the app and database available, select a `processing` card and verify:

- The inspector says “图案正在完成上传”, not “选择已变化”.
- Editing, moving, authorization, favorite, and delete remain disabled.
- “重新检查” requests only `/api/patterns/:id`.
- The Network panel does not show a two-second list poll.
- A terminal response updates the card and restores valid actions.
- A recoverable task older than 30 seconds offers “恢复上传”; using it does not issue upload-init or OSS multipart requests.

- [x] **Step 5: Inspect the final diff and commit any verification fix**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and no unexplained files.
