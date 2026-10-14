import { describe, expect, it, vi } from "vitest";

import { cleanupE2eResources } from "../../tests/e2e/global-setup";
import {
  assertE2eAssetRows,
  assertE2eListedObjectKeys,
  assertE2eObjectKeys,
  e2eOwnerObjectPrefixes,
  listE2eOssObjectKeys,
} from "../../tests/e2e/oss-safety";

const DESIGNER_ID = "11111111-1111-4111-8111-111111111111";
const PATTERN_ID = "33333333-3333-4333-8333-333333333331";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const SOURCE_KEY =
  `users/${DESIGNER_ID}/patterns/${PATTERN_ID}/source/${ASSET_ID}.png`;

function assetRow(
  overrides: Partial<Parameters<typeof assertE2eAssetRows>[0][number]> = {},
) {
  return {
    assetId: ASSET_ID,
    objectKey: SOURCE_KEY,
    ownerId: DESIGNER_ID,
    patternId: PATTERN_ID,
    role: "source",
    ...overrides,
  };
}

describe("E2E OSS cleanup safety", () => {
  it("accepts only objects owned by the fixed E2E users", () => {
    expect(() => assertE2eObjectKeys([SOURCE_KEY])).not.toThrow();
  });

  it.each([
    "users/99999999-9999-4999-8999-999999999999/patterns/33333333-3333-4333-8333-333333333331/source/44444444-4444-4444-8444-444444444444.psd",
    `users/${DESIGNER_ID}/patterns/../private/source.psd`,
    `users/${DESIGNER_ID}/patterns/33333333-3333-4333-8333-333333333331/source/44444444-4444-4444-8444-444444444444.PNG`,
  ])("rejects an unsafe object key before cleanup: %s", (objectKey) => {
    expect(() => assertE2eObjectKeys([objectKey])).toThrow(
      "E2E_OSS_OBJECT_KEY_UNSAFE",
    );
  });

  it("accepts a database asset row only when all canonical key fields match", () => {
    expect(() => assertE2eAssetRows([assetRow()])).not.toThrow();
    expect(() =>
      assertE2eAssetRows([
        assetRow({
          objectKey: `users/${DESIGNER_ID}/patterns/${PATTERN_ID}/derived/${ASSET_ID}.webp`,
          role: "thumbnail",
        }),
      ]),
    ).not.toThrow();
  });

  it.each([
    assetRow({ ownerId: "22222222-2222-4222-8222-222222222222" }),
    assetRow({ patternId: "33333333-3333-4333-8333-333333333332" }),
    assetRow({ assetId: "44444444-4444-4444-8444-444444444445" }),
    assetRow({ role: "preview" }),
    assetRow({
      objectKey: `users/${DESIGNER_ID}/patterns/${PATTERN_ID}/derived/${ASSET_ID}.webp`,
      role: "source",
    }),
    assetRow({ objectKey: `users/${DESIGNER_ID}/patterns/${PATTERN_ID}/draft.bin` }),
  ])("rejects mismatched or noncanonical database asset metadata", (row) => {
    expect(() => assertE2eAssetRows([row])).toThrow(
      "E2E_OSS_OBJECT_KEY_UNSAFE",
    );
  });

  it("accepts listed objects only beneath the exact fixed E2E prefix", () => {
    const [prefix] = e2eOwnerObjectPrefixes();
    expect(prefix).toBe(`users/${DESIGNER_ID}/patterns/`);
    expect(() =>
      assertE2eListedObjectKeys(prefix!, [
        `${prefix}upload-in-progress/preview.tmp`,
      ]),
    ).not.toThrow();
  });

  it("rejects an unknown prefix or an object outside the requested E2E prefix", () => {
    const [prefix] = e2eOwnerObjectPrefixes();
    expect(() =>
      assertE2eListedObjectKeys("users/unknown/patterns/", []),
    ).toThrow("E2E_OSS_OBJECT_KEY_UNSAFE");
    expect(() =>
      assertE2eListedObjectKeys(prefix!, [
        "users/99999999-9999-4999-8999-999999999999/patterns/private.bin",
      ]),
    ).toThrow("E2E_OSS_OBJECT_KEY_UNSAFE");
  });

  it("walks every page for each fixed E2E owner prefix", async () => {
    const [designerPrefix, tenantPrefix] = e2eOwnerObjectPrefixes();
    const listV2 = vi.fn(
      async (query: {
        prefix?: string;
        "continuation-token"?: string;
      }) => {
        if (query.prefix === designerPrefix) {
          if (query["continuation-token"] === undefined) {
            return {
              isTruncated: true,
              nextContinuationToken: "designer-next",
              objects: [{ name: `${designerPrefix}orphan-a.tmp` }],
            };
          }
          return {
            isTruncated: false,
            nextContinuationToken: "",
            objects: [{ name: `${designerPrefix}orphan-b.tmp` }],
          };
        }
        expect(query.prefix).toBe(tenantPrefix);
        return {
          isTruncated: false,
          nextContinuationToken: "",
          objects: [{ name: `${tenantPrefix}orphan-c.tmp` }],
        };
      },
    );

    await expect(listE2eOssObjectKeys({ listV2 })).resolves.toEqual([
      `${designerPrefix}orphan-a.tmp`,
      `${designerPrefix}orphan-b.tmp`,
      `${tenantPrefix}orphan-c.tmp`,
    ]);
    expect(listV2).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["repeated", ["A", "A"]],
    ["cyclic", ["A", "B", "A"]],
  ])("fails closed on %s OSS continuation tokens", async (_label, tokens) => {
    let page = 0;
    const listV2 = vi.fn(async () => ({
      isTruncated: true,
      nextContinuationToken: tokens[page++] ?? tokens.at(-1)!,
      objects: [],
    }));

    await expect(listE2eOssObjectKeys({ listV2 })).rejects.toThrow(
      "E2E_OSS_LIST_PAGINATION_INVALID",
    );
  });

  it("rejects a non-E2E database before teardown can connect or delete", async () => {
    await expect(
      cleanupE2eResources("postgres://melon:melon@127.0.0.1:55432/melon"),
    ).rejects.toThrow("E2E_DATABASE_NAME_UNSAFE");
  });
});
