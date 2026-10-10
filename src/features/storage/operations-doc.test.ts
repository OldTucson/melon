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
});
