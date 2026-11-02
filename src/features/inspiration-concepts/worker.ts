import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { InspirationConceptTaskRow } from "@/lib/db/schema/inspiration-concepts";
import type { RemoteImageDependencies } from "@/features/inspiration-visuals/safe-image-fetch";
import type { VisualObjectStore } from "@/features/inspiration-visuals/visual-object-store";
import { parseVisualObjectKey } from "@/features/inspiration-visuals/visual-object-keys";
import type { ConceptErrorCode, ConceptOutputKind } from "./contracts";
import { conceptSetObjectPrefix, parseConceptObjectKey } from "./object-keys";
import type { ConceptObjectStore } from "./object-store";
import { prepareConceptInput } from "./image-input";
import { importConceptOutput } from "./output-importer";
import {
  buildSketchPrompt,
  buildEffectPrompt,
  buildFlatPrompt,
} from "./prompts";
import {
  QwenImageSubmissionError,
  type QwenImageProvider,
} from "./qwen-image-provider";
import * as repository from "./repository";

// Leave room for one non-abortable OSS request (120 seconds) to drain after cancellation.
const LEASE_MS = 5 * 60_000;
const STAGE_MS = 90_000;
const TASK_TIMEOUT_MS = 30 * 60_000;
const HEARTBEAT_MS = 30_000;
export type WorkerEvent = {
  event:
    | "transition"
    | "cleanup_failed"
    | "cleanup_completed"
    | "iteration_failed"
    | "heartbeat_failed";
  setId?: string;
  taskId?: string;
  kind?: ConceptOutputKind;
  attempt?: number;
  from?: string;
  to?: string;
  queueAgeMs?: number;
  stageDurationMs?: number;
  width?: number;
  height?: number;
  errorCode?: ConceptErrorCode;
};
export interface WorkerDependencies {
  workerId: string;
  provider: QwenImageProvider;
  store: ConceptObjectStore;
  researchStore: Pick<VisualObjectStore, "get">;
  now?: () => Date;
  random?: () => number;
  signal?: AbortSignal;
  log?: (event: WorkerEvent) => void;
  remote?: Omit<RemoteImageDependencies, "signal">;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
const idle = { state: "idle" as const };
const advanced = { state: "advanced" as const };
const time = (deps: WorkerDependencies) => (deps.now ?? (() => new Date()))();
function log(deps: WorkerDependencies, event: WorkerEvent) {
  // Logging failure must not turn a committed paid operation into a retry.
  try {
    deps.log?.(event);
  } catch {
    /* Deliberately discard logger errors. */
  }
}
function nextPoll(deps: WorkerDependencies, task: InspirationConceptTaskRow) {
  const now = time(deps);
  const age = Math.max(
    0,
    now.getTime() - (task.submitStartedAt ?? now).getTime(),
  );
  const base = Math.min(25_000, 5_000 + Math.floor(age / 60_000) * 5_000);
  const jitter = Math.min(1, Math.max(0, (deps.random ?? Math.random)()));
  const next = now.getTime() + Math.round(base * (0.8 + jitter * 0.4));
  return new Date(
    task.submitStartedAt
      ? Math.min(next, task.submitStartedAt.getTime() + TASK_TIMEOUT_MS)
      : next,
  );
}
async function deleteSafely(
  deps: WorkerDependencies,
  setId: string,
  keys: string[],
) {
  try {
    await deps.store.delete(keys);
    return true;
  } catch {
    log(deps, { event: "cleanup_failed", setId });
    return false;
  }
}

export async function advanceConceptWorkerOnce(deps: WorkerDependencies) {
  if (deps.signal?.aborted) return idle;
  await repository.failExpiredSubmittingTasks(time(deps));
  const claimTime = time(deps);
  const leaseUntil = new Date(claimTime.getTime() + LEASE_MS);
  const deleting = await repository.claimDeletingSet(
    deps.workerId,
    claimTime,
    leaseUntil,
  );
  if (deleting) {
    try {
      const keys = await deps.store.listObjectKeys(
        conceptSetObjectPrefix({
          ownerId: deleting.ownerId,
          analysisId: deleting.analysisId,
          setId: deleting.id,
        }),
      );
      if (deps.signal?.aborted || time(deps) >= leaseUntil) return advanced;
      if (await deleteSafely(deps, deleting.id, keys)) {
        if (
          await repository.finishDeletingSet({
            workerId: deps.workerId,
            setId: deleting.id,
            now: time(deps),
            leaseUntil,
          })
        )
          log(deps, { event: "cleanup_completed", setId: deleting.id });
      }
    } catch {
      log(deps, { event: "cleanup_failed", setId: deleting.id });
    }
    return advanced;
  }
  if (deps.signal?.aborted) return idle;
  const task = await repository.claimNextTask({
    workerId: deps.workerId,
    now: time(deps),
    leaseUntil,
  });
  if (!task) return idle;
  const started = time(deps);
  const lease = () => ({
    workerId: deps.workerId,
    taskId: task.id,
    leaseUntil,
    now: time(deps),
  });
  const controller = new AbortController();
  const deadline = task.submitStartedAt
    ? task.submitStartedAt.getTime() + TASK_TIMEOUT_MS
    : Infinity;
  const lifetimeExpired = () => time(deps).getTime() >= deadline;
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, Math.min(STAGE_MS, deadline - started.getTime())),
  );
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, controller.signal])
    : controller.signal;
  const event = (
    to: string,
    errorCode?: ConceptErrorCode,
    dimensions?: { width: number; height: number },
  ) =>
    log(deps, {
      event: "transition",
      setId: task.setId,
      taskId: task.id,
      kind: task.outputKind,
      attempt: task.attempt,
      from: task.status,
      to,
      queueAgeMs: Math.max(0, started.getTime() - task.createdAt.getTime()),
      stageDurationMs: Math.max(0, time(deps).getTime() - started.getTime()),
      ...dimensions,
      ...(errorCode ? { errorCode } : {}),
    });
  const fail = async (errorCode: ConceptErrorCode) => {
    if (await repository.failTask({ ...lease(), errorCode }))
      event("failed", errorCode);
  };
  try {
    if (task.status === "queued") {
      const context = await repository.loadWorkerTaskContext(lease());
      if (!context) return advanced;
      let images: string[];
      let prompt: string;
      try {
        const { set, references, sketch } = context;
        if (
          references.length !== set.briefSnapshot.referenceAssetIds.length ||
          references.some(
            (ref, index) =>
              ref.id !== set.briefSnapshot.referenceAssetIds[index],
          )
        )
          throw Error();
        images = [];
        if (task.outputKind !== "sketch") {
          if (!sketch) throw Error();
          const key = parseConceptObjectKey(sketch.objectKey);
          if (
            key.ownerId !== task.ownerId ||
            key.analysisId !== set.analysisId ||
            key.setId !== set.id ||
            key.outputId !== sketch.id ||
            key.outputKind !== "sketch"
          )
            throw Error();
          signal.throwIfAborted();
          images.push(
            await prepareConceptInput(await deps.store.get(sketch.objectKey)),
          );
        }
        for (const reference of references.slice(
          0,
          task.outputKind === "sketch" ? 3 : 2,
        )) {
          if (!reference.objectKey) throw Error();
          const key = parseVisualObjectKey(reference.objectKey);
          if (
            key.ownerId !== task.ownerId ||
            key.analysisId !== set.analysisId ||
            key.jobId !== reference.jobId ||
            key.assetId !== reference.id ||
            reference.kind !== "web_evidence"
          )
            throw Error();
          signal.throwIfAborted();
          images.push(
            await prepareConceptInput(
              await deps.researchStore.get(reference.objectKey),
            ),
          );
        }
        prompt = (
          task.outputKind === "sketch"
            ? buildSketchPrompt
            : task.outputKind === "effect"
              ? buildEffectPrompt
              : buildFlatPrompt
        )(set.briefSnapshot);
        signal.throwIfAborted();
      } catch {
        if (signal.aborted)
          await repository.rescheduleTask({
            ...lease(),
            availableAt: nextPoll(deps, task),
          });
        else await fail("INSPIRATION_CONCEPT_REFERENCE_INVALID");
        return advanced;
      }
      // Persist the non-repeatable state immediately before invoking the paid API.
      if (!(await repository.markTaskSubmitting(lease()))) return advanced;
      let submitted: Awaited<ReturnType<QwenImageProvider["createTask"]>>;
      try {
        submitted = await deps.provider.createTask({
          kind: task.outputKind,
          images,
          prompt,
          signal,
        });
      } catch (error) {
        await fail(
          error instanceof QwenImageSubmissionError &&
            error.definitelyNotAccepted
            ? error.code === "INSPIRATION_CONCEPT_REJECTED"
              ? "INSPIRATION_CONCEPT_REJECTED"
              : "INSPIRATION_CONCEPT_UNAVAILABLE"
            : "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
        );
        return advanced;
      }
      // A DB failure here deliberately leaves submitting for uncertain recovery, never retry create.
      if (
        await repository.markTaskSubmitted({
          ...lease(),
          providerTaskId: submitted.taskId,
          providerRequestId: submitted.requestId,
          availableAt: nextPoll(deps, task),
        })
      )
        event("submitted");
      return advanced;
    }
    if (
      !task.submitStartedAt ||
      time(deps).getTime() - task.submitStartedAt.getTime() >= TASK_TIMEOUT_MS
    ) {
      await fail("INSPIRATION_CONCEPT_TIMEOUT");
      return advanced;
    }
    const context = await repository.loadWorkerTaskContext(lease());
    if (!context) return advanced;
    let result: Awaited<ReturnType<QwenImageProvider["queryTask"]>>;
    try {
      signal.throwIfAborted();
      result = await deps.provider.queryTask({
        taskId: task.providerTaskId!,
        signal,
      });
    } catch {
      if (lifetimeExpired()) {
        await fail("INSPIRATION_CONCEPT_TIMEOUT");
        return advanced;
      }
      if (
        await repository.rescheduleTask({
          ...lease(),
          availableAt: nextPoll(deps, task),
        })
      )
        event("submitted", "INSPIRATION_CONCEPT_UNAVAILABLE");
      return advanced;
    }
    if (
      time(deps).getTime() - task.submitStartedAt.getTime() >=
      TASK_TIMEOUT_MS
    ) {
      await fail("INSPIRATION_CONCEPT_TIMEOUT");
      return advanced;
    }
    if (result.state === "pending") {
      if (
        await repository.rescheduleTask({
          ...lease(),
          availableAt: nextPoll(deps, task),
        })
      )
        event("submitted");
      return advanced;
    }
    if (result.state !== "succeeded") {
      await fail(
        result.state === "rejected"
          ? "INSPIRATION_CONCEPT_REJECTED"
          : "INSPIRATION_CONCEPT_UNAVAILABLE",
      );
      return advanced;
    }
    let imported: Awaited<ReturnType<typeof importConceptOutput>>;
    try {
      imported = await importConceptOutput(
        {
          ownerId: task.ownerId,
          analysisId: context.set.analysisId,
          setId: task.setId,
          outputId: randomUUID(),
          outputKind: task.outputKind,
          temporaryImageUrl: result.temporaryImageUrl,
          title: {
            sketch: "原创设计草图",
            effect: "上身效果图",
            flat: "技术平面款式图",
          }[task.outputKind],
          altText: {
            sketch: "原创服装设计草图",
            effect: "原创服装上身效果展示",
            flat: "原创服装正反面技术款式图",
          }[task.outputKind],
          signal,
        },
        { store: deps.store, remote: deps.remote },
      );
    } catch {
      if (lifetimeExpired()) await fail("INSPIRATION_CONCEPT_TIMEOUT");
      else if (signal.aborted)
        await repository.rescheduleTask({
          ...lease(),
          availableAt: nextPoll(deps, task),
        });
      else await fail("INSPIRATION_CONCEPT_IMPORT_FAILED");
      return advanced;
    }
    if (lifetimeExpired()) {
      await deleteSafely(deps, task.setId, [imported.writtenKey]);
      await fail("INSPIRATION_CONCEPT_TIMEOUT");
      return advanced;
    }
    let published: Awaited<ReturnType<typeof repository.publishTaskOutput>>;
    try {
      published = await repository.publishTaskOutput({
        ...lease(),
        output: imported.asset,
      });
    } catch (error) {
      await deleteSafely(deps, task.setId, [imported.writtenKey]);
      throw error;
    }
    if (!published?.output) {
      await deleteSafely(deps, task.setId, [imported.writtenKey]);
      return advanced;
    }
    event("completed", undefined, {
      width: imported.asset.width,
      height: imported.asset.height,
    });
    if (published.supersededObjectKey)
      await deleteSafely(deps, task.setId, [published.supersededObjectKey]);
    return advanced;
  } finally {
    clearTimeout(timer);
  }
}

