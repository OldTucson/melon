import type { InspirationDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import { EvidenceFigure, EvidenceLoadingFigure } from "./inspiration-hero-evidence";
import styles from "./inspiration.module.css";

export function InspirationProductReferences({
  products,
  loading = false,
}: {
  products: InspirationDocumentDto["products"];
  loading?: boolean;
}) {
  return (
    <section className={styles.documentSection} aria-label="商品参考">
      <h3>商品参考</h3>
      {products.length || loading ? (
        <div className={styles.productGrid}>
          {products.map((asset) => (
            <EvidenceFigure key={asset.id} asset={asset} product />
          ))}
          {loading && products.length === 0 && Array.from({ length: 4 }, (_, index) => (
            <EvidenceLoadingFigure key={index} label="商品参考正在加载" product />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>暂无商品图片参考</p>
      )}
    </section>
  );
}
