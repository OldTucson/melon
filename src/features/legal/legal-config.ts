import "server-only";

import type { ServerEnv } from "@/lib/env/server";

export type PublicLegalConfig = {
  operatorName?: string;
  contactEmail?: string;
  effectiveDate?: string;
  icpFilingNumber?: string;
  publicSecurityFiling?: {
    number: string;
    url: string;
  };
};

export const toPublicLegalConfig = (env: ServerEnv): PublicLegalConfig => ({
  operatorName: env.SITE_OPERATOR_NAME,
  contactEmail: env.SITE_CONTACT_EMAIL,
  effectiveDate: env.SITE_LEGAL_EFFECTIVE_DATE,
  icpFilingNumber: env.ICP_FILING_NUMBER,
  publicSecurityFiling:
    env.PUBLIC_SECURITY_FILING_NUMBER && env.PUBLIC_SECURITY_FILING_URL
      ? {
          number: env.PUBLIC_SECURITY_FILING_NUMBER,
          url: env.PUBLIC_SECURITY_FILING_URL,
        }
      : undefined,
});
