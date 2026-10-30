"use client";

/* eslint-disable @next/next/no-img-element -- browser session/share credentials belong on byte-route requests */
import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, X } from "lucide-react";
import type { WebEvidenceAssetDto } from "@/features/inspiration-visuals/contracts";
import styles from "./inspiration.module.css";

type Media = {
  imageUrl: string;
  altText: string;
  width: number;
  height: number;
};

export function EvidenceImage({
  asset,
  eager = false,
}: {
  asset: Media;
  eager?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span
      className={styles.evidenceMedia}
      style={{ aspectRatio: `${asset.width} / ${asset.height}` }}
    >
      {failedUrl === asset.imageUrl ? (
        <span className={styles.imageFallback}>图片暂时无法显示</span>
      ) : (
        <img
          src={asset.imageUrl}
          alt={asset.altText}
          width={asset.width}
          height={asset.height}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailedUrl(asset.imageUrl)}
        />
      )}
    </span>
  );
}

export function OriginalPageLink({ asset }: { asset: WebEvidenceAssetDto }) {
  return (
    <a href={asset.sourcePageUrl} target="_blank" rel="noopener noreferrer">
      打开原始页面
      <ExternalLink aria-hidden="true" />
    </a>
  );
}

export function InspirationEvidenceDialog({
  asset,
  children,
}: {
  asset: WebEvidenceAssetDto;
  children: ReactNode;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          className={styles.evidencePreview}
          type="button"
          aria-label={`预览：${asset.title}`}
        >
          {children}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={`${styles.dialog} ${styles.evidenceDialog}`}>
          <div className={styles.dialogHeader}>
            <Dialog.Title>{asset.title}</Dialog.Title>
            <Dialog.Close className={styles.iconButton} aria-label="关闭预览">
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description>{asset.sourceSiteName}</Dialog.Description>
          <EvidenceImage asset={asset} eager />
          <div className={styles.evidenceCaption}>
            <OriginalPageLink asset={asset} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
