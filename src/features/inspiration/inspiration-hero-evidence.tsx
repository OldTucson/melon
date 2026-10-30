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
    <figure className={styles.evidenceFigure} data-product={product}>
      <InspirationEvidenceDialog asset={asset}>
        <EvidenceImage asset={asset} eager={eager} editorial />
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

export function EvidenceLoadingFigure({ label, product = false }: { label: string; product?: boolean }) {
  return (
    <figure className={styles.evidenceFigure} data-product={product}>
      <span className={styles.evidenceMedia} style={{ aspectRatio: "4 / 3" }} role="status" aria-label={label} aria-busy="true">
        <span className={styles.imageFallback}>{label}</span>
      </span>
      <figcaption className={styles.evidenceCaption} aria-hidden="true" />
    </figure>
  );
}

export function InspirationHeroEvidence({
  asset,
  loading = false,
}: {
  asset: WebEvidenceAssetDto | null;
  loading?: boolean;
}) {
  if (!asset && !loading) return null;
  return (
    <section className={styles.heroEvidence} aria-label="主视觉">
      {asset ? <EvidenceFigure asset={asset} eager /> : <EvidenceLoadingFigure label="主视觉正在加载" />}
    </section>
  );
}
