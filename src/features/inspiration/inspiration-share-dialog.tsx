"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Link2, Link2Off } from "lucide-react";
import { useQueryOwnerId } from "@/lib/query/provider";
import type { InspirationDetailDto } from "./contracts";
import { inspirationApi } from "./inspiration-api";
import { inspirationKeys } from "./query-keys";
import styles from "./inspiration.module.css";

export function InspirationShareDialog({
  analysis,
  onClose,
}: {
  analysis: InspirationDetailDto;
  onClose: () => void;
}) {
  const ownerId = useQueryOwnerId();
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const share = useMutation({
    mutationFn: (enabled: boolean) =>
      inspirationApi.share(analysis.id, enabled),
    onMutate: () => {
      setNotice(null);
      setCopyError(false);
    },
    onSuccess: async (data) => {
      client.setQueryData(inspirationKeys.detail(ownerId, data.id), data);
      await client.invalidateQueries({
        queryKey: inspirationKeys.all(ownerId),
      });
    },
  });
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !share.isPending) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          onEscapeKeyDown={(event) => {
            if (share.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (share.isPending) event.preventDefault();
          }}
        >
          <Dialog.Title>分享研究</Dialog.Title>
          <Dialog.Description>{analysis.title}</Dialog.Description>
          {analysis.shareUrl ? (
            <>
              <a
                className={styles.shareLink}
                href={analysis.shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="打开分享链接"
              >
                {analysis.shareUrl}
                <ExternalLink aria-hidden="true" />
              </a>
              <div className={styles.actions}>
                <button
                  className={styles.button}
                  disabled={share.isPending}
                  onClick={async () => {
                    setCopyError(false);
                    setNotice(null);
                    try {
                      await navigator.clipboard.writeText(analysis.shareUrl!);
                      setNotice("已复制链接");
                    } catch {
                      setCopyError(true);
                    }
                  }}
                >
                  <Link2 aria-hidden="true" />
                  复制链接
                </button>
                <button
                  className={styles.button}
                  disabled={share.isPending}
                  onClick={() => share.mutate(false)}
                >
                  <Link2Off aria-hidden="true" />
                  {share.isPending ? "正在撤销…" : "撤销分享"}
                </button>
              </div>
            </>
          ) : (
            <button
              className={styles.button}
              disabled={share.isPending}
              onClick={() => share.mutate(true)}
            >
              <Link2 aria-hidden="true" />
              {share.isPending ? "正在开启…" : "开启分享"}
            </button>
          )}
          {notice && <p role="status">{notice}</p>}
          {(share.isError || copyError) && (
            <p role="alert">
              {copyError ? "复制失败，请重试" : "分享操作失败，请重试"}
            </p>
          )}
          <footer className={styles.actions}>
            <button
              className={styles.button}
              disabled={share.isPending}
              onClick={onClose}
            >
              关闭
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
