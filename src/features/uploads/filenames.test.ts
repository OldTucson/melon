import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { previewObjectKey, sourceObjectKey } from "@/features/storage/object-keys";

import { derivePatternName, sanitizeDownloadName } from "./filenames";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const patternId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sourceKey = (extension: "psd" | "jpg" = "psd") =>
  sourceObjectKey({ ownerId, patternId, assetId: randomUUID(), extension });

describe("upload filenames", () => {
  it("preserves the canonical object extension while truncating a Unicode stem", () => {
    const result = sanitizeDownloadName("瓜".repeat(200) + ".png", sourceKey("psd"));

    expect(result).toMatch(/\.psd$/);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(180);
    expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("removes quotes, path separators, Cc, and Cf characters", () => {
    const result = sanitizeDownloadName(
      "\"'../safe\u0085\u202E\\name.png",
      sourceKey("psd"),
    );

    expect(result).toBe("..safename.psd");
    expect(result).not.toMatch(/[\p{Cc}\p{Cf}/\\'"]/u);
  });

  it("uses a nonempty fallback stem and supports derived WebP", () => {
    expect(sanitizeDownloadName("\"'", sourceKey("psd"))).toBe("download.psd");
    const key = previewObjectKey({
      ownerId,
      patternId,
      assetId: randomUUID(),
      extension: "webp",
    });
    expect(sanitizeDownloadName("preview.png", key)).toBe("preview.webp");
  });

  it("derives a bounded pattern name without splitting emoji", () => {
    const name = derivePatternName(`${"花".repeat(100)}${"🍉".repeat(80)}.psd`);

    expect(name.length).toBeLessThanOrEqual(160);
    expect(name).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(derivePatternName("---.psd")).toBe("Untitled Pattern");
    expect(derivePatternName(".psd")).toBe("Untitled Pattern");
  });
});
