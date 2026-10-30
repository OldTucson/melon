import type { InspirationDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import type { InspirationSource } from "./contracts";
import {
  DocumentSourceLinks,
  signalStrengths,
} from "./inspiration-signal-section";
import styles from "./inspiration.module.css";

export function InspirationDimensionSections({
  dimensions,
  sources,
}: {
  dimensions: InspirationDocumentDto["dimensions"];
  sources: InspirationSource[];
}) {
  return dimensions.map(({ key, label, items }) => (
    <section className={styles.documentSection} aria-label={label} key={key}>
      <h3>{label}</h3>
      {items.length ? (
        <ul className={styles.facets}>
          {items.map((item, index) => (
            <li key={index}>
              <div className={styles.facetTitle}>
                {"colorHint" in item && typeof item.colorHint === "string" && (
                  <span
                    className={styles.swatch}
                    aria-label={`${item.name} ${item.colorHint}`}
                    style={{ backgroundColor: item.colorHint }}
                  />
                )}
                <strong>{item.name}</strong>
                <span className={styles.signal}>
                  {signalStrengths[item.strength]}
                </span>
              </div>
              <p>{item.rationale}</p>
              <DocumentSourceLinks
                indexes={item.sourceIndexes}
                sources={sources}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>暂无该维度的趋势</p>
      )}
    </section>
  ));
}
