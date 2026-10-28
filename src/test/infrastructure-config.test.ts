import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import integrationConfig, {
  buildIntegrationTestEnv,
} from "../../vitest.integration.config";
import nextConfig from "../../next.config";
import playwrightConfig from "../../playwright.config";

describe("database infrastructure configuration", () => {
  it("serializes integration test files that share the test database", () => {
    expect(integrationConfig.test?.fileParallelism).toBe(false);
  });

  it("does not replace deployment OSS settings during real integration tests", () => {
    const realIntegrationEnv = buildIntegrationTestEnv(true);

    expect(realIntegrationEnv).not.toHaveProperty("ALIYUN_OSS_REGION");
    expect(realIntegrationEnv).not.toHaveProperty("ALIYUN_OSS_BUCKET");
    expect(realIntegrationEnv).not.toHaveProperty("ALIYUN_OSS_ENDPOINT");
    expect(realIntegrationEnv).not.toHaveProperty("ALIYUN_OSS_CNAME");
    expect(realIntegrationEnv).not.toHaveProperty("ALIYUN_STS_ROLE_ARN");
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

  it("does not retain browser traces that can contain signed OSS URLs", () => {
    expect(playwrightConfig.use?.trace).toBe("off");
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
    const [tokens, controls, pages] = await Promise.all(
      ["tokens.css", "controls.css", "pages.css"].map((file) =>
        readFile(
          path.resolve(process.cwd(), "src/app/styles", file),
          "utf8",
        ),
      ),
    );

    expect(tokens).toMatch(
      /:root\s*{[^}]*--accent: #d9ef52;[^}]*--on-accent: #171815;[^}]*--primary: var\(--accent\);[^}]*--on-primary: var\(--on-accent\);/s,
    );
    expect(tokens).toMatch(
      /\[data-theme="dark"\]\s*{[^}]*--accent: #d9ef52;[^}]*--on-accent: #151611;/s,
    );
    expect(controls).toMatch(
      /\.primary-button,\s*\.topbar-upload-button\s*{[^}]*color: var\(--on-accent\);[^}]*background: var\(--accent\);/s,
    );
    expect(pages).toMatch(
      /\.theme-options label:has\(input:checked\)\s*{[^}]*color: var\(--text-primary\);[^}]*background: var\(--surface-panel\);/s,
    );
    expect(pages).toMatch(
      /\.theme-options label:has\(input:checked\) svg\s*{[^}]*color: var\(--accent-strong\);/s,
    );
  });
});
