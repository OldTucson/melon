import type { InspirationSharedDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import { InspirationDocument } from "./inspiration-document";
import styles from "./inspiration.module.css";

export function SharedInspirationPage({ analysis }: { analysis: InspirationSharedDocumentDto }) {
  return (
    <main className={`${styles.workspace} ${styles.sharedReport}`}>
      <InspirationDocument
        mode="public"
        document={analysis.document}
        title={analysis.title}
        prompt={analysis.prompt}
        completedAt={analysis.completedAt}
      />
    </main>
  );
}
