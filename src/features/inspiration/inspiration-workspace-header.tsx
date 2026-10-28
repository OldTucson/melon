import type { ReactNode } from "react";

import styles from "./inspiration.module.css";

export function InspirationWorkspaceHeader({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <header className={styles.workspaceHeader}>
      <h1 id="inspiration-title">灵感调研</h1>
      <div className={styles.workspaceActions}>{children}</div>
    </header>
  );
}
