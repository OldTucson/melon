import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InspirationSharedDocumentDto } from "@/features/inspiration-visuals/document-contracts";
import {
  inspirationResultFixture,
  inspirationSourceFixture,
} from "@/features/inspiration/test-fixtures";
import { AppError } from "@/lib/http/app-error";

const { getSharedInspirationDocument } = vi.hoisted(() => ({
  getSharedInspirationDocument: vi.fn(),
}));
vi.mock("@/features/inspiration/share-service", () => ({
  getSharedInspirationDocument,
}));

import { composePublicInspirationDocument } from "@/features/inspiration-visuals/document-composer";
import { webHeroAssetFixture } from "@/features/inspiration-visuals/test-fixtures";

const shareId = "00000000-0000-4000-8000-000000000009";
const analysis: InspirationSharedDocumentDto = {
  title: "公开女装研究",
  prompt: "分析近 30 天都市轻通勤女装",
  completedAt: "2026-10-28T02:00:00.000Z",
  document: composePublicInspirationDocument({ shareId, sources: [inspirationSourceFixture], result: inspirationResultFixture, webEvidence: [webHeroAssetFixture] }),
};

beforeEach(() => {
  getSharedInspirationDocument.mockReset();
});
afterEach(cleanup);

describe("public inspiration route", () => {
  it("awaits Next Promise params and reads a public DTO by the opaque share string", async () => {
    getSharedInspirationDocument.mockImplementation(async (id: string) => {
      if (id !== shareId) throw new Error("Unexpected public lookup");
      return analysis;
    });
    const { default: Page } = await import("./page");
    render(await Page({ params: Promise.resolve({ shareId }) }));
    expect(
      screen.getByRole("heading", { level: 1, name: "公开女装研究" }),
    ).toBeVisible();
    expect(screen.getByText("分析近 30 天都市轻通勤女装")).toBeVisible();
    expect(screen.getByText("2026-10-28")).toHaveAttribute(
      "datetime",
      analysis.completedAt,
    );
    expect(screen.getByRole("region", { name: "研究来源" })).toBeVisible();
    expect(screen.getByText("1 个来源 · 1 张视觉素材")).toBeVisible();
    expect(screen.getByRole("img")).toHaveAttribute("src", `/share/inspiration/${shareId}/assets/${webHeroAssetFixture.id}`);
    expect(getSharedInspirationDocument).toHaveBeenCalledExactlyOnceWith(shareId);
  });

  it("disables route caching and search indexing", async () => {
    const { dynamic, metadata } = await import("./page");
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it.each([
    "not-a-uuid",
    "",
    "../private",
    `${shareId}?ownerId=secret`,
    "00000000-0000-0000-0000-000000000009",
  ])(
    "returns notFound for malformed public ID %j before querying",
    async (id) => {
      getSharedInspirationDocument.mockResolvedValue(analysis);
      const { default: Page } = await import("./page");
      await expect(
        Page({ params: Promise.resolve({ shareId: id }) }),
      ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(getSharedInspirationDocument).not.toHaveBeenCalled();
    },
  );

  it("maps the service's unknown share 404 to notFound", async () => {
    getSharedInspirationDocument.mockRejectedValue(
      new AppError("INSPIRATION_NOT_FOUND", 404, "Private failure details"),
    );
    const { default: Page } = await import("./page");
    await expect(
      Page({ params: Promise.resolve({ shareId }) }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("checks the service again on the next request so a revoked share is immediately unavailable", async () => {
    getSharedInspirationDocument
      .mockResolvedValueOnce(analysis)
      .mockRejectedValueOnce(
        new AppError("INSPIRATION_NOT_FOUND", 404, "Not found"),
      );
    const { default: Page } = await import("./page");
    render(await Page({ params: Promise.resolve({ shareId }) }));
    expect(
      screen.getByRole("heading", { level: 1, name: "公开女装研究" }),
    ).toBeVisible();
    cleanup();
    await expect(
      Page({ params: Promise.resolve({ shareId }) }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it.each([
    new AppError("INTERNAL_ERROR", 503, "Private database failure"),
    new Error("Unexpected internal failure"),
    Object.assign(new Error("Not an AppError"), { status: 404 }),
  ])(
    "propagates unexpected failures to the server boundary: %s",
    async (error) => {
      getSharedInspirationDocument.mockRejectedValue(error);
      const { default: Page } = await import("./page");
      await expect(Page({ params: Promise.resolve({ shareId }) })).rejects.toBe(
        error,
      );
    },
  );
});
