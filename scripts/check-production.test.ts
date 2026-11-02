import { describe, expect, it } from "vitest";

import {
  formatProductionReadinessErrors,
  formatServerEnvValidationError,
} from "./check-production";

describe("production preflight output", () => {
  it("prints only fixed readiness codes", () => {
    const output = formatProductionReadinessErrors([
      "APP_ORIGIN_HTTPS_REQUIRED",
      "AUTH_SECRET_PLACEHOLDER",
    ]);

    expect(output).toBe(
      "Production preflight: FAIL\n- APP_ORIGIN_HTTPS_REQUIRED\n- AUTH_SECRET_PLACEHOLDER",
    );
    for (const secret of [
      "super-secret-auth-value",
      "postgres://user:password@db.internal/melon_prod",
      "long-term-access-key",
      "internal-image-token",
      "https://example.test/file?Signature=signed-value",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("reduces malformed environment failures to safe field paths", () => {
    const output = formatServerEnvValidationError({
      issues: [
        {
          path: ["AUTH_SECRET"],
          message: "Invalid value super-secret-auth-value",
          input: "super-secret-auth-value",
        },
        {
          path: ["DATABASE_URL"],
          message: "Invalid URL postgres://user:password@db.internal/melon_prod",
          input: "postgres://user:password@db.internal/melon_prod",
        },
      ],
    });

    expect(output).toBe(
      "Production preflight: INVALID_ENV\n- AUTH_SECRET: invalid configuration\n- DATABASE_URL: invalid configuration",
    );
    expect(output).not.toMatch(/super-secret|postgres:\/\//i);
  });

  it("uses a generic message for unknown failures", () => {
    expect(formatServerEnvValidationError(new Error("private failure"))).toBe(
      "Production preflight: INVALID_ENV\n- environment: invalid configuration",
    );
  });
});

// Execute the entrypoint in an empty cwd: no workstation .env or provider calls.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const productionEnv = {
  NODE_ENV: "production" as const, DATABASE_URL: "postgres://melon:private-password@127.0.0.1:1/melon_prod",
  AUTH_SECRET: "prod-auth-2026-random-value-9f4a8d2c7b1e", AUTH_TRUST_PROXY: "true", APP_ORIGIN: "https://melon.example.cn",
  SITE_OPERATOR_NAME: "Melon Studio", SITE_CONTACT_EMAIL: "privacy@melon.example.cn", SITE_LEGAL_EFFECTIVE_DATE: "2026-10-23",
  ALIYUN_OSS_REGION: "oss-cn-hangzhou", ALIYUN_OSS_BUCKET: "melon-prod-assets", ALIYUN_OSS_ENDPOINT: "https://assets.melon.example.cn", ALIYUN_OSS_CNAME: "true", ALIYUN_STS_ROLE_ARN: "acs:ram::123456789012:role/melon-browser-upload", OSS_ADAPTER: "real",
  INSPIRATION_ENABLED: "true", INSPIRATION_CONCEPT_IMAGES_ENABLED: "true", INSPIRATION_CONCEPT_RELEASE_APPROVED: "true",
  INSPIRATION_IMAGE_MODEL: "qwen-image-3.0-pro", INSPIRATION_CONCEPT_WORKER_ID: "production-concept-1",
  DASHSCOPE_API_KEY: "private-api-key", DASHSCOPE_WORKSPACE_ID: "workspace-private",
  DASHSCOPE_OPENAI_BASE_URL: "https://workspace-private.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  DASHSCOPE_NATIVE_BASE_URL: "https://workspace-private.cn-beijing.maas.aliyuncs.com/api/v1",
};
function executeProduction(patch: Record<string, string | undefined>) {
  const cwd = mkdtempSync(join(tmpdir(), "melon-preflight-"));
  try {
    return spawnSync(process.execPath, ["--conditions=react-server", "--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("scripts/check-production.ts")], { cwd, env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: resolve("tsconfig.json"), ...productionEnv, ...patch }, encoding: "utf8", timeout: 10_000 });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
describe("production concept preflight entrypoint", () => {
  it("passes independently of DB reachability and worker liveness", () => {
    const child = executeProduction({}); expect(child.status).toBe(0); expect(child.stdout.trim()).toBe("Production preflight: PASS"); expect(child.stderr).toBe("");
  });
  it.each([
    { INSPIRATION_CONCEPT_RELEASE_APPROVED: "false" }, { INSPIRATION_IMAGE_MODEL: "qwen-image-2.0" },
    { DASHSCOPE_NATIVE_BASE_URL: "https://foreign.cn-beijing.maas.aliyuncs.com/api/v1" }, { OSS_ADAPTER: "fake" },
    { INSPIRATION_CONCEPT_WORKER_ID: "" },
  ])("fails closed for incomplete concept release configuration %j", (patch) => {
    const child = executeProduction(patch); expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).not.toMatch(/private-password|private-api-key|workspace-private|postgres:\/\//);
  });
  it("does not require worker configuration or heartbeat when concepts are disabled", () => {
    const child = executeProduction({ INSPIRATION_CONCEPT_IMAGES_ENABLED: "false", INSPIRATION_CONCEPT_RELEASE_APPROVED: "false", INSPIRATION_CONCEPT_WORKER_ID: "" }); expect(child.status).toBe(0);
  });
});
