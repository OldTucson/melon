"use client";

import { create } from "zustand";

import type { UploadCheckpointRow } from "./upload-db";
import {
  canRecoverUploadCompletion,
  type UploadTask,
} from "./upload-runner";

export type ManagedUploadTask = UploadTask & {
  file?: File;
  needsReselect?: boolean;
  recoveryPending?: boolean;
  cancellationPending?: boolean;
  cancellationFailed?: boolean;
  runPending?: boolean;
  discardLocalOnly?: boolean;
};

type UploadStore = {
  tasks: ManagedUploadTask[];
  add(task: ManagedUploadTask): void;
  restore(rows: UploadCheckpointRow[]): void;
  update(localTaskId: string, patch: Partial<ManagedUploadTask>): void;
  remove(localTaskId: string): void;
};

export const useUploadStore = create<UploadStore>((set) => ({
  tasks: [],
  add: (task) =>
    set((state) =>
      state.tasks.some((entry) => entry.localTaskId === task.localTaskId)
        ? state
        : { tasks: [...state.tasks, task] },
    ),
  restore: (rows) =>
    set((state) => {
      const known = new Set(state.tasks.map((task) => task.localTaskId));
      const recovered: ManagedUploadTask[] = rows
        .filter((row) => !known.has(row.localTaskId))
        .map((row) => {
          const canRecoverCompletion = canRecoverUploadCompletion(row);
          return {
            localTaskId: row.localTaskId,
            patternId: row.patternId,
            sourceAssetId: row.sourceAssetId,
            previewAssetId: row.previewAssetId,
            thumbnailAssetId: row.thumbnailAssetId,
            operationId: row.operationId,
            filename: row.filename,
            extension: row.extension as ManagedUploadTask["extension"],
            size: row.size,
            lastModified: row.lastModified,
            contentHash: row.contentHash,
            sessionId: row.sessionId,
            status: canRecoverCompletion ? "processing" : "paused",
            progress: canRecoverCompletion ? 99 : 0,
            completionStartedAt:
              row.completionStartedAt ??
              (canRecoverCompletion ? row.updatedAt : undefined),
            canRecoverCompletion,
            needsReselect: !canRecoverCompletion,
            runPending: false,
          };
        });
      return recovered.length > 0
        ? { tasks: [...state.tasks, ...recovered] }
        : state;
    }),
  update: (localTaskId, patch) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.localTaskId === localTaskId ? { ...task, ...patch } : task,
      ),
    })),
  remove: (localTaskId) =>
    set((state) => ({
      tasks: state.tasks.filter((task) => task.localTaskId !== localTaskId),
    })),
}));
