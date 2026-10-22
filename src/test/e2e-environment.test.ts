import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("uses an explicit loopback port without reusing the developer server", async () => {
  vi.stubEnv("E2E_PORT", "3211");
  const environment = await import("../../tests/e2e/environment");
  expect(environment.E2E_BASE_URL).toBe("http://127.0.0.1:3211");
});

it.each(["0", "65536", "3211;evil", "https://example.com"])("rejects invalid E2E port %s", async (port) => {
  vi.stubEnv("E2E_PORT", port);
  await expect(import("../../tests/e2e/environment")).rejects.toThrow("E2E_PORT_INVALID");
});

it("fails closed before metadata-only cleanup can discard asset records", async () => {
  const { assertMetadataOnlyRows } = await import("../../tests/e2e/environment");
  expect(() => assertMetadataOnlyRows([{ objectKey: "anything" }])).toThrow("E2E_METADATA_ASSETS_PRESENT");
  expect(() => assertMetadataOnlyRows([])).not.toThrow();
});

it("fails closed when an unfinished upload still references an OSS object", async () => {
  const { assertMetadataOnlyRows } = await import("../../tests/e2e/environment");
  expect(() => assertMetadataOnlyRows([], [{ sourceObjectKey: "pending-upload" }])).toThrow("E2E_METADATA_ASSETS_PRESENT");
});

it("rejects an unsafe E2E database before creating a connection", async () => {
  vi.stubEnv("E2E_DATABASE_URL", "postgres://localhost/melon");
  await expect(import("../../tests/e2e/environment")).rejects.toThrow("E2E_DATABASE_NAME_UNSAFE");
});

it("allows only the exact synthetic image-search assets during cleanup", async () => {
  const { E2E_USERS } = await import("../../tests/e2e/environment");
  const { IMAGE_SEARCH_PATTERN_SEEDS, assertImageSearchFixtureRows } =
    await import("../../tests/e2e/image-search-fixtures");
  const pattern = IMAGE_SEARCH_PATTERN_SEEDS[0];
  const row = {
    assetId: pattern.sourceAssetId,
    objectKey: `users/${E2E_USERS.designer.id}/patterns/${pattern.id}/source/${pattern.sourceAssetId}.${pattern.extension}`,
    ownerId: E2E_USERS.designer.id,
    patternId: pattern.id,
    role: "source",
  };

  expect(() => assertImageSearchFixtureRows([row])).not.toThrow();
  expect(() =>
    assertImageSearchFixtureRows([
      { ...row, objectKey: "users/other/patterns/unexpected.png" },
    ]),
  ).toThrow("E2E_IMAGE_SEARCH_ASSET_UNSAFE");
  expect(() =>
    assertImageSearchFixtureRows([], [{ sourceObjectKey: "pending-upload" }]),
  ).toThrow("E2E_IMAGE_SEARCH_UPLOADS_PRESENT");
});
