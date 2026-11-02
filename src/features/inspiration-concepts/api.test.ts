import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conceptSetFixture } from "./test-fixtures";
import { ApiResponseError } from "@/lib/query/client";
import {
  fetchConceptSets,
  createConceptSetRequest,
  retryConceptOutputRequest,
  regenerateConceptSetRequest,
  deleteConceptSetRequest,
} from "./api";
import { inspirationConceptKeys } from "./query-keys";
const analysisId = "abcdef00-0000-4000-8000-000000000001";
const setId = conceptSetFixture.id;
const root = `/api/inspiration-analyses/${analysisId}/concept-sets`;
const input = {
  operationId: randomUUID(),
  directionIndex: 0,
  visualJobId: null,
  referenceAssetIds: [],
};
const retry = { operationId: randomUUID() };
const fetcher = vi.fn<typeof fetch>();
describe("parsed concept browser clients", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetcher);
    fetcher.mockReset();
    fetcher.mockImplementation(async () => Response.json(conceptSetFixture));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("fetches uncached lists with cancellation and normalized paths", async () => {
    fetcher.mockResolvedValue(Response.json([conceptSetFixture]));
    const signal = new AbortController().signal;
    expect(await fetchConceptSets(analysisId.toUpperCase(), signal)).toEqual([
      conceptSetFixture,
    ]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(root, {
      signal,
      cache: "no-store",
    });
  });
  it("posts strict create, retry, and regeneration bodies to local routes", async () => {
    expect(await createConceptSetRequest(analysisId, input)).toEqual(
      conceptSetFixture,
    );
    expect(
      await retryConceptOutputRequest(analysisId, setId, "effect", retry),
    ).toEqual(conceptSetFixture);
    expect(
      await retryConceptOutputRequest(analysisId, setId, "flat", retry),
    ).toEqual(conceptSetFixture);
    expect(await regenerateConceptSetRequest(analysisId, setId, retry)).toEqual(
      conceptSetFixture,
    );
    expect(
      fetcher.mock.calls.map(([url, options]) => [
        url,
        options?.method,
        JSON.parse(options?.body as string),
      ]),
    ).toEqual([
      [root, "POST", input],
      [`${root}/${setId}/outputs/effect/retry`, "POST", retry],
      [`${root}/${setId}/outputs/flat/retry`, "POST", retry],
      [`${root}/${setId}/regenerate`, "POST", retry],
    ]);
  });
  it("handles 204 deletion without trying to parse JSON", async () => {
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      deleteConceptSetRequest(analysisId, setId),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${root}/${setId}`, {
      method: "DELETE",
    });
  });
  it("uses the shared safe API error utility", async () => {
    fetcher.mockResolvedValue(
      Response.json(
        { error: { code: "INSPIRATION_CONCEPT_BUSY", message: "Busy" } },
        { status: 409 },
      ),
    );
    await expect(
      createConceptSetRequest(analysisId, input),
    ).rejects.toBeInstanceOf(ApiResponseError);
    fetcher.mockResolvedValue(
      Response.json(
        { error: { code: "INSPIRATION_NOT_FOUND", message: "Missing" } },
        { status: 404 },
      ),
    );
    await expect(
      deleteConceptSetRequest(analysisId, setId),
    ).rejects.toMatchObject({ status: 404, code: "INSPIRATION_NOT_FOUND" });
  });
  it.each([
    {},
    { ...conceptSetFixture, ownerId: "private" },
    { ...conceptSetFixture, slots: [] },
  ])("rejects invalid response DTOs before caching", async (bad) => {
    fetcher.mockImplementation(async () => Response.json(bad));
    await expect(createConceptSetRequest(analysisId, input)).rejects.toThrow();
    await expect(
      regenerateConceptSetRequest(analysisId, setId, retry),
    ).rejects.toThrow();
    await expect(
      retryConceptOutputRequest(analysisId, setId, "flat", retry),
    ).rejects.toThrow();
    fetcher.mockImplementation(async () => Response.json([bad]));
    await expect(fetchConceptSets(analysisId)).rejects.toThrow();
  });
  it("bounds the response list", async () => {
    fetcher.mockResolvedValue(Response.json(Array(16).fill(conceptSetFixture)));
    await expect(fetchConceptSets(analysisId)).rejects.toThrow();
  });
  it("rejects malformed paths and extra mutation fields before fetch", async () => {
    await expect(fetchConceptSets("bad")).rejects.toThrow();
    await expect(
      createConceptSetRequest(analysisId, {
        ...input,
        ownerId: "private",
      } as typeof input),
    ).rejects.toThrow();
    await expect(
      regenerateConceptSetRequest(analysisId, "bad", retry),
    ).rejects.toThrow();
    await expect(
      retryConceptOutputRequest(analysisId, setId, "sketch" as "effect", retry),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps owner and analysis caches separate and stable", () => {
    expect(inspirationConceptKeys.all("owner-a")).toEqual([
      "inspiration-concepts",
      "owner-a",
    ]);
    expect(inspirationConceptKeys.analysis("owner-a", analysisId)).toEqual([
      "inspiration-concepts",
      "owner-a",
      analysisId,
    ]);
    expect(inspirationConceptKeys.analysis("owner-a", analysisId)).not.toEqual(
      inspirationConceptKeys.analysis("owner-b", analysisId),
    );
    expect(inspirationConceptKeys.analysis("owner-a", analysisId)).not.toEqual(
      inspirationConceptKeys.analysis("owner-a", setId),
    );
  });
});