/** One local operation at a time; provider jobs remain concurrent between polls. */
export async function runConceptWorker(deps: WorkerDependencies) {
  const signal = deps.signal ?? new AbortController().signal;
  const startedAt = time(deps);
  let lastHeartbeat = -Infinity;
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = () => {
    if (
      signal.aborted ||
      heartbeatInFlight ||
      time(deps).getTime() - lastHeartbeat < HEARTBEAT_MS
    )
      return;
    const now = time(deps);
    lastHeartbeat = now.getTime();
    heartbeatInFlight = repository
      .recordWorkerHeartbeat({ workerId: deps.workerId, startedAt, now })
      .then(
        () => {},
        () => {
          log(deps, { event: "heartbeat_failed" });
        },
      )
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  };
  heartbeat();
  await heartbeatInFlight;
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  const sleep =
    deps.sleep ??
    (async (ms: number, abort: AbortSignal) => {
      await delay(ms, undefined, { signal: abort });
    });
  try {
    while (!signal.aborted) {
      heartbeat();
      let idleIteration = false;
      try {
        idleIteration =
          (await advanceConceptWorkerOnce({ ...deps, signal })).state ===
          "idle";
      } catch {
        log(deps, { event: "iteration_failed" });
        idleIteration = true;
      }
      if (idleIteration && !signal.aborted) {
        try {
          await sleep(1000, signal);
        } catch {
          if (!signal.aborted) throw Error("Concept worker wait failed");
        }
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatInFlight;
  }
}
