import { defineConfig, devices } from "@playwright/test";

import { E2E_BASE_URL, E2E_DATABASE_URL } from "./tests/e2e/environment";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
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
      "node --import tsx tests/e2e/prepare.ts && npm run dev -- --hostname 127.0.0.1 --port 3210",
    env: {
      ...process.env,
      APP_ORIGIN: E2E_BASE_URL,
      DATABASE_URL: E2E_DATABASE_URL,
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: `${E2E_BASE_URL}/login`,
  },
});
