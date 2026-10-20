import { describe, expect, it, vi } from "vitest";

import {
  classifyAiPrefix,
  generatePreview,
  resolvePreviewKind,
} from "./preview-pipeline";

const result = {
  preview: new Blob(["preview"], { type: "image/webp" }),
  thumbnail: new Blob(["thumbnail"], { type: "image/webp" }),
  previewWidth: 100,
  previewHeight: 80,
  thumbnailWidth: 50,
  thumbnailHeight: 40,
  outputType: "image/webp" as const,
};

describe("preview pipeline", () => {
  it.each([
    ["leaf.jpg", "raster"],
    ["leaf.PNG", "raster"],
    ["repeat.psd", "psd"],
    ["boards.ai", "ai"],
    ["catalog.pdf", "pdf"],
    ["sketch.procreate", "procreate"],
    ["notes.txt", null],
  ] as const)("classifies %s as %s", (filename, kind) => {
    expect(resolvePreviewKind(filename)).toBe(kind);
  });

  it("classifies PDF-compatible and PostScript AI prefixes", () => {
    expect(classifyAiPrefix(new TextEncoder().encode("%PDF-1.7"))).toBe("pdf");
    expect(classifyAiPrefix(new TextEncoder().encode("%!PS-Adobe-3.0"))).toBe(
      "postscript",
    );
    expect(classifyAiPrefix(new TextEncoder().encode("unknown"))).toBe("unknown");
  });

  it("dispatches PDF-compatible AI to the PDF renderer", async () => {
    const pdf = vi.fn(async () => result);
    const file = new File(["%PDF-1.7\nfixture"], "boards.ai");

    await expect(
      generatePreview(file, {
        raster: vi.fn(),
        psd: vi.fn(),
        pdf,
        procreate: vi.fn(),
      }),
    ).resolves.toBe(result);
    expect(pdf).toHaveBeenCalledWith(file);
  });

  it("leaves PostScript-only AI downloadable without starting a renderer", async () => {
    const pdf = vi.fn();
    await expect(
      generatePreview(new File(["%!PS-Adobe-3.0"], "legacy.ai"), {
        raster: vi.fn(),
        psd: vi.fn(),
        pdf,
        procreate: vi.fn(),
      }),
    ).resolves.toBeNull();
    expect(pdf).not.toHaveBeenCalled();
  });
});
