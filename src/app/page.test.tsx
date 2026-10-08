import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect }));

describe("root page", () => {
  it("redirects into the private library", async () => {
    const { default: Page } = await import("./page");
    Page();
    expect(redirect).toHaveBeenCalledWith("/library");
  });
});
