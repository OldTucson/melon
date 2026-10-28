import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

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
        <Link aria-label="返回登录" className="legal-back-link" href="/login">
          <ArrowLeft aria-hidden="true" />
          <span className="wordmark">melon</span>
        </Link>
      </header>

      <main aria-labelledby="legal-page-title" className="legal-content">
        <header className="legal-content-header">
          <h1 id="legal-page-title">{title}</h1>
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
