import { describe, expect, it, vi } from "vitest";

import { searchPatternsByPalette } from "./palette-search-client";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

describe("palette search browser client", () => {
  it("posts strict JSON with the caller abort signal", async () => {
    const response = {
      query: { colors: ["#285947", "#CC9C3F"] },
      items: [],
      timing: { totalMs: 25 },
    };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
    const signal = new AbortController().signal;

    await expect(
      searchPatternsByPalette(
        {
          requestId,
          colors: ["#285947", "#CC9C3F"],
          filters: { favorite: true },
          signal,
        },
        { fetcher },
      ),
    ).resolves.toEqual(response);

    expect(fetcher).toHaveBeenCalledWith("/api/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        colors: ["#285947", "#CC9C3F"],
        filters: { favorite: true },
      }),
      signal,
    });
  });
});
