"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { generatePreview } from "@/features/preview/preview-pipeline";
import { ApiResponseError } from "@/lib/query/client";
import { useQueryOwnerId } from "@/lib/query/provider";

import { alibabaBrowserMultipartClient } from "./oss-browser-client";
import { browserUploadApi } from "./upload-api";
import {
  UploadDatabase,
  deleteCheckpoint,
  listRecoverableUploads,
  loadCheckpoint,
  saveCheckpoint,
} from "./upload-db";
import {
  abandonUpload,
  createUploadTask,
  hashFileInChunks,
  recoverUploadCompletion,
  runUpload,
  type UploadRunnerDependencies,
} from "./upload-runner";
import { useUploadStore, type ManagedUploadTask } from "./upload-store";
import { UPLOAD_ACCEPT } from "./upload-dropzone";
import { UploadTray } from "./upload-tray";
import {
  UploadAttemptRegistry,
  type UploadAttemptToken,
} from "./upload-attempt-registry";

type UploadManagerValue = {
  openFilePicker(): void;
  addFiles(files: File[]): void;
};

const UploadManagerContext = createContext<UploadManagerValue | null>(null);

export function useUploadManager() {
  const context = useContext(UploadManagerContext);
  if (!context) throw new Error("Upload manager context is required");
  return context;
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return "无法添加文件";
  if (error.message === "UPLOAD_FILE_TOO_LARGE") return "单个文件不能超过 200 MB";
  if (error.message === "UPLOAD_EXTENSION_UNSUPPORTED") return "仅支持 PSD、AI、PDF、JPG、PNG 和 Procreate";
  if (error.message === "UPLOAD_FILE_EMPTY") return "不能上传空文件";
  return "无法添加文件";
}

