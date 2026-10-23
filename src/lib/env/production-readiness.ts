import type { ServerEnv } from "@/lib/env/server";

export type ProductionReadinessError =
  | "NODE_ENV_PRODUCTION_REQUIRED"
  | "APP_ORIGIN_HTTPS_REQUIRED"
  | "APP_ORIGIN_INVALID"
  | "PRODUCTION_DATABASE_REQUIRED"
  | "AUTH_SECRET_PLACEHOLDER"
  | "TRUSTED_PROXY_REQUIRED"
  | "REAL_OSS_REQUIRED"
  | "LONG_TERM_ACCESS_KEY_FORBIDDEN"
  | "SITE_OPERATOR_REQUIRED"
  | "SITE_CONTACT_REQUIRED"
  | "LEGAL_EFFECTIVE_DATE_REQUIRED"
  | "PUBLIC_SECURITY_FILING_INCOMPLETE"
  | "IMAGE_SEARCH_RELEASE_NOT_APPROVED";

const placeholderPattern =
  /(?:change[-_ ]?me|example|placeholder|replace[-_ ]?with|sample|test[-_ ]?only)/i;

function isProductionDatabase(databaseUrl: string) {
  try {
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname)
      .replace(/^\/+/, "")
      .toLowerCase();
    return (
      databaseName.length > 0 &&
      !/(?:_test|_e2e|_performance_test)$/.test(databaseName)
    );
  } catch {
    return false;
  }
}

function isRealOssConfiguration(env: ServerEnv) {
  if (env.OSS_ADAPTER !== "real") return false;

  try {
    const endpoint = new URL(env.ALIYUN_OSS_ENDPOINT);
    return !(
      endpoint.hostname.endsWith(".example.test") ||
      placeholderPattern.test(env.ALIYUN_OSS_BUCKET) ||
      placeholderPattern.test(env.ALIYUN_STS_ROLE_ARN)
    );
  } catch {
    return false;
  }
}

export function validateProductionReadiness(
  env: ServerEnv,
): ProductionReadinessError[] {
  const errors: ProductionReadinessError[] = [];

  if (env.NODE_ENV !== "production") {
    errors.push("NODE_ENV_PRODUCTION_REQUIRED");
  }

  try {
    const appOrigin = new URL(env.APP_ORIGIN);
    if (appOrigin.origin !== env.APP_ORIGIN) {
      errors.push("APP_ORIGIN_INVALID");
    }
    if (appOrigin.protocol !== "https:") {
      errors.push("APP_ORIGIN_HTTPS_REQUIRED");
    }
  } catch {
    errors.push("APP_ORIGIN_INVALID");
  }

  if (!isProductionDatabase(env.DATABASE_URL)) {
    errors.push("PRODUCTION_DATABASE_REQUIRED");
  }

  if (
    placeholderPattern.test(env.AUTH_SECRET) ||
    /^(.)\1+$/.test(env.AUTH_SECRET)
  ) {
    errors.push("AUTH_SECRET_PLACEHOLDER");
  }

  if (!env.AUTH_TRUST_PROXY) {
    errors.push("TRUSTED_PROXY_REQUIRED");
  }

  if (!isRealOssConfiguration(env)) {
    errors.push("REAL_OSS_REQUIRED");
  }

  if (
    env.ALIBABA_CLOUD_ACCESS_KEY_ID ||
    env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  ) {
    errors.push("LONG_TERM_ACCESS_KEY_FORBIDDEN");
  }

  if (!env.SITE_OPERATOR_NAME) errors.push("SITE_OPERATOR_REQUIRED");
  if (!env.SITE_CONTACT_EMAIL) errors.push("SITE_CONTACT_REQUIRED");
  if (!env.SITE_LEGAL_EFFECTIVE_DATE) {
    errors.push("LEGAL_EFFECTIVE_DATE_REQUIRED");
  }

  if (
    Boolean(env.PUBLIC_SECURITY_FILING_NUMBER) !==
    Boolean(env.PUBLIC_SECURITY_FILING_URL)
  ) {
    errors.push("PUBLIC_SECURITY_FILING_INCOMPLETE");
  }

  if (env.IMAGE_SEARCH_ENABLED && !env.IMAGE_SEARCH_RELEASE_APPROVED) {
    errors.push("IMAGE_SEARCH_RELEASE_NOT_APPROVED");
  }

  return errors;
}
