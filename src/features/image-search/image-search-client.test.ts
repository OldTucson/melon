import { describe, expect, it, vi } from "vitest";

import {
  MAX_CLIENT_IMAGE_SEARCH_BYTES,
  searchPatternsByImage,
  validateImageSearchFile,
} from "./image-search-client";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

describe("image search browser client", () => {
  it.each([
    ["query.jpg", "image/jpeg"],
    ["query.JPEG", "image/jpeg"],
    ["query.png", "image/png"],
    ["query.webp", "image/webp"],
    ["query.heic", "image/heic"],
    ["query.heif", "image/heif"],
  ])("accepts the supported extension and MIME pair %s", (name, type) => {
    expect(() => validateImageSearchFile(new File(["image"], name, { type }))).not.toThrow();
  });

  it("rejects unsupported, mismatched, empty, and oversized files locally", () => {
    const mismatched = new File(["image"], "query.png", { type: "image/jpeg" });
    const unsupported = new File(["image"], "query.svg", { type: "image/svg+xml" });
    const empty = new File([], "query.jpg", { type: "image/jpeg" });
    const oversized = new File(["image"], "query.jpg", { type: "image/jpeg" });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: MAX_CLIENT_IMAGE_SEARCH_BYTES + 1,
    });

    for (const file of [mismatched, unsupported, empty]) {
      expect(() => validateImageSearchFile(file)).toThrowError(
        expect.objectContaining({ code: "unsupported" }),
      );
    }
    expect(() => validateImageSearchFile(oversized)).toThrowError(
      expect.objectContaining({ code: "too_large" }),
    );
  });

  it("posts bounded multipart fields with the caller's abort signal", async () => {
    const response = {
      query: { width: 640, height: 480 },
      groups: [],
      timing: { totalMs: 25 },
    };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
    const signal = new AbortController().signal;
    const file = new File(["jpeg"], "query.jpg", { type: "image/jpeg" });

    await expect(
      searchPatternsByImage(
        { file, filters: { favorite: true }, requestId, signal },
        { fetcher },
      ),
    ).resolves.toEqual(response);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, optionalInit] = fetcher.mock.calls[0]!;
    const init = optionalInit!;
    expect(url).toBe("/api/image-search");
    expect(init).toMatchObject({ method: "POST", signal });
    expect(init.headers).toBeUndefined();
    const body = init.body as FormData;
    expect(body.get("image")).toMatchObject({
      name: file.name,
      size: file.size,
      type: file.type,
    });
    expect(body.get("requestId")).toBe(requestId);
    expect(JSON.parse(String(body.get("filters")))).toEqual({ favorite: true });
  });
});
