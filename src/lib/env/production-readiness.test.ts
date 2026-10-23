import { describe, expect, it } from "vitest";

import { parseServerEnv, type ServerEnv } from "./server";
import { validateProductionReadiness } from "./production-readiness";

const validProductionEnv = parseServerEnv({
  NODE_ENV: "production",
  DATABASE_URL: "postgres://melon:strong-password@db.internal/melon_prod",
  AUTH_SECRET: "prod-auth-2026-random-value-9f4a8d2c7b1e",
  AUTH_TRUST_PROXY: "true",
  APP_ORIGIN: "https://melon.example.cn",
  SITE_OPERATOR_NAME: "Melon Studio",
  SITE_CONTACT_EMAIL: "privacy@melon.example.cn",
  SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
  ALIYUN_OSS_REGION: "oss-cn-hangzhou",
  ALIYUN_OSS_BUCKET: "melon-prod-assets",
  ALIYUN_OSS_ENDPOINT: "https://assets.melon.example.cn",
  ALIYUN_OSS_CNAME: "true",
  ALIYUN_STS_ROLE_ARN: "acs:ram::123456789012:role/melon-browser-upload",
  OSS_ADAPTER: "real",
});

const withEnv = (patch: Partial<ServerEnv>): ServerEnv => ({
  ...validProductionEnv,
  ...patch,
});

describe("validateProductionReadiness", () => {
  it("accepts a complete production environment", () => {
    expect(validateProductionReadiness(validProductionEnv)).toEqual([]);
  });

  it.each([
    [
      "NODE_ENV_PRODUCTION_REQUIRED",
      { NODE_ENV: "development" as const },
    ],
    ["APP_ORIGIN_HTTPS_REQUIRED", { APP_ORIGIN: "http://melon.example.cn" }],
    ["APP_ORIGIN_INVALID", { APP_ORIGIN: "https://melon.example.cn/app" }],
    [
      "PRODUCTION_DATABASE_REQUIRED",
      {
        DATABASE_URL:
          "postgres://melon:strong-password@db.internal/melon%5Ftest",
      },
    ],
    [
      "AUTH_SECRET_PLACEHOLDER",
      { AUTH_SECRET: "replace-with-a-random-secret-at-least-32-characters" },
    ],
    ["TRUSTED_PROXY_REQUIRED", { AUTH_TRUST_PROXY: false }],
    ["REAL_OSS_REQUIRED", { OSS_ADAPTER: "fake" as const }],
    [
      "REAL_OSS_REQUIRED",
      { ALIYUN_OSS_ENDPOINT: "https://assets.example.test" },
    ],
    [
      "LONG_TERM_ACCESS_KEY_FORBIDDEN",
      {
        ALIBABA_CLOUD_ACCESS_KEY_ID: "long-term-id",
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: "long-term-secret",
      },
    ],
    ["SITE_OPERATOR_REQUIRED", { SITE_OPERATOR_NAME: undefined }],
    ["SITE_CONTACT_REQUIRED", { SITE_CONTACT_EMAIL: undefined }],
    [
      "LEGAL_EFFECTIVE_DATE_REQUIRED",
      { SITE_LEGAL_EFFECTIVE_DATE: undefined },
    ],
    [
      "PUBLIC_SECURITY_FILING_INCOMPLETE",
      {
        PUBLIC_SECURITY_FILING_NUMBER: "浙公网安备 00000000000000号",
        PUBLIC_SECURITY_FILING_URL: undefined,
      },
    ],
    [
      "IMAGE_SEARCH_RELEASE_NOT_APPROVED",
      {
        IMAGE_SEARCH_ENABLED: true,
        IMAGE_SEARCH_RELEASE_APPROVED: false,
        IMAGE_SEARCH_SERVICE_URL: "http://127.0.0.1:8091",
        IMAGE_SEARCH_INTERNAL_TOKEN: "x".repeat(32),
        IMAGE_SEARCH_ACTIVE_VERSION: "visual-search-v2",
        IMAGE_SEARCH_MODEL_SHA256: "a".repeat(64),
      },
    ],
  ] as const)("reports %s", (expected, patch) => {
    expect(validateProductionReadiness(withEnv(patch))).toContain(expected);
  });

  it.each(["melon_test", "melon_e2e", "melon_performance_test"])(
    "rejects the non-production database %s",
    (databaseName) => {
      expect(
        validateProductionReadiness(
          withEnv({
            DATABASE_URL: `postgres://melon:password@db.internal/${databaseName}`,
          }),
        ),
      ).toContain("PRODUCTION_DATABASE_REQUIRED");
    },
  );
});
