import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertObjectKeyBelongsToPattern,
  objectKeyBelongsToPattern,
  parseObjectKey,
  previewObjectKey,
  sourceObjectKey,
  thumbnailObjectKey,
} from "./object-keys";

const ownerId = randomUUID();
const patternId = randomUUID();
const assetId = randomUUID();

describe("OSS object keys", () => {
  it("builds a lowercase source key from UUID-only identity fields", () => {
    expect(
      sourceObjectKey({ ownerId, patternId, assetId, extension: "PSD" }),
    ).toBe(
      `users/${ownerId}/patterns/${patternId}/source/${assetId}.psd`,
    );
  });

  it("builds the exact preview and thumbnail paths", () => {
    expect(
      previewObjectKey({ ownerId, patternId, assetId, extension: "PNG" }),
    ).toBe(
      `users/${ownerId}/patterns/${patternId}/preview/${assetId}.png`,
    );
    expect(
      thumbnailObjectKey({ ownerId, patternId, assetId, extension: "JpEg" }),
    ).toBe(
      `users/${ownerId}/patterns/${patternId}/thumbnail/${assetId}.jpeg`,
    );
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
    const key = previewObjectKey({
      ownerId,
      patternId,
      assetId,
      extension: "png",
    });

    expect(parseObjectKey(key)).toEqual({
      ownerId,
      patternId,
      assetId,
      role: "preview",
      extension: "png",
    });
    expect(() => parseObjectKey(`/${key}`)).toThrow();
    expect(() => parseObjectKey(`${key}/extra`)).toThrow();
    expect(() => parseObjectKey(key.replace(".png", ".PNG"))).toThrow();
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
    const key = sourceObjectKey({
      ownerId,
      patternId,
      assetId,
      extension: "procreate",
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
