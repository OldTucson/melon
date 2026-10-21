"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

import { IconButton } from "@/features/library/icon-button";
import {
  imageSearchIndexStatusSchema,
  imageSearchRebuildResultSchema,
  imageSearchRetryResultSchema,
  type ImageSearchIndexStatus,
} from "@/features/image-search/contracts";
import { queryKeys } from "@/lib/query/keys";
import { readApiResponse } from "@/lib/query/client";
import { useQueryOwnerId } from "@/lib/query/provider";

export type { ImageSearchIndexStatus } from "@/features/image-search/contracts";

const POLL_INTERVAL_MS = 15_000;

async function fetchIndexStatus() {
  const response = await fetch("/api/settings/image-search", {
    cache: "no-store",
  });
  return imageSearchIndexStatusSchema.parse(
    await readApiResponse<unknown>(response),
  );
}

async function retryFailedItems() {
  const response = await fetch("/api/settings/image-search/retry", {
    method: "POST",
  });
  return imageSearchRetryResultSchema.parse(
    await readApiResponse<unknown>(response),
  );
}

async function rebuildIndex() {
  const response = await fetch("/api/settings/image-search/rebuild", {
    method: "POST",
  });
  return imageSearchRebuildResultSchema.parse(
    await readApiResponse<unknown>(response),
  );
}

export function imageSearchIndexRefetchInterval(
  status: ImageSearchIndexStatus | undefined,
  visibility: DocumentVisibilityState,
) {
  return visibility === "visible" &&
    status !== undefined &&
    (status.pending > 0 || status.indexing > 0)
    ? POLL_INTERVAL_MS
    : false;
}

const workerLabels: Record<ImageSearchIndexStatus["worker"], string> = {
  online: "Worker 在线",
  stale: "Worker 心跳过期",
  offline: "Worker 离线",
};

export function ImageSearchIndexSettings() {
  const ownerId = useQueryOwnerId();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.imageSearchIndex(ownerId);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [visible, setVisible] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "visible",
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      setVisible(document.visibilityState === "visible");
    };
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const status = useQuery({
    queryKey,
    queryFn: fetchIndexStatus,
    refetchInterval: (query) =>
      imageSearchIndexRefetchInterval(
        query.state.data,
        visible ? "visible" : "hidden",
      ),
    refetchIntervalInBackground: false,
  });
  const refreshStatus = () =>
    queryClient.invalidateQueries({ queryKey, exact: true });
  const retry = useMutation({
    mutationFn: retryFailedItems,
    onSuccess: refreshStatus,
  });
  const rebuild = useMutation({
    mutationFn: rebuildIndex,
    onSuccess: () => {
      setRebuildOpen(false);
      return refreshStatus();
    },
  });

  return (
    <div className="image-search-index-settings">
      {status.isPending ? (
        <p className="muted-copy">正在读取索引状态...</p>
      ) : status.isError || !status.data ? (
        <p role="alert">图像搜索索引状态暂时无法读取</p>
      ) : (
        <>
          <div className="image-search-index-summary">
            <span className="image-search-index-version">
              {status.data.indexVersion}
            </span>
            <span data-worker-state={status.data.worker}>
              {workerLabels[status.data.worker]}
            </span>
          </div>
          <div className="image-search-index-counts" aria-label="索引状态计数">
            <span>{`可索引 ${status.data.eligible}`}</span>
            <span>{`已就绪 ${status.data.ready}`}</span>
            <span>{`等待中 ${status.data.pending}`}</span>
            <span>{`处理中 ${status.data.indexing}`}</span>
            <span>{`失败 ${status.data.failed}`}</span>
          </div>
          <div className="image-search-index-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={status.data.failed === 0 || retry.isPending}
              onClick={() => retry.mutate()}
            >
              <RotateCcw aria-hidden="true" />
              {retry.isPending ? "正在重试" : "重试失败项"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={rebuild.isPending}
              onClick={() => setRebuildOpen(true)}
            >
              <RefreshCw aria-hidden="true" />
              重建索引
            </button>
          </div>
          {retry.isError || rebuild.isError ? (
            <p role="alert">索引操作未能开始，请重试</p>
          ) : null}
        </>
      )}

      <Dialog.Root
        open={rebuildOpen}
        onOpenChange={(open) => {
          if (!rebuild.isPending) setRebuildOpen(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="confirm-dialog">
            <div className="confirm-dialog-header">
              <div>
                <Dialog.Title>重建图像搜索索引</Dialog.Title>
                <Dialog.Description>
                  重建会在后台运行，不会删除当前结果。现有可用索引会继续提供搜索，直到新结果发布。
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <IconButton label="取消重建">
                  <X aria-hidden="true" />
                </IconButton>
              </Dialog.Close>
            </div>
            <div className="confirm-dialog-actions">
              <Dialog.Close asChild>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={rebuild.isPending}
                >
                  取消
                </button>
              </Dialog.Close>
              <button
                className="primary-button"
                type="button"
                disabled={rebuild.isPending}
                onClick={() => rebuild.mutate()}
              >
                <RefreshCw aria-hidden="true" />
                {rebuild.isPending ? "正在开始" : "确认重建"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
