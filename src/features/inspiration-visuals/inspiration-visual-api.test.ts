import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiResponseError } from "@/lib/query/client";

import { inspirationVisualApi } from "./inspiration-visual-api";
import { inspirationVisualKeys } from "./query-keys";
import { visualBoardFixture } from "./test-fixtures";

const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status });

describe("inspiration visual browser API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("gets a strictly validated board from a normalized path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(visualBoardFixture));
    const analysisId = "ABCDEF00-0000-4000-8000-000000000001";
    const signal = new AbortController().signal;

    await expect(inspirationVisualApi.get(analysisId, signal)).resolves.toEqual(
      visualBoardFixture,
    );
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/inspiration-analyses/abcdef00-0000-4000-8000-000000000001/visuals",
      { signal },
    );
  });

  it("validates create input before POST and validates the response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(visualBoardFixture, 201));
    const analysisId = randomUUID();
    const operationId = randomUUID();

    await expect(
      inspirationVisualApi.create(analysisId, { operationId }),
    ).resolves.toEqual(visualBoardFixture);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `/api/inspiration-analyses/${analysisId}/visuals`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId }),
      },
    );

    expect(() =>
      inspirationVisualApi.create(analysisId, {
        operationId: "bad",
      }),
    ).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...visualBoardFixture, ownerId: randomUUID() }),
    );
    await expect(inspirationVisualApi.get(analysisId)).rejects.toThrow();
  });

  it("preserves structured HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "INSPIRATION_VISUALS_UNAVAILABLE",
            message: "Inspiration visuals failed",
            details: { jobId: randomUUID() },
          },
        },
        503,
      ),
    );

    await expect(inspirationVisualApi.get(randomUUID())).rejects.toBeInstanceOf(
      ApiResponseError,
    );
  });

  it("scopes visual query keys below the owned analysis detail", () => {
    const ownerId = randomUUID();
    const analysisId = randomUUID();
    expect(inspirationVisualKeys.detail(ownerId, analysisId)).toEqual([
      "owner",
      ownerId,
      "inspiration",
      "detail",
      analysisId,
      "visuals",
    ]);
  });
});
