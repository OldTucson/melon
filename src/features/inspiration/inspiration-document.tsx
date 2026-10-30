import type { ReactNode } from "react";
import type { InspirationDocumentDto, PublicInspirationDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import { InspirationHeroEvidence } from "./inspiration-hero-evidence";
import {
  DocumentSourceLinks,
  InspirationSignalSection,
} from "./inspiration-signal-section";
import { InspirationDimensionSections } from "./inspiration-dimension-sections";
import { InspirationProductReferences } from "./inspiration-product-references";
import { InspirationDirectionSection } from "./inspiration-direction-section";
import styles from "./inspiration.module.css";

type InspirationDocumentProps = {
  title: string;
  prompt: string;
  completedAt?: string | null;
} & (
  | { mode?: "private"; document: InspirationDocumentDto; headerActions?: ReactNode; initialEnrichment?: boolean }
  | { mode: "public"; document: PublicInspirationDocumentDto; headerActions?: never }
);

export function InspirationDocument(props: InspirationDocumentProps) {
  const { document, title, prompt } = props;
  const Title = props.mode === "public" ? "h1" : "h2";
  const initialEnrichment = props.mode !== "public" && props.initialEnrichment === true;
  const visualCount = (document.hero ? 1 : 0)
    + document.marketSignals.reduce((count, { evidence }) => count + evidence.length, 0)
    + document.products.length
    + document.directions.reduce((count, { libraryMatches, concepts }) => count + libraryMatches.length + concepts.length, 0)
    + document.unassignedLibraryMatches.length;
  return (
    <article className={styles.document} aria-label={title}>
      <header className={styles.documentHeader}>
        <div className={styles.detailHeader}>
          <div>
            <p className={styles.sectionKicker}>RESEARCH REPORT</p>
            <Title className={styles.recordTitle}>{title}</Title>
          </div>
          {props.mode !== "public" && props.headerActions}
        </div>
        <p className={styles.originalPrompt}>{prompt}</p>
        {props.completedAt && (
          <p className={styles.muted}>
            完成于 <time dateTime={props.completedAt}>{props.completedAt.slice(0, 10)}</time>
          </p>
        )}
        <p className={styles.muted}>{document.sources.length} 个来源 · {visualCount} 张视觉素材</p>
        {props.mode === "public" && (
          <>
            <p className={styles.originalPrompt}>
              基于公开网络热销信号，不代表电商平台官方销量
            </p>
          </>
        )}
      </header>
      <InspirationHeroEvidence asset={document.hero} loading={initialEnrichment} />
      <section className={styles.documentIntro} aria-label="研究结论">
        <h2>{document.intro.headline}</h2>
        <p>{document.intro.summary}</p>
        <p className={styles.confidenceNote}>{document.intro.confidenceNote}</p>
      </section>
      <InspirationSignalSection
        signals={document.marketSignals}
        sources={document.sources}
        loading={initialEnrichment}
      />
      <InspirationDimensionSections
        dimensions={document.dimensions}
        sources={document.sources}
      />
      <InspirationProductReferences products={document.products} loading={initialEnrichment} />
      <InspirationDirectionSection
        {...(props.mode === "public"
          ? { mode: "public" as const, directions: props.document.directions, sources: props.document.sources }
          : { mode: "private" as const, directions: props.document.directions, unassignedLibraryMatches: props.document.unassignedLibraryMatches, sources: props.document.sources, loading: initialEnrichment })}
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
