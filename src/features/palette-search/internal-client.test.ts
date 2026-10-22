import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createInternalPaletteSearchClient } from "./internal-client";

const ownerId = "10000000-0000-4000-8000-000000000001";
const patternId = "20000000-0000-4000-8000-000000000002";
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const colors = ["#285947", "#CC9C3F"] as const;
const config = {
  serviceUrl: "http://127.0.0.1:8091",
  token: "t".repeat(32),
};

function searchInput(signal = new AbortController().signal) {
  return {
    ownerId,
    allowedPatternIds: [patternId],
    requestId,
    colors,
    signal,
  };
}

describe("internal palette search client", () => {
  it("posts the strict JSON boundary with bearer auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        redirect: "error",
      });
      expect(new Headers(init?.headers)).toMatchObject(expect.any(Headers));
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${config.token}`,
      );
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/json",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        ownerId,
        allowedPatternIds: [patternId],
        requestId,
        colors,
      });
      return Response.json({
        requestId,
        query: { colors },
        items: [{ patternId, distance: 0.0125 }],
      });
    });
    const client = createInternalPaletteSearchClient(config, fetchImpl);

    await expect(client.search(searchInput())).resolves.toEqual({
      requestId,
      query: { colors },
      items: [{ patternId, distance: 0.0125 }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8091/internal/palette-search",
      expect.any(Object),
    );
  });

  it.each([
    ["INVALID_COLORS", "PALETTE_SEARCH_INVALID_COLORS", 400],
    ["NO_INDEX", "PALETTE_SEARCH_NO_INDEX", 409],
    ["TIMEOUT", "PALETTE_SEARCH_TIMEOUT", 504],
    ["UNAVAILABLE", "PALETTE_SEARCH_UNAVAILABLE", 503],
  ] as const)("maps internal %s to public %s", async (internal, code, status) => {
    const client = createInternalPaletteSearchClient(
      config,
      vi.fn(async () =>
        Response.json({ detail: { code: internal } }, { status }),
      ),
    );

    await expect(client.search(searchInput())).rejects.toMatchObject({
      code,
      status,
    });
  });

  it("collapses malformed, mismatched, and network responses without leaking internals", async () => {
    const responses = [
      vi.fn(async () => Response.json({ token: config.token, items: [] })),
      vi.fn(async () =>
        Response.json({
          requestId: randomUUID(),
          query: { colors },
          items: [],
        }),
      ),
      vi.fn(async () => {
        throw new Error(`connect failed with ${config.token}`);
      }),
    ];

    for (const fetchImpl of responses) {
      const client = createInternalPaletteSearchClient(config, fetchImpl);
      let thrown: unknown;
      try {
        await client.search(searchInput());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "PALETTE_SEARCH_UNAVAILABLE",
        status: 503,
      });
      expect(String(thrown)).not.toContain(config.token);
    }
  });

  it("propagates caller cancellation to the internal fetch", async () => {
    const caller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    let receivedSignal: AbortSignal | undefined;
    const client = createInternalPaletteSearchClient(
      config,
      vi.fn((_url, init) => {
        receivedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason),
            { once: true },
          );
        });
      }),
    );
    const pending = client.search(searchInput(caller.signal));

    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("maps its own 12-second deadline to the stable timeout error", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const client = createInternalPaletteSearchClient(
      config,
      vi.fn((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
      ),
    );
    const pending = client.search(searchInput());

    timeout.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({
      code: "PALETTE_SEARCH_TIMEOUT",
      status: 504,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(12_000);
  });
});
