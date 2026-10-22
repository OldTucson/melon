import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (file: string) =>
  readFile(path.resolve(process.cwd(), file), "utf8");

describe("OSS operations contract", () => {
  it("keeps versioning disabled while delete retries operate on keys only", async () => {
    const operations = await readRepositoryFile("docs/operations/aliyun-oss.md");

    expect(operations).toMatch(/Bucket 基线[\s\S]*版本控制保持关闭/);
    expect(operations).toMatch(
      /版本控制[\s\S]*开启[\s\S]*versionId[\s\S]*delete marker/,
    );
    expect(operations).toMatch(/上线核对[\s\S]*版本控制保持关闭/);
  });

  it("documents role-aware source and derived object extensions", async () => {
    const operations = await readRepositoryFile("docs/operations/aliyun-oss.md");

    expect(operations).toMatch(
      /source\/\{ASSET_UUID\}\.\{psd\|ai\|pdf\|jpg\|jpeg\|png\|procreate\}/,
    );
    expect(operations).toMatch(
      /derived\/\{ASSET_UUID\}\.\{jpg\|jpeg\|png\|webp\}/,
    );
    expect(operations).toMatch(/WebP[\s\S]*派生/);
  });

  it("documents bucket-scoped server listing without granting it to browsers", async () => {
    const operations = await readRepositoryFile("docs/operations/aliyun-oss.md");
    const serverSection = operations
      .split("## 服务端运行身份")[1]
      ?.split("### 本地开发")[0];
    const browserSection = operations
      .split("## 浏览器上传角色")[1]
      ?.split("## 服务端运行身份")[0];

    expect(serverSection).toMatch(
      /"Action": "oss:ListObjects"[\s\S]*"Resource": "acs:oss:\*:\*:BUCKET"[\s\S]*"oss:Prefix": "users\/\*\/patterns\/\*"/,
    );
    expect(serverSection).toMatch(
      /"Action": \[[\s\S]*"oss:GetObject"[\s\S]*"oss:DeleteObject"[\s\S]*"Resource": "acs:oss:\*:\*:BUCKET\/users\/\*\/patterns\/\*"/,
    );
    expect(serverSection).toMatch(
      /"Sid": "WriteVisualSearchFeatures"[\s\S]*"Action": "oss:PutObject"[\s\S]*"Resource": "acs:oss:\*:\*:BUCKET\/users\/\*\/patterns\/\*\/derived\/search\/\*"/,
    );
    expect(serverSection).not.toContain('"Resource": "acs:oss:*:*:BUCKET/users/*"');
    expect(browserSection).toMatch(/不授予[^\n]*列举/);
    expect(browserSection).toMatch(/不要添加[^\n]*`ListObjects`/);
  });

  it("keeps the browser STS policy write-only and unchanged", async () => {
    const operations = await readRepositoryFile("docs/operations/aliyun-oss.md");
    const browserSection = operations
      .split("## 浏览器上传角色")[1]
      ?.split("## 服务端运行身份")[0];
    const policySource = browserSection?.match(/```json\n([\s\S]*?)\n```/)?.[1];

    expect(policySource).toBeDefined();
    const policy = JSON.parse(policySource!) as {
      Statement: Array<{ Action: string[]; Resource: string }>;
    };
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]?.Action).toEqual([
      "oss:AbortMultipartUpload",
      "oss:ListParts",
      "oss:PutObject",
    ]);
    expect(policy.Statement[0]?.Resource).toBe(
      "acs:oss:*:*:BUCKET/users/OWNER_UUID/patterns/PATTERN_UUID/*",
    );
  });

  it("packages a private non-root visual-search deployment", async () => {
    const [dockerfile, compose, apiUnit, workerUnit, operations] =
      await Promise.all([
        readRepositoryFile("services/visual-search/Dockerfile"),
        readRepositoryFile("deploy/compose.visual-search.yaml"),
        readRepositoryFile("deploy/systemd/melon-visual-search.service"),
        readRepositoryFile("deploy/systemd/melon-visual-search-worker.service"),
        readRepositoryFile("docs/operations/visual-search.md"),
      ]);
    const deployment = [dockerfile, compose, apiUnit, workerUnit, operations].join(
      "\n",
    );

    expect(dockerfile).toMatch(/FROM python:3\.12-slim/);
    expect(dockerfile).toMatch(/uv sync --frozen --no-dev/);
    expect(dockerfile).toMatch(/USER melon/);
    expect(dockerfile).not.toMatch(/(?:curl|wget)[^\n]*(?:onnx|huggingface)/i);
    expect(compose).toMatch(/127\.0\.0\.1:8091:8091/);
    expect(compose).toMatch(
      /target: \/models\/dinov2-small\.onnx\n\s+read_only: true/,
    );
    expect(compose).toMatch(/read_only: true/);
    expect(apiUnit).toMatch(/EnvironmentFile=\/etc\/melon\/visual-search\.env/);
    expect(apiUnit).toMatch(/MemoryMax=/);
    expect(apiUnit).toMatch(/PrivateTmp=true/);
    expect(apiUnit).toMatch(/ExecStartPost=.*\/internal\/health/);
    expect(workerUnit).toMatch(/Restart=on-failure/);
    expect(operations).toMatch(/ECS 实例 RAM 角色/);
    expect(operations).toMatch(/IMDSv2[\s\S]*禁用 IMDSv1/);
    expect(deployment).not.toMatch(/LTAI[A-Za-z0-9]{12,}/);
  });

  it("runs orphan cleanup daily through the one-shot CLI service", async () => {
    const [cleanupUnit, timer] = await Promise.all([
      readRepositoryFile("deploy/systemd/melon-visual-search-cleanup.service"),
      readRepositoryFile("deploy/systemd/melon-visual-search-cleanup.timer"),
    ]);

    expect(cleanupUnit).toMatch(
      /visual-search-cli cleanup-orphans --older-than-hours 24/,
    );
    expect(cleanupUnit).toMatch(/Type=oneshot/);
    expect(timer).toMatch(/OnCalendar=daily/);
    expect(timer).toMatch(/Persistent=true/);
  });
});
