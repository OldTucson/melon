import type { WebEvidenceAssetDto } from "@/features/inspiration-visuals/contracts";
import {
  EvidenceImage,
  InspirationEvidenceDialog,
  OriginalPageLink,
} from "./inspiration-evidence-dialog";
import styles from "./inspiration.module.css";

export function EvidenceFigure({
  asset,
  eager = false,
  product = false,
}: {
  asset: WebEvidenceAssetDto;
  eager?: boolean;
  product?: boolean;
}) {
  return (
    <figure className={styles.evidenceFigure}>
      <InspirationEvidenceDialog asset={asset}>
        <EvidenceImage asset={asset} eager={eager} />
      </InspirationEvidenceDialog>
      <figcaption className={styles.evidenceCaption}>
        <strong>
          {product ? (asset.productName ?? asset.title) : asset.title}
        </strong>
        <span className={styles.muted}>{asset.sourceSiteName}</span>
        <OriginalPageLink asset={asset} />
        {product && (
          <>
            <a
              href={asset.sourcePageUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {asset.brand ?? asset.sourceSiteName} · 查看商品
            </a>
            {asset.priceText !== null && <span>{asset.priceText}</span>}
          </>
        )}
      </figcaption>
    </figure>
  );
}

export function InspirationHeroEvidence({
  asset,
}: {
  asset: WebEvidenceAssetDto | null;
}) {
  if (!asset) return null;
  return (
    <section className={styles.heroEvidence} aria-label="主视觉">
      <EvidenceFigure asset={asset} eager />
    </section>
  );
}
