import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import integrationConfig from "../../vitest.integration.config";
import nextConfig from "../../next.config";

describe("database infrastructure configuration", () => {
  it("serializes integration test files that share the test database", () => {
    expect(integrationConfig.test?.fileParallelism).toBe(false);
  });

  it("publishes PostgreSQL only on the IPv4 loopback interface", async () => {
    const compose = await readFile(
      path.resolve(process.cwd(), "compose.yaml"),
      "utf8",
    );

    expect(compose).toContain('ports: ["127.0.0.1:55432:5432"]');
    expect(compose).not.toContain('ports: ["55432:5432"]');
  });

  it("keeps the Node-only OSS SDK outside the Turbopack server bundle", () => {
    expect(nextConfig.serverExternalPackages).toContain("ali-oss");
  });

  it("keeps account commands executable in a production-only install", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(manifest.scripts["user:create"]).toBe(
      "node --conditions=react-server --import tsx scripts/create-user.ts",
    );
    expect(manifest.scripts["user:reset-password"]).toBe(
      "node --conditions=react-server --import tsx scripts/reset-password.ts",
    );
    expect(manifest.dependencies.tsx).toBe("^4.23.15");
    expect(manifest.devDependencies).not.toHaveProperty("tsx");
  });

  it("defines readable semantic text for primary controls in both themes", async () => {
    const css = await readFile(
      path.resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );

    expect(css).toMatch(
      /:root\s*{[^}]*--primary: #3b5da8;[^}]*--on-primary: #fff;/s,
    );
    expect(css).toMatch(
      /\[data-theme="dark"\]\s*{[^}]*--primary: #7893dc;[^}]*--on-primary: #090b0f;/s,
    );
    expect(css.match(/color: var\(--on-primary\);/g)).toHaveLength(2);
  });
});
