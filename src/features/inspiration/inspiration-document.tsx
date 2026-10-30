import type { ReactNode } from "react";
import type { InspirationDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import { InspirationHeroEvidence } from "./inspiration-hero-evidence";
import {
  DocumentSourceLinks,
  InspirationSignalSection,
} from "./inspiration-signal-section";
import { InspirationDimensionSections } from "./inspiration-dimension-sections";
import { InspirationProductReferences } from "./inspiration-product-references";
import { InspirationDirectionSection } from "./inspiration-direction-section";
import styles from "./inspiration.module.css";

export function InspirationDocument({
  document,
  title,
  prompt,
  headerActions,
}: {
  document: InspirationDocumentDto;
  title: string;
  prompt: string;
  headerActions?: ReactNode;
}) {
  return (
    <article className={styles.document} aria-label={title}>
      <header className={styles.documentHeader}>
        <div className={styles.detailHeader}>
          <div>
            <p className={styles.sectionKicker}>RESEARCH REPORT</p>
            <h2 className={styles.recordTitle}>{title}</h2>
          </div>
          {headerActions}
        </div>
        <p className={styles.originalPrompt}>{prompt}</p>
      </header>
      <InspirationHeroEvidence asset={document.hero} />
      <section className={styles.documentIntro} aria-label="研究结论">
        <h2>{document.intro.headline}</h2>
        <p>{document.intro.summary}</p>
        <p className={styles.confidenceNote}>{document.intro.confidenceNote}</p>
      </section>
      <InspirationSignalSection
        signals={document.marketSignals}
        sources={document.sources}
      />
      <InspirationDimensionSections
        dimensions={document.dimensions}
        sources={document.sources}
      />
      <InspirationProductReferences products={document.products} />
      <InspirationDirectionSection
        directions={document.directions}
        unassignedLibraryMatches={document.unassignedLibraryMatches}
        sources={document.sources}
      />
      <section className={styles.documentSection} aria-label="研究来源">
        <h3>研究来源</h3>
        {document.sources.length ? (
          <ol className={styles.documentSources}>
            {document.sources.map((source) => (
              <li key={source.index}>
                <DocumentSourceLinks
                  indexes={[source.index]}
                  sources={document.sources}
                />
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.empty}>暂无公开来源</p>
        )}
      </section>
    </article>
  );
}
