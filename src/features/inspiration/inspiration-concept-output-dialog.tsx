"use client";

import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, X } from "lucide-react";
import type { ConceptOutputAssetDto } from "@/features/inspiration-concepts/contracts";
import { EvidenceImage } from "./inspiration-evidence-dialog";
import styles from "./inspiration.module.css";

export function InspirationConceptOutputDialog({
  asset,
  children,
  mode = "private",
}: {
  asset: ConceptOutputAssetDto;
  children: ReactNode;
  mode?: "private" | "public";
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={styles.evidencePreview}
          aria-label={`预览：${asset.title}`}
        >
          {children}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={`${styles.dialog} ${styles.evidenceDialog} ${styles.conceptOutputDialog}`}
        >
          <div className={styles.dialogHeader}>
            <Dialog.Title>{asset.title}</Dialog.Title>
            <Dialog.Close className={styles.iconButton} aria-label="关闭预览">
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className={styles.muted}>
            AI 生成
          </Dialog.Description>
          <EvidenceImage asset={asset} eager />
          <footer className={styles.actions}>
            <a
              className={styles.button}
              href={
                mode === "public"
                  ? asset.imageUrl
                  : `/api/inspiration-concept-assets/${asset.id}/download`
              }
              download="concept.png"
            >
              <Download aria-hidden="true" />
              下载图片
            </a>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
