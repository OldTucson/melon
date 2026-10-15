"use client";

import { ChevronDown, ChevronUp, Pause, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useEffect, useState } from "react";

import type { UploadTaskStatus } from "./upload-runner";

export type UploadTrayTask = {
  localTaskId: string;
  filename: string;
  status: UploadTaskStatus;
  progress: number;
  error?: string;
  needsReselect?: boolean;
  completionStartedAt?: number;
  canRecoverCompletion?: boolean;
  recoveryPending?: boolean;
  cancellationPending?: boolean;
  cancellationFailed?: boolean;
  discardLocalOnly?: boolean;
  completionRecoveryTerminal?: boolean;
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
  onRecover,
  onRetry,
  onReselect,
  onAbandon,
}: {
  tasks: UploadTrayTask[];
  onPause: (id: string) => void;
  onRecover: (id: string) => void;
  onRetry: (id: string) => void;
  onReselect: (id: string) => void;
  onAbandon: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const currentTime = Date.now();
    let needsImmediateSync = false;
    const nextDeadline = tasks.reduce<number | null>((nearest, task) => {
      if (
        !task.canRecoverCompletion ||
        task.completionStartedAt === undefined ||
        task.status === "ready"
      ) {
        return nearest;
      }
      const deadline = task.completionStartedAt + 30_000;
      if (deadline <= currentTime) {
        if (deadline > now) needsImmediateSync = true;
        return nearest;
      }
      return nearest === null ? deadline : Math.min(nearest, deadline);
    }, null);
    const delay = needsImmediateSync
      ? 0
      : nextDeadline === null
        ? null
        : nextDeadline - currentTime;
    if (delay === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [now, tasks]);
  if (tasks.length === 0) return null;

  return (
    <aside
      className={`upload-tray${collapsed ? " upload-tray-collapsed" : ""}`}
      aria-label="上传队列"
    >
      <header>
        <UploadCloud aria-hidden="true" />
        <strong>上传</strong>
        <span>{tasks.length} 个文件</span>
        <button
          type="button"
          className="upload-tray-toggle"
          aria-label={collapsed ? "展开上传队列" : "收起上传队列"}
          aria-expanded={!collapsed}
          title={collapsed ? "展开上传队列" : "收起上传队列"}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
        </button>
      </header>
      {!collapsed ? (
        <div className="upload-tray-list">
          {tasks.map((task) => {
            const active = ["hashing", "uploading"].includes(task.status);
            const recoveryAvailable = Boolean(
              task.canRecoverCompletion &&
                task.completionStartedAt !== undefined &&
                now - task.completionStartedAt >= 30_000,
            );
            return (
              <div className="upload-tray-row" key={task.localTaskId}>
                <div className="upload-tray-copy">
                  <strong title={task.filename}>{task.filename}</strong>
                  <span>
                    {task.cancellationPending
                      ? "正在放弃"
                      : task.recoveryPending
                      ? "正在恢复"
                      : (task.error ?? statusLabels[task.status])}
                  </span>
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
                  {!task.cancellationFailed && task.canRecoverCompletion ? (
                    recoveryAvailable ? (
                      <button
                        type="button"
                        aria-label={`恢复上传 ${task.filename}`}
                        disabled={
                          task.recoveryPending || task.cancellationPending
                        }
                        title="恢复上传"
                        onClick={() => onRecover(task.localTaskId)}
                      >
                        <RefreshCw aria-hidden="true" />
                      </button>
                    ) : null
                  ) : !task.cancellationFailed && task.needsReselect ? (
                    <button
                      type="button"
                      aria-label={`重新选择 ${task.filename}`}
                      disabled={
                        task.recoveryPending || task.cancellationPending
                      }
                      onClick={() => onReselect(task.localTaskId)}
                    >
                      重新选择
                    </button>
                  ) : !task.cancellationFailed &&
                    !task.completionRecoveryTerminal &&
                    (task.status === "failed" || task.status === "paused") ? (
                    <button
                      type="button"
                      aria-label={`重试 ${task.filename}`}
                      title="重试"
                      disabled={
                        task.recoveryPending || task.cancellationPending
                      }
                      onClick={() => onRetry(task.localTaskId)}
                    >
                      <RefreshCw aria-hidden="true" />
                    </button>
                  ) : null}
                  {task.status !== "ready" ? (
                    <button
                      type="button"
                      aria-label={
                        task.completionRecoveryTerminal || task.discardLocalOnly
                          ? `清除本地记录 ${task.filename}`
                          : `放弃 ${task.filename}`
                      }
                      disabled={
                        task.recoveryPending || task.cancellationPending
                      }
                      title={
                        task.completionRecoveryTerminal || task.discardLocalOnly
                          ? "清除本地记录"
                          : "放弃上传"
                      }
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
      ) : null}
    </aside>
  );
}
