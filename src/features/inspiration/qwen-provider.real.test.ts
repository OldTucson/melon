// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import { inspirationAnalysisResultSchema, inspirationErrorCodes, inspirationSourcesSchema } from "./contracts";
import { createQwenInspirationProvider } from "./qwen-provider";

const runReal = process.env.RUN_REAL_INSPIRATION_TESTS === "1";
const inspirationNames = [
  "INSPIRATION_ENABLED", "DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID",
  "DASHSCOPE_OPENAI_BASE_URL", "DASHSCOPE_NATIVE_BASE_URL",
  "INSPIRATION_SEARCH_MODEL", "INSPIRATION_STRUCTURE_MODEL",
] as const;

function realConfig() {
  try {
    const local = parseDotEnv(readFileSync(path.join(process.cwd(), ".env.local")));
    const inspiration: Record<string, string | undefined> = {};
    for (const name of inspirationNames) {
      if (local[name] !== undefined) process.env[name] = local[name];
      inspiration[name] = process.env[name];
    }
    // Validate the provider with the real server schema without importing unrelated
    // local application credentials into the test process.
    const env = parseServerEnv({
      NODE_ENV: "test", DATABASE_URL: "postgres://localhost/unused",
      AUTH_SECRET: "test-only-placeholder-auth-secret", APP_ORIGIN: "http://localhost:3000",
      ALIYUN_OSS_REGION: "oss-cn-hangzhou", ALIYUN_OSS_BUCKET: "unused-test-bucket",
      ALIYUN_OSS_ENDPOINT: "https://assets.example.test", ALIYUN_OSS_CNAME: "true",
      ALIYUN_STS_ROLE_ARN: "acs:ram::123456789012:role/unused",
      ...inspiration,
    });
    if (!env.INSPIRATION_ENABLED || !env.DASHSCOPE_API_KEY || !env.DASHSCOPE_OPENAI_BASE_URL || !env.DASHSCOPE_NATIVE_BASE_URL) throw new Error();
    return {
      apiKey: env.DASHSCOPE_API_KEY, openaiBaseUrl: env.DASHSCOPE_OPENAI_BASE_URL,
      nativeBaseUrl: env.DASHSCOPE_NATIVE_BASE_URL, searchModel: env.INSPIRATION_SEARCH_MODEL,
      structureModel: env.INSPIRATION_STRUCTURE_MODEL,
    };
  } catch { throw new Error("REAL_INSPIRATION_CONFIG_INVALID"); }
}

(runReal ? describe : describe.skip)("real Qwen inspiration provider", () => {
  it("returns a strict sourced Chinese analysis with valid citations", async () => {
    const provider = createQwenInspirationProvider(realConfig());
    let output;
    try {
      output = await provider.analyze({
        prompt: "请分析近30天春夏女装碎花连衣裙的公开网络趋势，关注廓形、色彩、面料与设计灵感，并明确证据不足之处。",
        signal: AbortSignal.timeout(110_000),
      });
    } catch (error) {
      const code = error instanceof AppError && inspirationErrorCodes.includes(error.code as (typeof inspirationErrorCodes)[number])
        ? error.code : "UNEXPECTED";
      // A new fixed error prevents Vitest from printing provider data or causes.
      throw new Error(`REAL_INSPIRATION_${code}`);
    }
    // Assert booleans and counts only, so failures never print provider content.
    expect(inspirationAnalysisResultSchema.safeParse(output.result).success).toBe(true);
    expect(inspirationSourcesSchema.safeParse(output.sources).success).toBe(true);
    expect(output.sources.length).toBeGreaterThan(0);
    const indexes = new Set(output.sources.map((source) => source.index));
    const citations = [
      ...output.result.marketSignals, ...output.result.referenceLooks,
      ...Object.values(output.result.dimensions).flat(), ...output.result.inspirationPrompts,
    ];
    expect(citations.every((item) => item.sourceIndexes.every((index) => indexes.has(index)))).toBe(true);
  }, 120_000);
});
