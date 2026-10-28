import { ExternalLink } from "lucide-react";
import type {
  ColorFacet,
  InspirationAnalysisResult,
  InspirationSource,
  TrendFacet,
} from "./contracts";
import styles from "./inspiration.module.css";

const strengths = { high: "强信号", medium: "中等信号", emerging: "新兴信号" };
const dimensions = [
  ["silhouettes", "款式"],
  ["productTypes", "类型"],
  ["styles", "风格"],
  ["categories", "品类"],
  ["colors", "色款"],
  ["materials", "材质"],
] as const;

function sourceLabel(source: InspirationSource) {
  const title = source.title.trim();
  const looksStructured = /^[{[]/.test(title) && /[":{},\]]/.test(title);
  if (!looksStructured) return title;
  return (
    source.siteName?.trim() ||
    new URL(source.url).hostname.replace(/^www\./, "")
  );
}

export function InspirationResult({
  result,
  sources,
}: {
  result: InspirationAnalysisResult;
  sources: InspirationSource[];
}) {
  const sourceMap = new Map(sources.map((source) => [source.index, source]));
  function sourceLinks(indexes: number[], label?: string) {
    return (
      <span className={styles.sourceLinks}>
        {[...new Set(indexes)].map((index) => {
          const source = sourceMap.get(index);
          return source ? (
            <a
              key={index}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {label ?? `[${index}] ${sourceLabel(source)}`}
              <ExternalLink aria-hidden="true" />
            </a>
          ) : null;
        })}
      </span>
    );
  }
  function facets(items: (TrendFacet | ColorFacet)[], empty: string) {
    const supported = items.filter((item) =>
      item.sourceIndexes.some((index) => sourceMap.has(index)),
    );
    return supported.length ? (
      <ul className={styles.facets}>
        {supported.map((item, index) => (
          <li key={index}>
            <div className={styles.facetTitle}>
              {"colorHint" in item && item.colorHint && (
                <span
                  className={styles.swatch}
                  role="img"
                  aria-label={`${item.name} ${item.colorHint}`}
                  style={{ backgroundColor: item.colorHint }}
                />
              )}
              <strong>{item.name}</strong>
              <span className={styles.signal}>{strengths[item.strength]}</span>
            </div>
            <p>{item.rationale}</p>
            {sourceLinks(item.sourceIndexes)}
          </li>
        ))}
      </ul>
    ) : (
      <p className={styles.empty}>{empty}</p>
    );
  }
  const looks = result.referenceLooks.filter((look) =>
    look.sourceIndexes.some((index) => sourceMap.has(index)),
  );
  return (
    <article className={styles.result}>
      <header>
        <h2>{result.headline}</h2>
        <p>{result.summary}</p>
        <p className={styles.muted}>{result.confidenceNote}</p>
      </header>
      <section aria-label="市场信号">
        <h3>市场信号</h3>
        {facets(result.marketSignals, "暂无有来源支持的市场信号")}
      </section>
      <div className={styles.dimensions}>
        {dimensions.map(([key, label]) => (
          <section key={key} aria-label={label}>
            <h3>{label}</h3>
            {facets(result.dimensions[key], "暂无有来源支持的趋势")}
          </section>
        ))}
      </div>
      <section aria-label="参考款">
        <h3>参考款</h3>
        {looks.length ? (
          <div className={styles.looks}>
            {looks.map((look, index) => (
              <div className={styles.look} key={index}>
                <h4>{look.name}</h4>
                <span className={styles.muted}>
                  {
                    {
                      product: "商品",
                      ranking: "榜单",
                      trend_article: "趋势文章",
                      other: "公开来源",
                    }[look.sourceKind]
                  }
                </span>
                <p>{look.whyRelevant}</p>
                {sourceLinks(look.sourceIndexes, look.name)}
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>暂无有来源支持的参考款</p>
        )}
      </section>
      <section aria-label="设计灵感">
        <h3>设计灵感 · 设计推演</h3>
        {result.inspirationPrompts.map((prompt, index) => (
          <div className={styles.inspirationPrompt} key={index}>
            <h4>{prompt.title}</h4>
            <p>{prompt.direction}</p>
            <dl>
              <div>
                <dt>廓形</dt>
                <dd>{prompt.silhouette}</dd>
              </div>
              <div>
                <dt>配色</dt>
                <dd>{prompt.palette.join("、") || "未指定"}</dd>
              </div>
              <div>
                <dt>材质</dt>
                <dd>{prompt.materials.join("、") || "未指定"}</dd>
              </div>
              <div>
                <dt>细节</dt>
                <dd>{prompt.details.join("、") || "未指定"}</dd>
              </div>
            </dl>
            {sourceLinks(prompt.sourceIndexes)}
          </div>
        ))}
      </section>
      <section aria-label="研究来源">
        <h3>研究来源</h3>
        {sources.length ? (
          <ol className={styles.sources}>
            {sources.map((source) => {
              const label = sourceLabel(source);
              return (
                <li key={source.index}>
                  {sourceLinks([source.index])}
                  {source.siteName && source.siteName !== label && (
                    <span className={styles.muted}>{source.siteName}</span>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className={styles.empty}>暂无公开来源</p>
        )}
      </section>
    </article>
  );
}
