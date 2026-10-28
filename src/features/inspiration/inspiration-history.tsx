import type { InspirationSummaryDto } from "./contracts";
import styles from "./inspiration.module.css";

const statusLabels = {
  pending: "分析中",
  completed: "已完成",
  failed: "分析失败",
};
export function InspirationHistory({
  items,
  selectedId,
  loading,
  error,
  hasMore,
  fetchingMore,
  onSelect,
  onMore,
  onRefresh,
}: {
  items: InspirationSummaryDto[];
  selectedId: string | null;
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  fetchingMore: boolean;
  onSelect: (id: string) => void;
  onMore: () => void;
  onRefresh: () => void;
}) {
  return (
    <aside className={styles.history} aria-label="研究历史">
      <h2>
        研究历史 <span className={styles.muted}>{items.length}</span>
      </h2>
      {loading && <p role="status">正在加载研究记录…</p>}
      {error && (
        <div>
          <p role="alert">研究记录加载失败</p>
          <button className={styles.button} onClick={onRefresh}>
            重新加载
          </button>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <p className={styles.empty}>暂无研究记录</p>
      )}
      <ul className={styles.historyList}>
        {items.map((item) => (
          <li key={item.id}>
            <button
              className={styles.historyItem}
              aria-pressed={item.id === selectedId}
              onClick={() => onSelect(item.id)}
            >
              <strong>{item.title}</strong>
              <span>
                <span>{statusLabels[item.status]}</span>
                <time dateTime={item.updatedAt}>
                  {item.updatedAt.slice(0, 10)}
                </time>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          className={styles.button}
          disabled={fetchingMore}
          onClick={onMore}
        >
          {fetchingMore ? "加载中…" : "加载更多"}
        </button>
      )}
    </aside>
  );
}
