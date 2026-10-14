import { defineConfig, devices } from "@playwright/test";

import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_METADATA_ONLY, E2E_PORT } from "./tests/e2e/environment";

export default defineConfig({
  testDir: "./tests/e2e",
  // Commercial fixtures contain metadata only; legacy uploads require real OSS.
  ...(E2E_METADATA_ONLY
    ? { testMatch: ["commercial-authorizations.spec.ts", "dashboard.spec.ts"] }
    : { testIgnore: ["commercial-authorizations.spec.ts", "dashboard.spec.ts"] }),
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    actionTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "webkit-desktop",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "webkit-1024",
      use: {
        browserName: "webkit",
        viewport: { width: 1024, height: 1366 },
      },
    },
  ],
  webServer: {
    command:
      `node --import tsx tests/e2e/prepare.ts && npm run dev -- --hostname 127.0.0.1 --port ${E2E_PORT}`,
    env: {
      ...process.env,
      APP_ORIGIN: E2E_BASE_URL,
      DATABASE_URL: E2E_DATABASE_URL,
      MELON_E2E_SERVER: "1",
      ...(E2E_METADATA_ONLY ? {
        AUTH_SECRET: "metadata-e2e-only-secret-at-least-32-characters",
        ALIYUN_OSS_REGION: "oss-cn-hangzhou",
        ALIYUN_OSS_BUCKET: "metadata-e2e-no-assets",
        ALIYUN_OSS_ENDPOINT: "https://assets.example.test",
        ALIYUN_OSS_CNAME: "true",
        ALIYUN_STS_ROLE_ARN: "acs:ram::123456789012:role/test-only",
        ALIBABA_CLOUD_ACCESS_KEY_ID: "test-only-no-real-credentials",
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: "test-only-no-real-credentials",
      } : {}),
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: `${E2E_BASE_URL}/login`,
  },
});
