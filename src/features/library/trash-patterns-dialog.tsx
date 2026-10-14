"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Trash2, X } from "lucide-react";
import { useMemo } from "react";

import { formatFenForDisplay } from "@/features/authorizations/api";
import { patternDeletionImpactSchema } from "@/features/trash/deletion-impact-contracts";
import { readApiResponse } from "@/lib/query/client";
import { useQueryOwnerId } from "@/lib/query/provider";

import { IconButton } from "./icon-button";
import type { PatternItem } from "./library-types";

export function TrashPatternsDialog({
  patterns,
  isPending,
  onConfirm,
  onOpenChange,
  open,
}: {
  patterns: PatternItem[];
  isPending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const ownerId = useQueryOwnerId();
  const patternIds = useMemo(
    () => patterns.map((pattern) => pattern.id).sort(),
    [patterns],
  );
  const impactQuery = useQuery({
    queryKey: ["owner", ownerId, "pattern-deletion-impact", patternIds],
    queryFn: async () =>
      patternDeletionImpactSchema.parse(
        await readApiResponse(
          await fetch("/api/patterns/deletion-impact", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ patternIds }),
          }),
        ),
      ),
    enabled: open && patternIds.length > 0,
    networkMode: "always",
    refetchOnMount: "always",
    retry: false,
    staleTime: 0,
  });
  const loading = impactQuery.isPending || impactQuery.isFetching;
  const impact =
    !loading && !impactQuery.isError ? impactQuery.data : undefined;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isPending) return;
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="confirm-dialog"
          onEscapeKeyDown={(event) => {
            if (isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (isPending) event.preventDefault();
          }}
        >
          <header className="confirm-dialog-header">
            <div>
              <Dialog.Title>移入回收站</Dialog.Title>
              <Dialog.Description>
                确定将 {patterns.length}{" "}
                个图案移入回收站吗？之后可以撤销或在回收站恢复。
              </Dialog.Description>
              {loading ? (
                <p role="status">正在核对授权和文件...</p>
              ) : impactQuery.isError ? (
                <div role="alert">
                  无法核对删除影响，请重试。
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void impactQuery.refetch()}
                  >
                    重新核对
                  </button>
                </div>
              ) : impact ? (
                <div className="trash-commercial-impact">
                  <strong>
                    有效授权 {impact.activeAuthorizationCount} 笔 ·{" "}
                    {formatFenForDisplay(impact.activeRevenueFen)}
                  </strong>
                  <span>
                    共 {impact.totalAuthorizationCount} 条授权记录 ·{" "}
                    {impact.assetCount} 个文件
                  </span>
                  <span>
                    预计永久删除：
                    <time dateTime={impact.purgeOn}>
                      {new Intl.DateTimeFormat("zh-CN").format(
                        new Date(impact.purgeOn),
                      )}
                    </time>
                  </span>
                  <p className="trash-commercial-warning">
                    永久删除后，授权历史和过去看板收入也会删除。
                  </p>
                </div>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <IconButton disabled={isPending} label="关闭">
                <X aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </header>
          <footer className="confirm-dialog-actions">
            <Dialog.Close asChild>
              <button className="secondary-button" disabled={isPending} type="button">
                取消
              </button>
            </Dialog.Close>
            <button
              className="danger-button"
              disabled={isPending || !impact}
              type="button"
              onClick={() => {
                if (impact) onConfirm();
              }}
            >
              <Trash2 aria-hidden="true" />
              {isPending ? "正在处理" : "确认移入回收站"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
