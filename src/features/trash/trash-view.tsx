"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Folder, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  useTrashMutation,
  useTrashQuery,
  type TrashIntent,
} from "./trash-mutations";
import type {
  TrashFolderBatch,
  TrashPatternBatch,
  TrashList,
} from "./trash-types";
import { queryKeys } from "@/lib/query/keys";
import { useQueryOwnerId } from "@/lib/query/provider";

type Confirmation = { intent: TrashIntent; description: string };
export function TrashView() {
  const client = useQueryClient();
  const ownerId = useQueryOwnerId();
  const query = useTrashQuery();
  const mutation = useTrashMutation();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (intent: TrashIntent) => {
    if (mutation.isPending) return;
    const current = client.getQueryData<TrashList>(queryKeys.trash(ownerId));
    if (!current || !intentStillAvailable(current, intent)) {
      setMessage("状态已变化，请刷新后重新选择");
      return;
    }
    setMessage(null);
    try {
      await mutation.mutateAsync(intent);
      setConfirmation(null);
      setSelected([]);
    } catch {
      setMessage(
        intent.action === "purge"
          ? "删除未完成，请刷新状态后重试"
          : "恢复失败，请刷新后重试",
      );
    }
  };
  const folderIntent = (
    batch: TrashFolderBatch,
    action: "restore" | "purge",
  ): TrashIntent => ({
    kind: "folder",
    action,
    operationId:
      action === "purge"
        ? (batch.purgeOperationId ?? crypto.randomUUID())
        : crypto.randomUUID(),
    trashBatchId: batch.trashBatchId,
    rootFolderId: batch.rootFolderId,
    folderCount: batch.folderCount,
    patternCount: batch.patternCount,
  });
  const openFolderPurge = (batch: TrashFolderBatch) => {
    setMessage(null);
    setConfirmation({
      intent: folderIntent(batch, "purge"),
      description: `“${batch.rootFolderName}”：${batch.folderCount} 个文件夹 · ${batch.patternCount} 个图案`,
    });
  };
  const openPatternPurge = (batch: TrashPatternBatch, retry = false) => {
    const candidates = retry
      ? (query.data?.patternBatches
          .filter(
            (candidate) =>
              candidate.purgeOperationId === batch.purgeOperationId,
          )
          .flatMap((candidate) => candidate.patterns) ?? [])
      : batch.patterns;
    const patterns = candidates.filter((p) =>
      retry
        ? p.status === "deleting"
        : selected.includes(p.id) && p.status === "trashed",
    );
    if (
      !patterns.length ||
      patterns.length > 100 ||
      (retry && !batch.purgeOperationId)
    )
      return;
    setMessage(null);
    setConfirmation({
      intent: {
        kind: "patterns",
        action: "purge",
        operationId: batch.purgeOperationId ?? crypto.randomUUID(),
        patternIds: patterns.map((p) => p.id),
      },
      description: `${patterns.length} 个图案：${patterns.map((p) => p.name).join("、")}`,
    });
  };
  const pending = mutation.isPending;
  const rowPending = (batchId: string, patternIds?: string[]) =>
    pending &&
    (mutation.variables?.kind === "folder"
      ? mutation.variables.trashBatchId === batchId
      : mutation.variables?.patternIds.some((id) => patternIds?.includes(id)));
  return (
    <main className="trash-workspace">
      <header className="library-heading">
        <div>
          <h1>回收站</h1>
          <p>恢复图案和文件夹，或永久删除不再需要的内容。</p>
        </div>
        <button
          className="bulk-action-button"
          title="刷新回收站"
          disabled={pending || query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RotateCcw aria-hidden="true" />
          刷新
        </button>
      </header>
      {query.isPending ? (
        <p role="status">正在载入回收站...</p>
      ) : !query.data ? (
        <div role="alert">
          回收站载入失败
          <button onClick={() => void query.refetch()}>重新载入</button>
        </div>
      ) : (
        <>
          {query.isError ? (
            <p role="alert">刷新失败，正在显示上次载入的内容。请重新刷新。</p>
          ) : null}
          {query.data.folderBatches.length +
            query.data.patternBatches.length ===
          0 ? (
            <p className="trash-empty">回收站是空的</p>
          ) : null}
          {query.data.folderBatches.map((batch) => {
            const deleting = batch.state === "deleting";
            const failed = batch.lastErrorCode === "OSS_DELETE_FAILED";
            return (
              <section
                className="trash-folder-row"
                aria-label={batch.rootFolderName}
                key={batch.trashBatchId}
              >
                <Folder aria-hidden="true" />
                <div className="trash-row-copy">
                  <h2 title={batch.rootFolderName}>{batch.rootFolderName}</h2>
                  <p>
                    {batch.folderCount} 个文件夹 · {batch.patternCount} 个图案
                  </p>
                  <Expiry value={batch.expiresAt} />
                  {rowPending(batch.trashBatchId) ? (
                    <p role="status">
                      {mutation.variables?.action === "purge"
                        ? "正在永久删除..."
                        : "正在恢复..."}
                    </p>
                  ) : failed ? (
                    <p role="alert">删除失败，可重试</p>
                  ) : deleting ? (
                    <p role="status">正在永久删除...</p>
                  ) : null}
                </div>
                <div className="trash-row-actions">
                  <button
                    className="bulk-action-button"
                    disabled={pending || deleting}
                    onClick={() => void run(folderIntent(batch, "restore"))}
                  >
                    <RotateCcw aria-hidden="true" />
                    恢复
                  </button>
                  <button
                    className="bulk-action-button"
                    disabled={pending || deleting}
                    onClick={() => openFolderPurge(batch)}
                  >
                    <Trash2 aria-hidden="true" />
                    永久删除
                  </button>
                  {failed && batch.purgeOperationId ? (
                    <button
                      className="bulk-action-button"
                      disabled={pending}
                      onClick={() => openFolderPurge(batch)}
                    >
                      <RotateCcw aria-hidden="true" />
                      重试删除
                    </button>
                  ) : null}
                </div>
              </section>
            );
          })}
          {query.data.patternBatches.map((batch) => {
            const deleting = batch.state === "deleting";
            const failed = batch.lastErrorCode === "OSS_DELETE_FAILED";
            const ids = batch.patterns
              .filter((p) => selected.includes(p.id) && p.status === "trashed")
              .map((p) => p.id);
            const disabled =
              pending || deleting || ids.length === 0 || ids.length > 100;
            return (
              <section
                className="trash-pattern-batch"
                aria-label="已删除图案批次"
                key={batch.trashBatchId}
              >
                <header className="trash-batch-header">
                  <div>
                    <h2>图案 · {batch.patterns.length} 项</h2>
                    <Expiry value={batch.expiresAt} />
                  </div>
                  <div className="trash-row-actions">
                    <button
                      className="bulk-action-button"
                      disabled={disabled}
                      onClick={() =>
                        void run({
                          kind: "patterns",
                          action: "restore",
                          operationId: crypto.randomUUID(),
                          patternIds: ids,
                        })
                      }
                    >
                      <RotateCcw aria-hidden="true" />
                      恢复所选
                    </button>
                    <button
                      className="bulk-action-button"
                      disabled={disabled}
                      onClick={() => openPatternPurge(batch)}
                    >
                      <Trash2 aria-hidden="true" />
                      永久删除所选
                    </button>
                    {failed && batch.purgeOperationId ? (
                      <button
                        className="bulk-action-button"
                        disabled={pending}
                        onClick={() => openPatternPurge(batch, true)}
                      >
                        <RotateCcw aria-hidden="true" />
                        重试删除
                      </button>
                    ) : null}
                  </div>
                </header>
                {ids.length > 100 ? (
                  <p role="alert">每次最多处理 100 个图案</p>
                ) : null}
                {rowPending(
                  batch.trashBatchId,
                  batch.patterns.map((p) => p.id),
                ) ? (
                  <p role="status">
                    {mutation.variables?.action === "purge"
                      ? "正在永久删除..."
                      : "正在恢复..."}
                  </p>
                ) : failed ? (
                  <p role="alert">删除失败，可重试</p>
                ) : deleting ? (
                  <p role="status">正在永久删除...</p>
                ) : null}
                {batch.patterns.map((pattern) => (
                  <label className="trash-pattern-row" key={pattern.id}>
                    <input
                      type="checkbox"
                      aria-label={`选择${pattern.name}`}
                      checked={selected.includes(pattern.id)}
                      disabled={pending || deleting}
                      onChange={(event) =>
                        setSelected((ids) =>
                          event.target.checked
                            ? [...ids, pattern.id]
                            : ids.filter((id) => id !== pattern.id),
                        )
                      }
                    />
                    <span className="trash-row-copy" title={pattern.name}>
                      {pattern.name}
                    </span>
                    <span>{pattern.extension.toUpperCase()}</span>
                  </label>
                ))}
              </section>
            );
          })}
        </>
      )}
      {message && !confirmation ? <p role="alert">{message}</p> : null}
      <Dialog.Root
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="confirm-dialog"
            onEscapeKeyDown={(event) => {
              if (pending) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (pending) event.preventDefault();
            }}
          >
            <Dialog.Title>永久删除</Dialog.Title>
            <Dialog.Description>
              {confirmation?.description}。永久删除后不可恢复。
            </Dialog.Description>
            {message ? <p role="alert">{message}</p> : null}
            <footer className="confirm-dialog-actions">
              <Dialog.Close asChild>
                <button className="secondary-button" disabled={pending}>
                  取消
                </button>
              </Dialog.Close>
              <button
                className="danger-button"
                disabled={pending}
                onClick={() => {
                  if (confirmation) void run(confirmation.intent);
                }}
              >
                <Trash2 aria-hidden="true" />
                {pending ? "正在处理" : "确认永久删除"}
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
function Expiry({ value }: { value: string }) {
  return (
    <p className="trash-expiry">
      到期：
      <time dateTime={value}>
        {new Intl.DateTimeFormat("zh-CN").format(new Date(value))}
      </time>
    </p>
  );
}

function intentStillAvailable(data: TrashList, intent: TrashIntent) {
  if (intent.kind === "folder") {
    const batch = data.folderBatches.find(
      (batch) => batch.trashBatchId === intent.trashBatchId,
    );
    return Boolean(
      batch &&
      batch.rootFolderId === intent.rootFolderId &&
      batch.folderCount === intent.folderCount &&
      batch.patternCount === intent.patternCount &&
      (batch.state === "trashed" ||
        (intent.action === "purge" &&
          batch.purgeOperationId === intent.operationId &&
          batch.lastErrorCode === "OSS_DELETE_FAILED")),
    );
  }
  const retryBatches = data.patternBatches.filter(
    (batch) => batch.purgeOperationId === intent.operationId,
  );
  if (intent.action === "purge" && retryBatches.length > 0) {
    if (
      !retryBatches.some((batch) => batch.lastErrorCode === "OSS_DELETE_FAILED")
    )
      return false;
    const deleting = retryBatches.flatMap((batch) =>
      batch.patterns.filter((pattern) => pattern.status === "deleting"),
    );
    return (
      deleting.length === intent.patternIds.length &&
      deleting.every((pattern) => intent.patternIds.includes(pattern.id))
    );
  }
  const batch = data.patternBatches.find((batch) =>
    intent.patternIds.every((id) =>
      batch.patterns.some((pattern) => pattern.id === id),
    ),
  );
  if (!batch) return false;
  if (batch.state === "trashed") return true;
  if (
    intent.action !== "purge" ||
    batch.purgeOperationId !== intent.operationId ||
    batch.lastErrorCode !== "OSS_DELETE_FAILED"
  )
    return false;
  const deleting = batch.patterns.filter(
    (pattern) => pattern.status === "deleting",
  );
  return (
    deleting.length === intent.patternIds.length &&
    deleting.every((pattern) => intent.patternIds.includes(pattern.id))
  );
}
