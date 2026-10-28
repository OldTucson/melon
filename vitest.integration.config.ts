import path from "node:path";
import { defineConfig } from "vitest/config";

const sharedIntegrationEnv = {
  NODE_ENV: "test" as const,
  DATABASE_URL: "postgres://melon:melon@localhost:55432/melon_test",
  AUTH_SECRET: "test-only-auth-secret-at-least-32-characters",
  AUTH_TRUST_PROXY: "true",
  APP_ORIGIN: "http://localhost:3000",
};

const fakeOssIntegrationEnv = {
  ALIYUN_OSS_REGION: "oss-cn-hangzhou",
  ALIYUN_OSS_BUCKET: "melon-test-assets",
  ALIYUN_OSS_ENDPOINT: "https://assets.example.test",
  ALIYUN_OSS_CNAME: "true",
  ALIYUN_STS_ROLE_ARN:
    "acs:ram::123456789012:role/melon-browser-upload",
};

export function buildIntegrationTestEnv(runRealOssTests: boolean) {
  return {
    ...sharedIntegrationEnv,
    ...(runRealOssTests ? {} : fakeOssIntegrationEnv),
  };
}

// Real-service tests load their explicitly allowed local settings only under opt-in flags.
export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
      "server-only": path.resolve(process.cwd(), "src/test/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["src/**/*.integration.test.ts"],
    env: buildIntegrationTestEnv(process.env.RUN_REAL_OSS_TESTS === "1"),
  },
});
