import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { extractProcreateThumbnail } from "./procreate-thumbnail";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

describe("Procreate QuickLook thumbnail extraction", () => {
  it("extracts only the embedded QuickLook PNG", () => {
    const archive = zipSync({
      "Document.archive": new TextEncoder().encode("large document data"),
      "QuickLook/Thumbnail.png": png,
    });

    expect(extractProcreateThumbnail(archive)).toEqual(png);
  });

  it("accepts harmless path and case variations", () => {
    const archive = zipSync({ "/quicklook/thumbnail.PNG": png });
    expect(extractProcreateThumbnail(archive)).toEqual(png);
  });

  it("reports packages without a QuickLook thumbnail as unsupported", () => {
    const archive = zipSync({ "Document.archive": new Uint8Array([1, 2, 3]) });
    expect(() => extractProcreateThumbnail(archive)).toThrow(
      "PREVIEW_UNSUPPORTED",
    );
  });
});
