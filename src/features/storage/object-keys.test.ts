import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertDistinctDerivedAssetIds,
  assertObjectKeyWithinPatternPrefix,
  assertObjectKeyBelongsToPattern,
  objectKeyBelongsToPattern,
  parseObjectKey,
  patternObjectPrefix,
  previewObjectKey,
  sourceObjectKey,
  thumbnailObjectKey,
} from "./object-keys";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const patternId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const assetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const previewAssetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const thumbnailAssetId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("OSS object keys", () => {
  it("builds a canonical pattern prefix and scopes arbitrary child keys", () => {
    const prefix = patternObjectPrefix({
      ownerId: ownerId.toUpperCase(),
      patternId: patternId.toUpperCase(),
    });

    expect(prefix).toBe(`users/${ownerId}/patterns/${patternId}/`);
    expect(
      assertObjectKeyWithinPatternPrefix(
        prefix,
        `${prefix}derived/uncommitted-preview.tmp`,
      ),
    ).toBe(`${prefix}derived/uncommitted-preview.tmp`);
    expect(() =>
      assertObjectKeyWithinPatternPrefix(
        prefix,
        `users/${ownerId}/patterns/${randomUUID()}/derived/escape.tmp`,
      ),
    ).toThrow(/outside/i);
    expect(() =>
      assertObjectKeyWithinPatternPrefix(`${prefix}derived/`, `${prefix}x`),
    ).toThrow(/prefix/i);
  });

  it("builds a lowercase source key from UUID-only identity fields", () => {
    expect(
      sourceObjectKey({ ownerId, patternId, assetId, extension: "PSD" }),
    ).toBe(
      `users/${ownerId}/patterns/${patternId}/source/${assetId}.psd`,
    );
  });

  it("normalizes UUID inputs to PostgreSQL lowercase text form", () => {
    const key = sourceObjectKey({
      ownerId: ownerId.toUpperCase(),
      patternId: patternId.toUpperCase(),
      assetId: assetId.toUpperCase(),
      extension: "PNG",
    });

    expect(key).toBe(
      `users/${ownerId}/patterns/${patternId}/source/${assetId}.png`,
    );
    expect(
      objectKeyBelongsToPattern({
        key,
        ownerId: ownerId.toUpperCase(),
        patternId: patternId.toUpperCase(),
      }),
    ).toBe(true);
  });

  it("maps preview and thumbnail roles to distinct derived object keys", () => {
    const previewKey = previewObjectKey({
      ownerId,
      patternId,
      assetId: previewAssetId,
      extension: "PNG",
    });
    const thumbnailKey = thumbnailObjectKey({
      ownerId,
      patternId,
      assetId: thumbnailAssetId,
      extension: "JpEg",
    });

    expect(previewKey).toBe(
      `users/${ownerId}/patterns/${patternId}/derived/${previewAssetId}.png`,
    );
    expect(thumbnailKey).toBe(
      `users/${ownerId}/patterns/${patternId}/derived/${thumbnailAssetId}.jpeg`,
    );
    expect(previewKey).not.toBe(thumbnailKey);
  });

  it("allows WebP only for derived keys", () => {
    expect(
      previewObjectKey({
        ownerId,
        patternId,
        assetId: previewAssetId,
        extension: "WEBP",
      }),
    ).toBe(
      `users/${ownerId}/patterns/${patternId}/derived/${previewAssetId}.webp`,
    );
    expect(() =>
      sourceObjectKey({ ownerId, patternId, assetId, extension: "webp" }),
    ).toThrow();
    expect(() =>
      previewObjectKey({
        ownerId,
        patternId,
        assetId: previewAssetId,
        extension: "psd",
      }),
    ).toThrow();
  });

  it("requires preview and thumbnail to use distinct asset UUIDs", () => {
    expect(
      assertDistinctDerivedAssetIds({ previewAssetId, thumbnailAssetId }),
    ).toEqual({ previewAssetId, thumbnailAssetId });
    expect(() =>
      assertDistinctDerivedAssetIds({
        previewAssetId,
        thumbnailAssetId: previewAssetId,
      }),
    ).toThrow(/distinct/i);
    expect(() =>
      assertDistinctDerivedAssetIds({
        previewAssetId: previewAssetId.toUpperCase(),
        thumbnailAssetId: previewAssetId,
      }),
    ).toThrow(/distinct/i);
    expect(() =>
      assertDistinctDerivedAssetIds({
        previewAssetId: "not-a-uuid",
        thumbnailAssetId,
      }),
    ).toThrow();
  });

  it.each(["ownerId", "patternId", "assetId"] as const)(
    "rejects a non-UUID %s",
    (field) => {
      expect(() =>
        sourceObjectKey({
          ownerId,
          patternId,
          assetId,
          extension: "psd",
          [field]: "not-a-uuid",
        }),
      ).toThrow();
    },
  );

  it.each(["gif", ".psd", "psd/escape", "png\\escape", "jpg?download"])(
    "rejects unsupported or path-like extension %s",
    (extension) => {
      expect(() =>
        sourceObjectKey({ ownerId, patternId, assetId, extension }),
      ).toThrow();
    },
  );

  it("parses only canonical storage keys", () => {
    const sourceKey = sourceObjectKey({
      ownerId,
      patternId,
      assetId,
      extension: "ai",
    });
    const derivedKey = previewObjectKey({
      ownerId,
      patternId,
      assetId: previewAssetId,
      extension: "png",
    });

    expect(parseObjectKey(sourceKey)).toEqual({
      ownerId,
      patternId,
      assetId,
      kind: "source",
      extension: "ai",
    });
    expect(parseObjectKey(derivedKey)).toEqual({
      ownerId,
      patternId,
      assetId: previewAssetId,
      kind: "derived",
      extension: "png",
    });
    expect(() => parseObjectKey(`/${derivedKey}`)).toThrow();
    expect(() => parseObjectKey(`${derivedKey}/extra`)).toThrow();
    expect(() =>
      parseObjectKey(derivedKey.replace(".png", ".PNG")),
    ).toThrow();
    expect(() =>
      parseObjectKey(derivedKey.replace("/derived/", "/preview/")),
    ).toThrow();
    expect(() =>
      parseObjectKey(derivedKey.replace("/derived/", "/thumbnail/")),
    ).toThrow();
    expect(() =>
      parseObjectKey(sourceKey.replace(ownerId, ownerId.toUpperCase())),
    ).toThrow();
    expect(() =>
      parseObjectKey(sourceKey.replace(patternId, patternId.toUpperCase())),
    ).toThrow();
    expect(() =>
      parseObjectKey(sourceKey.replace(assetId, assetId.toUpperCase())),
    ).toThrow();
  });

  it("does not accept another owner or pattern through prefix similarity", () => {
    const key = sourceObjectKey({
      ownerId,
      patternId,
      assetId,
      extension: "ai",
    });

    expect(objectKeyBelongsToPattern({ key, ownerId, patternId })).toBe(true);
    expect(
      objectKeyBelongsToPattern({ key, ownerId: randomUUID(), patternId }),
    ).toBe(false);
    expect(
      objectKeyBelongsToPattern({ key, ownerId, patternId: randomUUID() }),
    ).toBe(false);
    expect(
      objectKeyBelongsToPattern({
        key: key.replace(`/patterns/${patternId}/`, `/patterns/${patternId}0/`),
        ownerId,
        patternId,
      }),
    ).toBe(false);
  });

  it("fails closed when asserting a malformed or cross-pattern key", () => {
    const key = thumbnailObjectKey({
      ownerId,
      patternId,
      assetId: thumbnailAssetId,
      extension: "png",
    });

    expect(
      assertObjectKeyBelongsToPattern({ key, ownerId, patternId }),
    ).toEqual(parseObjectKey(key));
    expect(() =>
      assertObjectKeyBelongsToPattern({
        key,
        ownerId,
        patternId: randomUUID(),
      }),
    ).toThrow(/outside/i);
    expect(() =>
      assertObjectKeyBelongsToPattern({
        key: "users/not-valid",
        ownerId,
        patternId,
      }),
    ).toThrow(/invalid/i);
  });
});
