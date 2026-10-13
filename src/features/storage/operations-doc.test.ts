import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OSS operations contract", () => {
  it("keeps versioning disabled while delete retries operate on keys only", async () => {
    const operations = await readFile(
      path.resolve(process.cwd(), "docs/operations/aliyun-oss.md"),
      "utf8",
    );

    expect(operations).toMatch(/Bucket 基线[\s\S]*版本控制保持关闭/);
    expect(operations).toMatch(
      /版本控制[\s\S]*开启[\s\S]*versionId[\s\S]*delete marker/,
    );
    expect(operations).toMatch(/上线核对[\s\S]*版本控制保持关闭/);
  });

  it("documents role-aware source and derived object extensions", async () => {
    const operations = await readFile(
      path.resolve(process.cwd(), "docs/operations/aliyun-oss.md"),
      "utf8",
    );

    expect(operations).toMatch(
      /source\/\{ASSET_UUID\}\.\{psd\|ai\|jpg\|jpeg\|png\|procreate\}/,
    );
    expect(operations).toMatch(
      /derived\/\{ASSET_UUID\}\.\{jpg\|jpeg\|png\|webp\}/,
    );
    expect(operations).toMatch(/WebP[\s\S]*派生/);
  });

  it("documents bucket-scoped server listing without granting it to browsers", async () => {
    const operations = await readFile(
      path.resolve(process.cwd(), "docs/operations/aliyun-oss.md"),
      "utf8",
    );
    const serverSection = operations
      .split("## 服务端运行身份")[1]
      ?.split("### 本地开发")[0];
    const browserSection = operations
      .split("## 浏览器上传角色")[1]
      ?.split("## 服务端运行身份")[0];

    expect(serverSection).toMatch(
      /"Action": "oss:ListObjects"[\s\S]*"Resource": "acs:oss:\*:\*:BUCKET"[\s\S]*"oss:Prefix": "users\/\*"/,
    );
    expect(serverSection).toMatch(
      /"Action": \[[\s\S]*"oss:GetObject"[\s\S]*"oss:DeleteObject"[\s\S]*"Resource": "acs:oss:\*:\*:BUCKET\/users\/\*"/,
    );
    expect(browserSection).toMatch(/不授予[^\n]*列举/);
    expect(browserSection).toMatch(/不要添加[^\n]*`ListObjects`/);
  });
});
