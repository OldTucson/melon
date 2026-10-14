import { expect, it } from "vitest";

import { fixtureId, withAuthorizationFixtureDatabase } from "./authorization-seed";

it("derives stable valid IDs and isolates project namespaces", () => {
  expect(fixtureId("chromium:rules")).toBe(fixtureId("chromium:rules"));
  expect(fixtureId("chromium:rules")).not.toBe(fixtureId("webkit:rules"));
  expect(fixtureId("chromium:rules")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

it("rejects unsafe fixture databases and owners before opening a connection", async () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  await expect(withAuthorizationFixtureDatabase("postgres://localhost/melon", owner, async () => {})).rejects.toThrow("E2E_DATABASE_NAME_UNSAFE");
  await expect(withAuthorizationFixtureDatabase("postgres://localhost/melon_e2e", "real-owner", async () => {})).rejects.toThrow("E2E_OWNER_ID_UNSAFE");
});
