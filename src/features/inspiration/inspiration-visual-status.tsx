import { ImagePlus, RefreshCw } from "lucide-react";
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

export function InspirationVisualStatus({
  board,
  loading = false,
  error = false,
  refreshing = false,
  onRefresh,
}: {
  board: InspirationVisualBoardDto | undefined;
  loading?: boolean;
  error?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const pending = refreshing || board?.refreshJob?.status === "pending";
  const failed = board?.refreshJob?.status === "failed";
  const hasActive = !!board?.activeJob;
  const hasContent = !!(
    board?.webEvidence.length ||
    board?.libraryMatches.length ||
    board?.concepts.length
  );
  const warnings = [
    ...new Set([
      ...(board?.activeJob?.warnings ?? []),
      ...(board?.refreshJob?.warnings ?? []),
    ]),
  ];
  return (
    <aside
      className={styles.visualStatus}
      aria-label="视觉素材状态"
      aria-busy={pending}
    >
      <div className={styles.visualStatusText}>
        {loading && <p role="status">正在加载视觉素材…</p>}
        {pending && <p role="status">正在补充视觉素材…</p>}
        {error && (
          <p role="alert">
            视觉素材加载失败{hasContent ? "，已保留现有参考。" : ""}
          </p>
        )}
        {failed && !pending && (
          <p className={styles.visualWarning}>
            {hasContent
              ? "本次视觉补充未完成，已保留现有参考。"
              : "暂未获得视觉素材，可重试补充。"}
          </p>
        )}
        {!loading && !pending && !error && !failed && !hasContent && (
          <p className={styles.muted}>
            暂无视觉素材，可补充网络参考与私有素材匹配。
          </p>
        )}
        {warnings.length > 0 && (
          <ul className={styles.visualWarnings}>
            {warnings.map((warning) => (
              <li key={warning}>{warningLabels[warning]}</li>
            ))}
          </ul>
        )}
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
    </aside>
  );
}
