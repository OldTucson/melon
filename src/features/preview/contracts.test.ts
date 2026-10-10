import { describe, expect, it } from "vitest";

import {
  MAX_PIXELS,
  assertPixelBudget,
  fitWithin,
  selectOutputType,
} from "./contracts";

describe("raster preview contracts", () => {
  it("fits a large image inside the requested long edge", () => {
    expect(fitWithin({ width: 4000, height: 2000 }, 2048)).toEqual({
      width: 2048,
      height: 1024,
    });
  });

  it("keeps transparent output lossless and uses WebP otherwise", () => {
    expect(selectOutputType({ hasAlpha: true })).toBe("image/png");
    expect(selectOutputType({ hasAlpha: false })).toBe("image/webp");
  });

  it("rejects source images over the 100 MP budget", () => {
    expect(() =>
      assertPixelBudget({ width: 12_000, height: 9_000 }),
    ).toThrow("PREVIEW_PIXEL_LIMIT");
    expect(() => assertPixelBudget({ width: 10_000, height: 10_000 })).not.toThrow();
    expect(MAX_PIXELS).toBe(100_000_000);
  });
});
