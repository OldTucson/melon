/* eslint-disable @next/next/no-img-element -- asset routes require the browser session */
import { ExternalLink, ImagePlus, RefreshCw } from "lucide-react";

import type {
  InspirationVisualBoardDto,
  VisualWarning,
} from "@/features/inspiration-visuals/contracts";
import styles from "./inspiration.module.css";

const warningLabels: Record<VisualWarning, string> = {
  INSPIRATION_WEB_VISUALS_DISABLED: "网络视觉参考暂未开启",
  INSPIRATION_WEB_VISUALS_UNAVAILABLE: "网络视觉参考暂时不可用",
  INSPIRATION_LIBRARY_MATCH_DISABLED: "素材库色彩匹配暂未开启",
  INSPIRATION_LIBRARY_MATCH_EMPTY: "素材库中暂未找到接近配色",
  INSPIRATION_LIBRARY_MATCH_UNAVAILABLE: "素材库色彩匹配暂时不可用",
};

type InspirationVisualBoardProps = {
  board: InspirationVisualBoardDto | undefined;
  loading?: boolean;
  error?: boolean;
  refreshing?: boolean;
  placement: "summary" | "library";
  onRefresh?: () => void;
};

export function InspirationVisualBoard({
  board,
  loading = false,
  error = false,
  refreshing = false,
  placement,
  onRefresh,
}: InspirationVisualBoardProps) {
  if (placement === "library") {
    if (!board?.libraryMatches.length) return null;
    return (
      <section className={styles.visualSection} aria-label="素材库色彩匹配">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionKicker}>COLOR MATCH</p>
            <h3>素材库色彩匹配</h3>
          </div>
          <span className={styles.muted}>{board.libraryMatches.length} 项</span>
        </div>
        <div className={styles.visualMosaic}>
          {board.libraryMatches.map((asset) => (
            <a
              className={styles.visualTile}
              href={asset.libraryHref}
              key={asset.id}
            >
              <img
                src={asset.imageUrl}
                alt={asset.altText}
                width="800"
                height="600"
                loading="lazy"
                decoding="async"
              />
              <span className={styles.visualCaption}>
                <strong>{asset.title}</strong>
                <span className={styles.tilePalette} aria-hidden="true">
                  {asset.palette.map((color) => (
                    <span key={color} style={{ backgroundColor: color }} />
                  ))}
                </span>
              </span>
            </a>
          ))}
        </div>
      </section>
    );
  }

  const pending =
    refreshing || board?.refreshJob?.status === "pending";
  const failed = board?.refreshJob?.status === "failed";
  const hasActive = board?.activeJob !== null && board?.activeJob !== undefined;
  const visualAssets = [
    ...(board?.webEvidence ?? []),
    ...(board?.concepts ?? []),
  ];
  const warnings = [
    ...(board?.activeJob?.warnings ?? []),
    ...(board?.refreshJob?.warnings ?? []),
  ].filter((warning, index, all) => all.indexOf(warning) === index);

  return (
    <section
      className={styles.visualSection}
      aria-label="视觉摘要"
      aria-busy={pending}
    >
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.sectionKicker}>VISUAL EVIDENCE</p>
          <h3>视觉摘要</h3>
        </div>
        {onRefresh && board?.refreshAvailable && !loading && (
          <button
            className={styles.button}
            type="button"
            disabled={pending}
            onClick={onRefresh}
          >
            {hasActive ? (
              <RefreshCw aria-hidden="true" />
            ) : (
              <ImagePlus aria-hidden="true" />
            )}
            {pending
              ? "正在补充…"
              : failed
                ? "重试视觉素材"
                : hasActive
                  ? "刷新视觉素材"
                  : "补充视觉素材"}
          </button>
        )}
      </div>
      {loading && <p role="status">正在加载视觉素材…</p>}
      {pending && <p role="status">正在补充视觉素材…</p>}
      {error && <p role="alert">视觉素材加载失败</p>}
      {failed && !pending && (
        <p className={styles.visualWarning}>视觉素材生成失败，文字报告不受影响。</p>
      )}
      {warnings.length > 0 && (
        <ul className={styles.visualWarnings}>
          {warnings.map((warning) => (
            <li key={warning}>{warningLabels[warning]}</li>
          ))}
        </ul>
      )}
      {visualAssets.length > 0 && (
        <div className={styles.visualMosaic}>
          {visualAssets.map((asset) => {
            const content = (
              <>
                <img
                  src={asset.imageUrl}
                  alt={asset.altText}
                  width={asset.width}
                  height={asset.height}
                  loading="lazy"
                  decoding="async"
                />
                <span className={styles.visualCaption}>
                  <strong>{asset.title}</strong>
                  {asset.kind === "web_evidence" && (
                    <span>
                      {asset.sourceSiteName}
                      <ExternalLink aria-hidden="true" />
                    </span>
                  )}
                </span>
              </>
            );
            return asset.kind === "web_evidence" ? (
              <a
                className={styles.visualTile}
                href={asset.sourcePageUrl}
                target="_blank"
                rel="noopener noreferrer"
                key={asset.id}
              >
                {content}
              </a>
            ) : asset.libraryHref ? (
              <a
                className={styles.visualTile}
                href={asset.libraryHref}
                key={asset.id}
              >
                {content}
              </a>
            ) : (
              <figure className={styles.visualTile} key={asset.id}>
                {content}
              </figure>
            );
          })}
        </div>
      )}
    </section>
  );
}
