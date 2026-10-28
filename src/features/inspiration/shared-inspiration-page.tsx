import type { InspirationSharedDto } from "./contracts";
import { InspirationResult } from "./inspiration-result";
import styles from "./inspiration.module.css";

export function SharedInspirationPage({
  analysis,
}: {
  analysis: InspirationSharedDto;
}) {
  return (
    <main className={`${styles.workspace} ${styles.sharedReport}`}>
      <header className={styles.pageHeader}>
        <h1>{analysis.title}</h1>
        <p className={styles.originalPrompt}>{analysis.prompt}</p>
        <p className={styles.muted}>
          完成于{" "}
          <time dateTime={analysis.completedAt}>
            {analysis.completedAt.slice(0, 10)}
          </time>
        </p>
        <p className={styles.originalPrompt}>
          基于公开网络热销信号，不代表电商平台官方销量
        </p>
      </header>
      <InspirationResult result={analysis.result} sources={analysis.sources} />
    </main>
  );
}
