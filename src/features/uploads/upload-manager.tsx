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

import { generateRasterPreview } from "@/features/preview/raster-preview";
import { useSelectionStore } from "@/features/library/selection-store";
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
  if (error.message === "UPLOAD_EXTENSION_UNSUPPORTED") return "仅支持 PSD、AI、JPG、PNG 和 Procreate";
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
      generatePreview: generateRasterPreview,
      hashFile: hashFileInChunks,
      onUpdate: (patch) => updateTask(taskId, patch),
      signal,
    }),
    [database, ownerId, updateTask],
  );

  const start = useCallback(
    async (task: ManagedUploadTask, file: File) => {
      const previous = controllers.current.get(task.localTaskId);
      previous?.abort();
      const controller = new AbortController();
      controllers.current.set(task.localTaskId, controller);
      updateTask(task.localTaskId, {
        file,
        needsReselect: false,
        error: undefined,
      });
      try {
        const result = await runUpload(
          task,
          file,
          dependenciesFor(task.localTaskId, controller.signal),
        );
        if (result.status === "ready") {
          await queryClient.invalidateQueries({
            queryKey: ["owner", ownerId, "patterns"],
          });
          useSelectionStore.getState().select(result.patternId, [result.patternId], {});
        }
      } catch {
        // The runner records a user-safe task error.
      } finally {
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
          void start(task, file);
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
          if (task && file) void start(task, file);
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
          if (!task || task.recoveryPending) return;
          updateTask(id, { recoveryPending: true, error: undefined });
          void recoverUploadCompletion(task, dependenciesFor(id))
            .then(async (result) => {
              await queryClient.invalidateQueries({
                queryKey: ["owner", ownerId, "patterns"],
              });
              useSelectionStore
                .getState()
                .select(result.patternId, [result.patternId], {});
            })
            .catch(() => undefined)
            .finally(() => updateTask(id, { recoveryPending: false }));
        }}
        onRetry={(id) => {
          const task = useUploadStore
            .getState()
            .tasks.find((entry) => entry.localTaskId === id);
          if (!task) return;
          if (task.file) void start(task, task.file);
          else updateTask(id, { needsReselect: true });
        }}
        onReselect={(id) => {
          reselectId.current = id;
          reselectRef.current?.click();
        }}
        onAbandon={(id) => {
          const task = useUploadStore
            .getState()
            .tasks.find((entry) => entry.localTaskId === id);
          if (!task) return;
          controllers.current.get(id)?.abort();
          void abandonUpload(task, dependenciesFor(id))
            .catch(() => undefined)
            .finally(() => removeTask(id));
        }}
      />
    </UploadManagerContext.Provider>
  );
}
