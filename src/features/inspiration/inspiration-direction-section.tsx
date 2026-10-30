import type { InspirationDocumentDto, PublicInspirationDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import type { LibraryMatchAssetDto } from "@/features/inspiration-visuals/contracts";
import type { InspirationSource } from "./contracts";
import { EvidenceImage } from "./inspiration-evidence-dialog";
import { DocumentSourceLinks } from "./inspiration-signal-section";
import styles from "./inspiration.module.css";

function PrivateMatches({ matches }: { matches: LibraryMatchAssetDto[] }) {
  if (!matches.length) return null;
  return (
    <div className={styles.privateMatches}>
      <p className={styles.sectionKicker}>素材库色彩匹配 · 仅自己可见</p>
      <ul className={styles.privateMatchList}>
        {matches.map((asset) => (
          <li key={asset.id}>
            <a href={asset.libraryHref} className={styles.privateMatch}>
              <EvidenceImage asset={{ ...asset, width: 800, height: 600 }} />
              <span>{asset.title}</span>
            </a>
            <span className={styles.directionPalette}>
              {asset.palette.map((color) => (
                <span key={color}>
                  <span
                    className={styles.miniSwatch}
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                  />
                  {color}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type DirectionSectionProps = { sources: InspirationSource[] } & (
  | { mode?: "private"; directions: InspirationDocumentDto["directions"]; unassignedLibraryMatches: LibraryMatchAssetDto[] }
  | { mode: "public"; directions: PublicInspirationDocumentDto["directions"] }
);

export function InspirationDirectionSection(props: DirectionSectionProps) {
  const { directions, sources } = props;
  return (
    <>
      <section className={styles.documentSection} aria-label="设计灵感">
        <h3>设计灵感 · 设计推演</h3>
        {directions.map(({ direction, concepts }, index) => (
          <section
            className={styles.editorialDirection}
            aria-label={direction.title}
            key={index}
          >
            <p className={styles.sectionKicker}>
              方向 {String(index + 1).padStart(2, "0")}
            </p>
            <h4>{direction.title}</h4>
            <p>{direction.direction}</p>
            <dl className={styles.directionDetails}>
              <div>
                <dt>廓形</dt>
                <dd>{direction.silhouette}</dd>
              </div>
              <div>
                <dt>配色</dt>
                <dd className={styles.directionPalette}>
                  {direction.palette.map((color) => (
                    <span key={color}>
                      {/^#[\dA-F]{6}$/i.test(color) && (
                        <span
                          className={styles.miniSwatch}
                          style={{ backgroundColor: color }}
                          aria-hidden="true"
                        />
                      )}
                      {color}
                    </span>
                  ))}
                </dd>
              </div>
              <div>
                <dt>材质</dt>
                <dd>{direction.materials.join("、") || "未指定"}</dd>
              </div>
              <div>
                <dt>细节</dt>
                <dd>{direction.details.join("、") || "未指定"}</dd>
              </div>
            </dl>
            <DocumentSourceLinks
              indexes={direction.sourceIndexes}
              sources={sources}
            />
            {concepts.length > 0 && (
              <div className={styles.conceptGrid}>
                {concepts.map((asset, conceptIndex) => (
                  <figure className={styles.evidenceFigure} key={asset.id}>
                    <EvidenceImage asset={asset} />
                    <figcaption className={styles.evidenceCaption}>
                      <strong>{asset.title}</strong>
                      <span className={styles.muted}>AI 生成 · 设计推演</span>
                      {props.mode !== "public" && props.directions[index]!.concepts[conceptIndex]!.libraryHref && (
                        <a href={props.directions[index]!.concepts[conceptIndex]!.libraryHref!}>查看已保存素材</a>
                      )}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
            {props.mode !== "public" && <PrivateMatches matches={props.directions[index]!.libraryMatches} />}
          </section>
        ))}
      </section>
      {props.mode !== "public" && props.unassignedLibraryMatches.length > 0 && (
        <section className={styles.documentSection} aria-label="私有素材补充">
          <h3>私有素材补充</h3>
          <PrivateMatches matches={props.unassignedLibraryMatches} />
        </section>
      )}
    </>
  );
}
