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

describe("parseServerEnv", () => {
  it("parses a valid server environment", () => {
    expect(parseServerEnv(validEnv).ALIYUN_OSS_CNAME).toBe(true);
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
  ])("rejects non-origin OSS endpoint %s", (ALIYUN_OSS_ENDPOINT) => {
    expect(() =>
      parseServerEnv({ ...validEnv, ALIYUN_OSS_ENDPOINT }),
    ).toThrow(/HTTPS origin/i);
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
});
