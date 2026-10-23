import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env/server";
import { toPublicLegalConfig } from "./legal-config";

const env = parseServerEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://melon:melon@localhost:55432/melon_test",
  AUTH_SECRET: "private-auth-secret".repeat(2),
  APP_ORIGIN: "http://localhost:3000",
  ALIYUN_OSS_REGION: "oss-cn-hangzhou",
  ALIYUN_OSS_BUCKET: "melon-test-assets",
  ALIYUN_OSS_ENDPOINT: "https://assets.example.test",
  ALIYUN_OSS_CNAME: "true",
  ALIYUN_STS_ROLE_ARN:
    "acs:ram::123456789012:role/melon-browser-upload",
  SITE_OPERATOR_NAME: "Melon Studio",
  SITE_CONTACT_EMAIL: "privacy@example.test",
  SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
  ICP_FILING_NUMBER: "浙ICP备00000000号-1",
  PUBLIC_SECURITY_FILING_NUMBER: "浙公网安备 00000000000000号",
  PUBLIC_SECURITY_FILING_URL:
    "https://www.beian.gov.cn/portal/registerSystemInfo",
});

describe("toPublicLegalConfig", () => {
  it("returns only public legal metadata", () => {
    expect(toPublicLegalConfig(env)).toEqual({
      operatorName: "Melon Studio",
      contactEmail: "privacy@example.test",
      effectiveDate: "2026-10-23",
      icpFilingNumber: "浙ICP备00000000号-1",
      publicSecurityFiling: {
        number: "浙公网安备 00000000000000号",
        url: "https://www.beian.gov.cn/portal/registerSystemInfo",
      },
    });
    expect(toPublicLegalConfig(env)).not.toHaveProperty("AUTH_SECRET");
    expect(toPublicLegalConfig(env)).not.toHaveProperty("DATABASE_URL");
    expect(toPublicLegalConfig(env)).not.toHaveProperty(
      "IMAGE_SEARCH_INTERNAL_TOKEN",
    );
  });
});
