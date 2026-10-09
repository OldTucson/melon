import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import integrationConfig from "../../vitest.integration.config";

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
});
