import type { InspirationDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import { EvidenceFigure } from "./inspiration-hero-evidence";
import styles from "./inspiration.module.css";

export function InspirationProductReferences({
  products,
}: {
  products: InspirationDocumentDto["products"];
}) {
  return (
    <section className={styles.documentSection} aria-label="商品参考">
      <h3>商品参考</h3>
      {products.length ? (
        <div className={styles.productGrid}>
          {products.map((asset) => (
            <EvidenceFigure key={asset.id} asset={asset} product />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>暂无商品图片参考</p>
      )}
    </section>
  );
}
