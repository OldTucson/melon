"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Folder, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { ApiResponseError } from "@/lib/query/client";
import { formatFenForDisplay } from "@/features/authorizations/api";
import { PageHeader } from "@/components/ui/page-header";

type CommercialImpact = Pick<
  TrashFolderBatch,
  | "activeAuthorizationCount"
  | "activeRevenueFen"
  | "totalAuthorizationCount"
  | "assetCount"
>;
type Confirmation = {
  intent: TrashIntent;
  summary: string;
  names: string[];
  impact: CommercialImpact;
};
export type TrashDeepLinkTarget = {
  id: string;
  name: string;
  trashBatchId: string;
};

function useOnlineStatus() {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function TrashView({
  initialTarget,
}: {
  initialTarget?: TrashDeepLinkTarget;
}) {
  const client = useQueryClient();
  const ownerId = useQueryOwnerId();
  const query = useTrashQuery();
  const mutation = useTrashMutation();
  const online = useOnlineStatus();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const appliedTargetId = useRef<string | null>(null);
  const ordinaryTarget = query.data?.patternBatches
    .flatMap((batch) => batch.patterns)
    .find((pattern) => pattern.id === initialTarget?.id);
  const targetedFolderBatchId =
    initialTarget && query.data && !ordinaryTarget
      ? initialTarget.trashBatchId
      : null;

  useEffect(() => {
    if (!initialTarget) {
      appliedTargetId.current = null;
      return;
    }
    if (
      !ordinaryTarget ||
      appliedTargetId.current === initialTarget.id
    ) {
      return;
    }
    appliedTargetId.current = initialTarget.id;
    setSelected([initialTarget.id]);
  }, [initialTarget, ordinaryTarget]);

  useEffect(() => {
    if (!initialTarget || !selected.includes(initialTarget.id)) return;
    const checkbox = document.querySelector<HTMLInputElement>(
      `[data-trash-pattern-id="${initialTarget.id}"]`,
    );
    checkbox?.scrollIntoView?.({ block: "center" });
    checkbox?.focus();
  }, [initialTarget, selected]);
  const run = async (intent: TrashIntent) => {
    if (mutation.isPending) return;
    if (intent.action === "purge" && !online) {
      setMessage("永久删除需要联网，请恢复网络后重试。");
      return;
    }
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
    } catch (error) {
      setMessage(
        error instanceof ApiResponseError &&
          error.code === "TRASH_PURGE_DEFERRED"
          ? "正在等待上传凭据失效和写入结束，请稍后继续删除。"
          : intent.action === "purge"
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
      summary: `${batch.folderCount} 个文件夹 · ${batch.patternCount} 个图案`,
      names: [batch.rootFolderName],
      impact: batch,
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
      summary: `${patterns.length} 个图案`,
      names: patterns.map((pattern) => pattern.name),
      impact: sumCommercialImpact(patterns),
    });
  };
  const pending = mutation.isPending;
  const rowPending = (batchId: string, patternIds?: string[]) =>
    pending &&
    (mutation.variables?.kind === "folder"
      ? mutation.variables.trashBatchId === batchId
      : mutation.variables?.patternIds.some((id) => patternIds?.includes(id)));
  return (
    <main aria-labelledby="trash-page-title" className="trash-workspace">
      <PageHeader
        actions={
          <button
            className="secondary-button"
            title="刷新回收站"
            disabled={pending || query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RotateCcw aria-hidden="true" />
            刷新
          </button>
        }
        className="trash-header"
        description="恢复图案和文件夹，或永久删除不再需要的内容。"
        eyebrow="资料管理"
        id="trash-page-title"
        title="回收站"
      />
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
                data-targeted={
                  targetedFolderBatchId === batch.trashBatchId
                    ? "true"
                    : undefined
                }
                key={batch.trashBatchId}
              >
                <Folder aria-hidden="true" />
                <div className="trash-row-copy">
                  <h2 title={batch.rootFolderName}>{batch.rootFolderName}</h2>
                  <p>
                    {batch.folderCount} 个文件夹 · {batch.patternCount} 个图案
                  </p>
                  <CommercialImpactSummary impact={batch} />
                  <Expiry value={batch.expiresAt} />
                  {targetedFolderBatchId === batch.trashBatchId ? (
                    <p className="trash-target-note" role="status">
                      包含目标图案：{initialTarget?.name}
                    </p>
                  ) : null}
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
                    className="danger-button"
                    disabled={pending || deleting}
                    onClick={() => openFolderPurge(batch)}
                  >
                    <Trash2 aria-hidden="true" />
                    永久删除
                  </button>
                  {deleting && batch.purgeOperationId ? (
                    <button
                      className="danger-button"
                      disabled={pending}
                      onClick={() => openFolderPurge(batch)}
                    >
                      <RotateCcw aria-hidden="true" />
                      {failed ? "重试删除" : "继续删除"}
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
                    <CommercialImpactSummary impact={batch} />
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
                      className="danger-button"
                      disabled={disabled}
                      onClick={() => openPatternPurge(batch)}
                    >
                      <Trash2 aria-hidden="true" />
                      永久删除所选
                    </button>
                    {deleting && batch.purgeOperationId ? (
                      <button
                        className="danger-button"
                        disabled={pending}
                        onClick={() => openPatternPurge(batch, true)}
                      >
                        <RotateCcw aria-hidden="true" />
                        {failed ? "重试删除" : "继续删除"}
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
                      data-trash-pattern-id={pattern.id}
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
            className="confirm-dialog trash-confirm-dialog"
            onEscapeKeyDown={(event) => {
              if (pending) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (pending) event.preventDefault();
            }}
          >
            <header className="confirm-dialog-header">
              <div>
                <Dialog.Title>永久删除</Dialog.Title>
                <Dialog.Description>
                  {confirmation?.summary}。永久删除后不可恢复。
                </Dialog.Description>
                {confirmation ? (
                  <div className="trash-commercial-impact">
                    <strong>
                      有效授权 {confirmation.impact.activeAuthorizationCount} 笔 ·{" "}
                      {formatFenForDisplay(
                        confirmation.impact.activeRevenueFen,
                      )}
                    </strong>
                    <span>
                      共 {confirmation.impact.totalAuthorizationCount} 条授权记录 ·{" "}
                      {confirmation.impact.assetCount} 个文件
                    </span>
                    <p className="trash-commercial-warning">
                      永久删除后，授权历史和过去看板收入也会删除。
                    </p>
                  </div>
                ) : null}
                {!online ? (
                  <p role="alert">永久删除需要联网，请恢复网络后重试。</p>
                ) : message ? (
                  <p role="alert">{message}</p>
                ) : null}
              </div>
            </header>
            <ul
              className="trash-confirm-targets"
              aria-label="永久删除对象"
              tabIndex={0}
            >
              {confirmation?.names.map((name, index) => (
                <li key={index}>{name}</li>
              ))}
            </ul>
            <footer className="confirm-dialog-actions">
              <Dialog.Close asChild>
                <button className="secondary-button" disabled={pending}>
                  取消
                </button>
              </Dialog.Close>
              <button
                className="danger-button"
                disabled={pending || !online}
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
function CommercialImpactSummary({ impact }: { impact: CommercialImpact }) {
  return (
    <p className="trash-commercial-summary">
      有效授权 {impact.activeAuthorizationCount} 笔 ·{" "}
      {formatFenForDisplay(impact.activeRevenueFen)}
    </p>
  );
}

function sumCommercialImpact(
  patterns: TrashPatternBatch["patterns"],
): CommercialImpact {
  const impact = patterns.reduce(
    (value, pattern) => ({
      activeAuthorizationCount:
        value.activeAuthorizationCount + pattern.activeAuthorizationCount,
      activeRevenueFen:
        value.activeRevenueFen + BigInt(pattern.activeRevenueFen),
      totalAuthorizationCount:
        value.totalAuthorizationCount + pattern.totalAuthorizationCount,
      assetCount: value.assetCount + pattern.assetCount,
    }),
    {
      activeAuthorizationCount: 0,
      activeRevenueFen: 0n,
      totalAuthorizationCount: 0,
      assetCount: 0,
    },
  );
  return { ...impact, activeRevenueFen: impact.activeRevenueFen.toString() };
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
          batch.purgeOperationId === intent.operationId)),
    );
  }
  const retryBatches = data.patternBatches.filter(
    (batch) => batch.purgeOperationId === intent.operationId,
  );
  if (intent.action === "purge" && retryBatches.length > 0) {
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
  return batch?.state === "trashed";
}
