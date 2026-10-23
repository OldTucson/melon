import type { ReactNode } from "react";
import Link from "next/link";

import type { PublicLegalConfig } from "@/features/legal/legal-config";
import { LegalLinks } from "@/features/legal/legal-links";

type LegalPageProps = {
  title: string;
  effectiveDate?: string;
  config: PublicLegalConfig;
  children: ReactNode;
};

export function LegalPage({
  title,
  effectiveDate,
  config,
  children,
}: LegalPageProps) {
  return (
    <div className="legal-page">
      <header className="legal-page-header">
        <Link className="wordmark" href="/login">
          melon
        </Link>
      </header>

      <main className="legal-content">
        <header className="legal-content-header">
          <h1>{title}</h1>
          {effectiveDate ? (
            <p>
              生效日期：<time dateTime={effectiveDate}>{effectiveDate}</time>
            </p>
          ) : null}
        </header>
        {children}
      </main>

      <footer className="legal-page-footer">
        <LegalLinks config={config} />
      </footer>
    </div>
  );
}
