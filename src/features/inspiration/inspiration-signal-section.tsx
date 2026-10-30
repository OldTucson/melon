import { ExternalLink } from "lucide-react";
import type { InspirationDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import type { InspirationSource } from "./contracts";
import { EvidenceFigure } from "./inspiration-hero-evidence";
import styles from "./inspiration.module.css";

export const signalStrengths = {
  high: "强信号",
  medium: "中等信号",
  emerging: "新兴信号",
};

export function sourceLabel(source: InspirationSource) {
  const title = source.title.trim();
  return /^[{[]/.test(title) && /[":{},\]]/.test(title)
    ? source.siteName?.trim() ||
        new URL(source.url).hostname.replace(/^www\./, "")
    : title;
}

export function DocumentSourceLinks({
  indexes,
  sources,
}: {
  indexes: number[];
  sources: InspirationSource[];
}) {
  return (
    <span className={styles.sourceLinks}>
      {sources
        .filter(({ index }) => indexes.includes(index))
        .map((source) => (
          <a
            href={source.url}
            key={source.index}
            target="_blank"
            rel="noopener noreferrer"
          >
            [{source.index}] {sourceLabel(source)}
            <ExternalLink aria-hidden="true" />
          </a>
        ))}
    </span>
  );
}

export function InspirationSignalSection({
  signals,
  sources,
}: {
  signals: InspirationDocumentDto["marketSignals"];
  sources: InspirationSource[];
}) {
  return (
    <section className={styles.documentSection} aria-label="市场信号">
      <h3>市场信号</h3>
      {signals.length ? (
        signals.map(({ signal, evidence }, index) => (
          <div
            className={styles.marketSignal}
            data-has-evidence={evidence.length > 0}
            key={index}
          >
            <div className={styles.signalText}>
              <span className={styles.sectionKicker}>
                信号 {String(index + 1).padStart(2, "0")} ·{" "}
                {signalStrengths[signal.strength]}
              </span>
              <h4>{signal.name}</h4>
              <p>{signal.rationale}</p>
              <DocumentSourceLinks
                indexes={signal.sourceIndexes}
                sources={sources}
              />
            </div>
            {evidence.length > 0 && (
              <div className={styles.signalEvidence}>
                {evidence.map((asset) => (
                  <EvidenceFigure key={asset.id} asset={asset} />
                ))}
              </div>
            )}
          </div>
        ))
      ) : (
        <p className={styles.empty}>暂无市场信号</p>
      )}
    </section>
  );
}
