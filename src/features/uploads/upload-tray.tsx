"use client";

import { Pause, RefreshCw, Trash2, UploadCloud } from "lucide-react";

import type { UploadTaskStatus } from "./upload-runner";

export type UploadTrayTask = {
  localTaskId: string;
  filename: string;
  status: UploadTaskStatus;
  progress: number;
  error?: string;
  needsReselect?: boolean;
};

const statusLabels: Record<UploadTaskStatus, string> = {
  draft: "等待上传",
  hashing: "正在校验",
  uploading: "正在上传",
  processing: "正在处理",
  ready: "上传完成",
  failed: "上传失败",
  paused: "已暂停",
};

export function UploadTray({
  tasks,
  onPause,
  onRetry,
  onReselect,
  onAbandon,
}: {
  tasks: UploadTrayTask[];
  onPause: (id: string) => void;
  onRetry: (id: string) => void;
  onReselect: (id: string) => void;
  onAbandon: (id: string) => void;
}) {
  if (tasks.length === 0) return null;

  return (
    <aside className="upload-tray" aria-label="上传队列">
      <header>
        <UploadCloud aria-hidden="true" />
        <strong>上传</strong>
        <span>{tasks.length} 个文件</span>
      </header>
      <div className="upload-tray-list">
        {tasks.map((task) => {
          const active = ["hashing", "uploading"].includes(task.status);
          return (
            <div className="upload-tray-row" key={task.localTaskId}>
              <div className="upload-tray-copy">
                <strong title={task.filename}>{task.filename}</strong>
                <span>{task.error ?? statusLabels[task.status]}</span>
              </div>
              <div className="upload-progress" aria-label={`${task.filename} 上传进度`}>
                <span style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
              </div>
              <output>{Math.round(task.progress)}%</output>
              <div className="upload-tray-actions">
                {active ? (
                  <button
                    type="button"
                    aria-label={`暂停 ${task.filename}`}
                    title="暂停"
                    onClick={() => onPause(task.localTaskId)}
                  >
                    <Pause aria-hidden="true" />
                  </button>
                ) : null}
                {task.needsReselect ? (
                  <button
                    type="button"
                    aria-label={`重新选择 ${task.filename}`}
                    onClick={() => onReselect(task.localTaskId)}
                  >
                    重新选择
                  </button>
                ) : task.status === "failed" || task.status === "paused" ? (
                  <button
                    type="button"
                    aria-label={`重试 ${task.filename}`}
                    title="重试"
                    onClick={() => onRetry(task.localTaskId)}
                  >
                    <RefreshCw aria-hidden="true" />
                  </button>
                ) : null}
                {task.status !== "ready" ? (
                  <button
                    type="button"
                    aria-label={`放弃 ${task.filename}`}
                    title="放弃上传"
                    onClick={() => onAbandon(task.localTaskId)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
