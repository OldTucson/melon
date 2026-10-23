import Link from "next/link";

import type { PublicLegalConfig } from "@/features/legal/legal-config";

type LegalLinksProps = {
  config: PublicLegalConfig;
  className?: string;
};

export function LegalLinks({ config, className }: LegalLinksProps) {
  const classes = ["legal-links", className].filter(Boolean).join(" ");
  const hasMetadata = Boolean(
    config.operatorName ||
      config.contactEmail ||
      config.icpFilingNumber ||
      config.publicSecurityFiling,
  );

  return (
    <div className={classes}>
      <nav aria-label="法律文件" className="legal-links-nav">
        <Link href="/privacy">隐私政策</Link>
        <Link href="/terms">服务协议</Link>
      </nav>

      {hasMetadata ? (
        <div className="legal-links-meta">
          {config.operatorName ? (
            <span className="legal-links-detail">
              <span>运营者</span>
              <span>{config.operatorName}</span>
            </span>
          ) : null}
          {config.contactEmail ? (
            <span className="legal-links-detail">
              <span>联系邮箱</span>
              <a href={`mailto:${config.contactEmail}`}>
                {config.contactEmail}
              </a>
            </span>
          ) : null}
          {config.icpFilingNumber ? (
            <a
              href="https://beian.miit.gov.cn/"
              rel="noreferrer"
              target="_blank"
            >
              {config.icpFilingNumber}
            </a>
          ) : null}
          {config.publicSecurityFiling ? (
            <a
              href={config.publicSecurityFiling.url}
              rel="noreferrer"
              target="_blank"
            >
              {config.publicSecurityFiling.number}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