export function UploadManagerProvider({ children }: { children: React.ReactNode }) {
  const ownerId = useQueryOwnerId();
  const queryClient = useQueryClient();
  const tasks = useUploadStore((state) => state.tasks);
  const addTask = useUploadStore((state) => state.add);
  const restoreTasks = useUploadStore((state) => state.restore);
  const updateTask = useUploadStore((state) => state.update);
  const removeTask = useUploadStore((state) => state.remove);
  const pickerRef = useRef<HTMLInputElement>(null);
  const reselectRef = useRef<HTMLInputElement>(null);
  const reselectId = useRef<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const attempts = useRef(new UploadAttemptRegistry());
  const database = useMemo(
    () => (typeof indexedDB === "undefined" ? null : new UploadDatabase()),
    [],
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!database) return;
    let active = true;
    void listRecoverableUploads(database, ownerId).then((rows) => {
      if (active) restoreTasks(rows);
    });
    return () => {
      active = false;
    };
  }, [database, ownerId, restoreTasks]);

  const dependenciesFor = useCallback(
    (
      taskId: string,
      attempt: UploadAttemptToken,
      signal?: AbortSignal,
    ): UploadRunnerDependencies => ({
      ownerId,
      api: browserUploadApi,
      multipart: alibabaBrowserMultipartClient,
      checkpoints: {
        load: (id) =>
          database ? loadCheckpoint(database, id) : Promise.resolve(undefined),
        save: (row) =>
          database ? saveCheckpoint(database, row) : Promise.resolve(),
        delete: (id) =>
          database ? deleteCheckpoint(database, id) : Promise.resolve(),
      },
      generatePreview,
      hashFile: hashFileInChunks,
      onUpdate: (patch) =>
        attempts.current.runIfCurrent(taskId, attempt, () =>
          updateTask(taskId, patch),
        ),
      isCurrent: () => attempts.current.isCurrent(taskId, attempt),
      signal,
    }),
    [database, ownerId, updateTask],
  );

  const start = useCallback(
    async (task: ManagedUploadTask, file: File) => {
      const attempt = attempts.current.begin(task.localTaskId);
      const previous = controllers.current.get(task.localTaskId);
      previous?.abort();
      const controller = new AbortController();
      controllers.current.set(task.localTaskId, controller);
      updateTask(task.localTaskId, {
        file,
        needsReselect: false,
        cancellationFailed: false,
        discardLocalOnly: false,
        runPending: true,
        error: undefined,
      });
      try {
        const result = await runUpload(
          task,
          file,
          dependenciesFor(task.localTaskId, attempt, controller.signal),
        );
        if (
          result.status === "ready" &&
          attempts.current.isCurrent(task.localTaskId, attempt)
        ) {
          await queryClient.invalidateQueries({
            queryKey: ["owner", ownerId, "patterns"],
          });
        }
      } catch {
        // The runner records a user-safe task error.
      } finally {
        attempts.current.runIfCurrent(task.localTaskId, attempt, () =>
          updateTask(task.localTaskId, { runPending: false }),
        );
        attempts.current.finish(task.localTaskId, attempt);
        if (controllers.current.get(task.localTaskId) === controller) {
          controllers.current.delete(task.localTaskId);
        }
      }
    },
    [dependenciesFor, ownerId, queryClient, updateTask],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      setNotice(null);
      for (const file of files) {
        try {
          const task = { ...createUploadTask(file), file };
          addTask(task);
          void attempts.current.track(task.localTaskId, start(task, file));
        } catch (error) {
          setNotice(errorMessage(error));
        }
      }
    },
    [addTask, start],
  );

  const value = useMemo(
    () => ({
      openFilePicker: () => pickerRef.current?.click(),
      addFiles,
    }),
    [addFiles],
  );

  return (
    <UploadManagerContext.Provider value={value}>
      {children}
      <input
        ref={pickerRef}
        className="sr-only"
        aria-label="选择要上传的图案"
        accept={UPLOAD_ACCEPT}
        type="file"
        multiple
        onChange={(event) => {
          addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={reselectRef}
        className="sr-only"
        aria-label="重新选择图案文件"
        accept={UPLOAD_ACCEPT}
        type="file"
        onChange={(event) => {
          const id = reselectId.current;
          const file = event.currentTarget.files?.[0];
          const task = useUploadStore
            .getState()
            .tasks.find((entry) => entry.localTaskId === id);
          if (id && task && file) {
            void attempts.current.track(id, start(task, file));
          }
          event.currentTarget.value = "";
          reselectId.current = null;
        }}
      />
      {notice ? (
        <div className="upload-notice" role="alert">
          {notice}
        </div>
      ) : null}
      <UploadTray
        tasks={tasks}
        onPause={(id) => controllers.current.get(id)?.abort()}
        onRecover={(id) => {
          const task = useUploadStore
            .getState()
            .tasks.find((entry) => entry.localTaskId === id);
          if (!task || task.recoveryPending || task.cancellationPending) return;
          const previous = controllers.current.get(id);
          const previousRun = attempts.current.runningTask(id);
          previous?.abort();
          updateTask(id, {
            recoveryPending: true,
            cancellationPending: false,
            cancellationFailed: false,
            discardLocalOnly: false,
            runPending: false,
            error: undefined,
          });
          const recovery = (async () => {
            await previousRun;
            const latestTask = useUploadStore
              .getState()
              .tasks.find((entry) => entry.localTaskId === id);
            if (!latestTask) return;
            if (latestTask.status === "ready") {
              updateTask(id, { recoveryPending: false });
              return;
            }
            const attempt = attempts.current.begin(id);
            const controller = new AbortController();
            controllers.current.set(id, controller);
            try {
              await recoverUploadCompletion(
                latestTask,
                dependenciesFor(id, attempt, controller.signal),
              );
              if (!attempts.current.isCurrent(id, attempt)) return;
              await queryClient.invalidateQueries({
                queryKey: ["owner", ownerId, "patterns"],
              });
            } catch {
              // The runner records a user-safe task error.
            } finally {
              attempts.current.runIfCurrent(id, attempt, () =>
                updateTask(id, { recoveryPending: false }),
              );
              attempts.current.finish(id, attempt);
              if (controllers.current.get(id) === controller) {
                controllers.current.delete(id);
              }
            }
          })();
          void attempts.current.track(id, recovery);
        }}
        onRetry={(id) => {
          const task = useUploadStore
            .getState()
            .tasks.find((entry) => entry.localTaskId === id);
          if (!task) return;
          if (task.completionRecoveryTerminal) return;
          if (task.file) {
            void attempts.current.track(id, start(task, task.file));
          } else updateTask(id, { needsReselect: true });
        }}
        onReselect={(id) => {
          reselectId.current = id;
          reselectRef.current?.click();
        }}
        onAbandon={(id) => {
          const task = useUploadStore
            .getState()
            .tasks.find((entry) => entry.localTaskId === id);
          if (!task || task.recoveryPending || task.cancellationPending) return;
          const previous = controllers.current.get(id);
          const previousRun = attempts.current.runningTask(id);
          previous?.abort();
          if (controllers.current.get(id) === previous) {
            controllers.current.delete(id);
          }
          updateTask(id, {
            cancellationPending: true,
            recoveryPending: false,
            cancellationFailed: false,
            runPending: false,
            error: undefined,
          });
          if (task.completionRecoveryTerminal || task.discardLocalOnly) {
            const attempt = attempts.current.begin(id);
            const discard = (async () => {
              try {
                await previousRun;
                if (!attempts.current.isCurrent(id, attempt)) return;
                if (database) await deleteCheckpoint(database, id);
                if (attempts.current.isCurrent(id, attempt)) removeTask(id);
              } catch {
                attempts.current.runIfCurrent(id, attempt, () =>
                  updateTask(id, {
                    status: "failed",
                    cancellationPending: false,
                    cancellationFailed: true,
                    discardLocalOnly: true,
                    error: "本地记录无法清除，请重试",
                  }),
                );
              } finally {
                attempts.current.finish(id, attempt);
              }
            })();
            void attempts.current.track(id, discard);
            return;
          }
          const cancellation = (async () => {
            await previousRun;
            const latestTask = useUploadStore
              .getState()
              .tasks.find((entry) => entry.localTaskId === id);
            if (!latestTask) return;
            if (latestTask.status === "ready") {
              updateTask(id, { cancellationPending: false });
              return;
            }
            const attempt = attempts.current.begin(id);
            try {
              await abandonUpload(latestTask, dependenciesFor(id, attempt));
              if (attempts.current.isCurrent(id, attempt)) removeTask(id);
            } catch (error) {
              if (
                error instanceof ApiResponseError &&
                error.code === "UPLOAD_CANNOT_CANCEL_COMPLETED"
              ) {
                try {
                  if (database) await deleteCheckpoint(database, id);
                  attempts.current.runIfCurrent(id, attempt, () =>
                    updateTask(id, {
                      status: "ready",
                      progress: 100,
                      canRecoverCompletion: false,
                      cancellationPending: false,
                      cancellationFailed: false,
                      discardLocalOnly: false,
                      error: undefined,
                    }),
                  );
                  await queryClient.invalidateQueries({
                    queryKey: ["owner", ownerId, "patterns"],
                  });
                } catch {
                  attempts.current.runIfCurrent(id, attempt, () =>
                    updateTask(id, {
                      status: "failed",
                      cancellationPending: false,
                      cancellationFailed: true,
                      error: "放弃未确认，请重试放弃",
                    }),
                  );
                }
              } else if (
                error instanceof ApiResponseError &&
                error.status >= 400 &&
                error.status < 500 &&
                error.status !== 408 &&
                error.status !== 429
              ) {
                attempts.current.runIfCurrent(id, attempt, () =>
                  updateTask(id, {
                    status: "failed",
                    cancellationPending: false,
                    cancellationFailed: true,
                    discardLocalOnly: true,
                    error: "上传已无法继续，请清除本地记录",
                  }),
                );
              } else {
                attempts.current.runIfCurrent(id, attempt, () =>
                  updateTask(id, {
                    status: "failed",
                    cancellationPending: false,
                    cancellationFailed: true,
                    discardLocalOnly: false,
                    error: "放弃未确认，请重试放弃",
                  }),
                );
              }
            } finally {
              attempts.current.finish(id, attempt);
            }
          })();
          void attempts.current.track(id, cancellation);
        }}
      />
    </UploadManagerContext.Provider>
  );
}
