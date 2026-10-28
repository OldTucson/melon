// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "vite";
import { expect, it } from "vitest";

import unitConfig from "../../vitest.config";
import integrationConfig from "../../vitest.integration.config";

it.each([{ name: "unit", config: unitConfig }, { name: "integration", config: integrationConfig }])
("does not auto-load local env files in $name tests", async ({ config }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "melon-fake-local-env-"));
  try {
    writeFileSync(path.join(dir, ".env.local"), "VITE_FAKE_LOCAL_SECRET=only-a-fake-secret\n");
    // Resolve the configured policy against a controlled fake root. This never
    // reads the workspace env and catches removal of the envDir security boundary.
    const resolved = await resolveConfig({ configFile: false, root: dir, envDir: config.envDir }, "serve", "test");
    expect(resolved.env).not.toHaveProperty("VITE_FAKE_LOCAL_SECRET");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
