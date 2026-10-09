import { describe, expect, it } from "vitest";

import { patternQuerySchema } from "@/features/patterns/contracts";
import {
  ApiResponseError,
  createQueryClient,
  getQueryClient,
} from "@/lib/query/provider";
import { queryKeys } from "@/lib/query/keys";

import {
  parseLibrarySearchParams,
  serializeLibrarySearchParams,
  toPatternQuery,
} from "./query-state";

const tagA = "00000000-0000-4000-8000-000000000001";
const tagB = "00000000-0000-4000-8000-000000000002";

describe("library query state", () => {
  it("round-trips the plan's opaque tag tokens in canonical parameter order", () => {
    const state = parseLibrarySearchParams(
      new URLSearchParams(
        "q=leaf&format=psd&tag=t1&tag=t2&tagMode=all&sort=name_asc",
      ),
    );

    expect(state).toMatchObject({
      q: "leaf",
      formats: ["psd"],
      tagIds: ["t1", "t2"],
      tagMode: "all",
      sort: "name_asc",
    });
    expect(serializeLibrarySearchParams(state).toString()).toBe(
      "q=leaf&format=psd&tag=t1&tag=t2&tagMode=all&sort=name_asc",
    );
  });

  it("canonicalizes equivalent parameter order without losing values", () => {
    const state = parseLibrarySearchParams(
      new URLSearchParams(
        `sort=name_asc&tag=${tagB}&q=leaf&format=png&tagMode=all&format=psd&tag=${tagA}`,
      ),
    );

    expect(serializeLibrarySearchParams(state).toString()).toBe(
      `q=leaf&format=psd&format=png&tag=${tagA}&tag=${tagB}&tagMode=all&sort=name_asc`,
    );
  });

  it("accepts Task 5 aliases without dropping repeated values", () => {
    const state = parseLibrarySearchParams(
      new URLSearchParams(
        `formats=png&format=png&tagIds=${tagB}&tag=${tagA}&favorite=true`,
      ),
    );

    expect(state.formats).toEqual(["png", "png"]);
    expect(state.tagIds).toEqual([tagA, tagB]);
    expect(serializeLibrarySearchParams(state).getAll("format")).toEqual([
      "png",
      "png",
    ]);
    expect(serializeLibrarySearchParams(state).getAll("tag")).toEqual([
      tagA,
      tagB,
    ]);
  });

  it("round-trips the untagged library view through the production query", () => {
    const state = parseLibrarySearchParams(
      new URLSearchParams("untagged=true"),
    );

    expect(state.untagged).toBe("true");
    expect(toPatternQuery(state).untagged).toBe(true);
    expect(serializeLibrarySearchParams(state).toString()).toBe(
      "untagged=true",
    );
  });

  it("separates URL round-trip state from the production Zod boundary", () => {
    expect(() =>
      toPatternQuery(
        parseLibrarySearchParams(
          new URLSearchParams("format=svg&favorite=sometimes"),
        ),
      ),
    ).toThrow();
    expect(() =>
      toPatternQuery(
        parseLibrarySearchParams(new URLSearchParams("tag=not-a-uuid")),
      ),
    ).toThrow();

    expect(
      patternQuerySchema.safeParse(
        toPatternQuery(
          parseLibrarySearchParams(new URLSearchParams("format=psd")),
        ),
      ).success,
    ).toBe(true);
  });

  it("produces exact, stable query keys for canonical state", () => {
    const first = toPatternQuery(
      parseLibrarySearchParams(
        new URLSearchParams(`tag=${tagB}&tag=${tagA}&format=png&format=psd`),
      ),
    );
    const second = toPatternQuery(
      parseLibrarySearchParams(
        new URLSearchParams(`format=psd&format=png&tag=${tagA}&tag=${tagB}`),
      ),
    );

    expect(queryKeys.patterns(first)).toEqual(["patterns", second]);
    expect(queryKeys.pattern("pattern-1")).toEqual(["pattern", "pattern-1"]);
    expect(queryKeys.tags).toEqual(["tags"]);
  });
});

describe("query client policy", () => {
  it("retries transient reads twice, never 4xx reads, and never mutations", () => {
    const client = createQueryClient();
    const queryRetry = client.getDefaultOptions().queries?.retry;

    expect(typeof queryRetry).toBe("function");
    if (typeof queryRetry !== "function") return;

    expect(queryRetry(0, new TypeError("offline"))).toBe(true);
    expect(queryRetry(1, new ApiResponseError(503, "UNAVAILABLE"))).toBe(
      true,
    );
    expect(queryRetry(2, new ApiResponseError(503, "UNAVAILABLE"))).toBe(
      false,
    );
    expect(queryRetry(0, new ApiResponseError(404, "NOT_FOUND"))).toBe(
      false,
    );
    expect(client.getDefaultOptions().mutations?.retry).toBe(0);
  });

  it("keeps one query client for the browser session", () => {
    expect(getQueryClient()).toBe(getQueryClient());
  });
});
