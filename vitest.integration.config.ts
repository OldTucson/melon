import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
      "server-only": path.resolve(process.cwd(), "src/test/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://melon:melon@localhost:55432/melon_test",
      AUTH_SECRET: "test-only-auth-secret-at-least-32-characters",
      APP_ORIGIN: "http://localhost:3000",
      ALIYUN_OSS_REGION: "oss-cn-hangzhou",
      ALIYUN_OSS_BUCKET: "melon-test-assets",
      ALIYUN_OSS_ENDPOINT: "https://assets.example.test",
      ALIYUN_OSS_CNAME: "true",
      ALIYUN_STS_ROLE_ARN:
        "acs:ram::123456789012:role/melon-browser-upload",
    },
  },
});
