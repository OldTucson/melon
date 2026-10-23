import { describe, expect, it } from "vitest";

import { parseServerEnv } from "./server";

const validEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://melon:melon@localhost:55432/melon_test",
  AUTH_SECRET: "a".repeat(32),
  APP_ORIGIN: "http://localhost:3000",
  ALIYUN_OSS_REGION: "oss-cn-hangzhou",
  ALIYUN_OSS_BUCKET: "melon-test-assets",
  ALIYUN_OSS_ENDPOINT: "https://assets.example.test",
  ALIYUN_OSS_CNAME: "true",
  ALIYUN_STS_ROLE_ARN:
    "acs:ram::123456789012:role/melon-browser-upload",
};

const enabledImageSearchEnv = {
  IMAGE_SEARCH_ENABLED: "true",
  IMAGE_SEARCH_SERVICE_URL: "http://127.0.0.1:8091",
  IMAGE_SEARCH_INTERNAL_TOKEN: "x".repeat(32),
  IMAGE_SEARCH_ACTIVE_VERSION: "visual-search-v1",
  IMAGE_SEARCH_MODEL_SHA256: "a".repeat(64),
};

describe("parseServerEnv", () => {
  it("parses a valid server environment", () => {
    expect(parseServerEnv(validEnv).ALIYUN_OSS_CNAME).toBe(true);
  });

  it("defaults proxy trust to disabled", () => {
    expect(parseServerEnv(validEnv).AUTH_TRUST_PROXY).toBe(false);
  });

  it("enables proxy trust only for the literal true value", () => {
    expect(
      parseServerEnv({ ...validEnv, AUTH_TRUST_PROXY: "true" })
        .AUTH_TRUST_PROXY,
    ).toBe(true);
    expect(() =>
      parseServerEnv({ ...validEnv, AUTH_TRUST_PROXY: "1" }),
    ).toThrow();
  });

  it("parses optional public legal metadata", () => {
    const parsed = parseServerEnv({
      ...validEnv,
      SITE_OPERATOR_NAME: "  Melon Studio  ",
      SITE_CONTACT_EMAIL: "privacy@example.test",
      SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
      ICP_FILING_NUMBER: "  浙ICP备00000000号-1  ",
    });

    expect(parsed.SITE_OPERATOR_NAME).toBe("Melon Studio");
    expect(parsed.SITE_CONTACT_EMAIL).toBe("privacy@example.test");
    expect(parsed.ICP_FILING_NUMBER).toBe("浙ICP备00000000号-1");
  });

  it("requires the public-security number and URL together", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        PUBLIC_SECURITY_FILING_NUMBER: "浙公网安备 00000000000000号",
      }),
    ).toThrow(/together/i);
    expect(() =>
      parseServerEnv({
        ...validEnv,
        PUBLIC_SECURITY_FILING_URL:
          "https://www.beian.gov.cn/portal/registerSystemInfo",
      }),
    ).toThrow(/together/i);
  });

  it.each([
    ["invalid email", { SITE_CONTACT_EMAIL: "not-an-email" }],
    ["non-ISO date", { SITE_LEGAL_EFFECTIVE_DATE: "2026/10/23" }],
    ["invalid calendar date", { SITE_LEGAL_EFFECTIVE_DATE: "2026-02-30" }],
    [
      "non-HTTPS filing URL",
      {
        PUBLIC_SECURITY_FILING_NUMBER: "浙公网安备 00000000000000号",
        PUBLIC_SECURITY_FILING_URL:
          "http://www.beian.gov.cn/portal/registerSystemInfo",
      },
    ],
  ])("rejects invalid public legal metadata: %s", (_name, values) => {
    expect(() => parseServerEnv({ ...validEnv, ...values })).toThrow();
  });

  it("normalizes blank optional legal metadata to undefined", () => {
    const parsed = parseServerEnv({
      ...validEnv,
      SITE_OPERATOR_NAME: "   ",
      SITE_CONTACT_EMAIL: "",
      ICP_FILING_NUMBER: "  ",
    });

    expect(parsed.SITE_OPERATOR_NAME).toBeUndefined();
    expect(parsed.SITE_CONTACT_EMAIL).toBeUndefined();
    expect(parsed.ICP_FILING_NUMBER).toBeUndefined();
  });

  it.each([
    "not-a-url",
    "http://assets.example.test",
    "https://@assets.example.test",
    "https://:@assets.example.test",
    "https://user:secret@assets.example.test",
    "https://assets.example.test/objects",
    "https://assets.example.test/a/..",
    "https://assets.example.test/%2e",
    "https://assets.example.test?",
    "https://assets.example.test?mode=unsafe",
    "https://assets.example.test#",
    "https://assets.example.test#fragment",
    "https://[::1]",
    "https://[2001:db8::1]:8443",
    "https://assets.example.test:0",
    "https://assets.example.test:65536",
  ])("rejects non-origin OSS endpoint %s", (ALIYUN_OSS_ENDPOINT) => {
    expect(() =>
      parseServerEnv({ ...validEnv, ALIYUN_OSS_ENDPOINT }),
    ).toThrow(/HTTPS origin/i);
  });

  it.each([
    "https://assets.example.test",
    "https://assets.example.test:1",
    "https://assets.example.test:65535",
  ])("accepts hostname OSS origin %s", (ALIYUN_OSS_ENDPOINT) => {
    expect(
      parseServerEnv({ ...validEnv, ALIYUN_OSS_ENDPOINT })
        .ALIYUN_OSS_ENDPOINT,
    ).toBe(ALIYUN_OSS_ENDPOINT);
  });

  it("rejects an authentication secret shorter than 32 characters", () => {
    expect(() =>
      parseServerEnv({ ...validEnv, AUTH_SECRET: "short" }),
    ).toThrow();
  });

  it("rejects an incomplete AccessKey pair", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        ALIBABA_CLOUD_ACCESS_KEY_ID: "id-only",
      }),
    ).toThrow(/provided together/);
  });

  it("normalizes a blank AccessKey pair to undefined", () => {
    const parsed = parseServerEnv({
      ...validEnv,
      ALIBABA_CLOUD_ACCESS_KEY_ID: "",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "",
    });

    expect(parsed.ALIBABA_CLOUD_ACCESS_KEY_ID).toBeUndefined();
    expect(parsed.ALIBABA_CLOUD_ACCESS_KEY_SECRET).toBeUndefined();
  });

  it("rejects a nonblank AccessKey paired with a blank secret", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        ALIBABA_CLOUD_ACCESS_KEY_ID: "id-only",
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: "   ",
      }),
    ).toThrow(/provided together/);
  });

  it("accepts a complete AccessKey pair", () => {
    const parsed = parseServerEnv({
      ...validEnv,
      ALIBABA_CLOUD_ACCESS_KEY_ID: "test-access-key-id",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "test-access-key-secret",
    });

    expect(parsed.ALIBABA_CLOUD_ACCESS_KEY_ID).toBe("test-access-key-id");
    expect(parsed.ALIBABA_CLOUD_ACCESS_KEY_SECRET).toBe(
      "test-access-key-secret",
    );
  });

  it("preserves nonblank AccessKey values exactly", () => {
    const parsed = parseServerEnv({
      ...validEnv,
      ALIBABA_CLOUD_ACCESS_KEY_ID: "  test-access-key-id  ",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "  test-access-key-secret  ",
    });

    expect(parsed.ALIBABA_CLOUD_ACCESS_KEY_ID).toBe(
      "  test-access-key-id  ",
    );
    expect(parsed.ALIBABA_CLOUD_ACCESS_KEY_SECRET).toBe(
      "  test-access-key-secret  ",
    );
  });

  it("accepts the fake OSS adapter in tests", () => {
    expect(parseServerEnv({ ...validEnv, OSS_ADAPTER: "fake" }).OSS_ADAPTER).toBe(
      "fake",
    );
  });

  it.each(["development", "production"] as const)(
    "rejects the fake OSS adapter in %s",
    (NODE_ENV) => {
      expect(() =>
        parseServerEnv({ ...validEnv, NODE_ENV, OSS_ADAPTER: "fake" }),
      ).toThrow(/test-only/);
    },
  );

  it("requires the complete image-search configuration when enabled", () => {
    expect(() =>
      parseServerEnv({ ...validEnv, IMAGE_SEARCH_ENABLED: "true" }),
    ).toThrow();

    const parsed = parseServerEnv({
      ...validEnv,
      ...enabledImageSearchEnv,
    });

    expect(parsed.IMAGE_SEARCH_ENABLED).toBe(true);
  });

  it.each([
    "https://127.0.0.1:8091",
    "http://visual-search:8091",
  ])("rejects a non-loopback HTTP origin in production: %s", (url) => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        ...enabledImageSearchEnv,
        NODE_ENV: "production",
        IMAGE_SEARCH_SERVICE_URL: url,
      }),
    ).toThrow(/loopback/i);
  });

  it.each([
    "ftp://127.0.0.1:8091",
    "http://user:secret@127.0.0.1:8091",
    "http://127.0.0.1:8091/internal",
    "http://127.0.0.1:8091?unsafe=true",
    "http://127.0.0.1:8091#fragment",
  ])("requires an HTTP(S) origin in every environment: %s", (url) => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        ...enabledImageSearchEnv,
        IMAGE_SEARCH_SERVICE_URL: url,
      }),
    ).toThrow(/origin/i);
  });

  it("accepts a non-loopback HTTPS origin outside production", () => {
    expect(
      parseServerEnv({
        ...validEnv,
        ...enabledImageSearchEnv,
        IMAGE_SEARCH_SERVICE_URL: "https://visual-search.example.test:8443",
      }).IMAGE_SEARCH_SERVICE_URL,
    ).toBe("https://visual-search.example.test:8443");
  });

  it.each(["Visual-search-v1", "visual_search_v1", "x".repeat(65)])(
    "rejects an invalid image-search version: %s",
    (version) => {
      expect(() =>
        parseServerEnv({
          ...validEnv,
          ...enabledImageSearchEnv,
          IMAGE_SEARCH_ACTIVE_VERSION: version,
        }),
      ).toThrow();
    },
  );

  it("requires a lowercase SHA-256 model checksum", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        ...enabledImageSearchEnv,
        IMAGE_SEARCH_MODEL_SHA256: "A".repeat(64),
      }),
    ).toThrow(/SHA-256/i);
  });

  it.each([" ".repeat(32), "x".repeat(31), `${"x".repeat(31)}\u00e9`])(
    "rejects a non-ASCII, blank, or short internal token",
    (token) => {
      expect(() =>
        parseServerEnv({
          ...validEnv,
          ...enabledImageSearchEnv,
          IMAGE_SEARCH_INTERNAL_TOKEN: token,
        }),
      ).toThrow(/token/i);
    },
  );
});
