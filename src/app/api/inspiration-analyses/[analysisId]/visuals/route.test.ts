import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { visualBoardFixture } from "@/features/inspiration-visuals/test-fixtures";
import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  getInspirationVisualBoard: vi.fn(),
  createResearchVisuals: vi.fn(),
}));

vi.mock("@/features/auth/api-session", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/features/inspiration-visuals/visual-service", () => ({
  getInspirationVisualBoard: mocks.getInspirationVisualBoard,
  createResearchVisuals: mocks.createResearchVisuals,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "https://app.example.test" }),
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const analysisId = "abcdef00-0000-4000-8000-000000000001";
const endpoint = `http://internal-proxy/api/inspiration-analyses/${analysisId}/visuals`;
const origin = "https://app.example.test";
const invalid = {
  error: {
    code: "INSPIRATION_INVALID_INPUT",
    message: "Invalid inspiration request",
  },
};
const context = (id = analysisId) => ({
  params: Promise.resolve({ analysisId: id }),
});
const request = (method: "GET" | "POST", body?: string) =>
  new Request(endpoint, {
    method,
    headers: {
      ...(method === "POST" ? { origin } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });

describe("inspiration visual Route Handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.getInspirationVisualBoard.mockResolvedValue(visualBoardFixture);
    mocks.createResearchVisuals.mockResolvedValue(visualBoardFixture);
  });

  it("gets the normalized owned board without requiring an origin", async () => {
    const { GET } = await import("./route");
    const response = await GET(request("GET"), context(analysisId.toUpperCase()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(visualBoardFixture);
    expect(mocks.getInspirationVisualBoard).toHaveBeenCalledExactlyOnceWith({
      ownerId,
      analysisId,
    });
    expect(response.headers.get("x-request-id")).toMatch(/^[\da-f-]{36}$/);
  });

  it("creates visuals for only the session owner and returns 201", async () => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(
      request("POST", JSON.stringify({ operationId })),
      context(),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(visualBoardFixture);
    expect(mocks.createResearchVisuals).toHaveBeenCalledExactlyOnceWith({
      ownerId,
      analysisId,
      operationId,
    });
  });

  it("returns the replayed board without starting client-visible special handling", async () => {
    const replay = {
      ...visualBoardFixture,
      refreshJob: {
        ...visualBoardFixture.activeJob,
        status: "pending",
        completedAt: null,
      },
    };
    mocks.createResearchVisuals.mockResolvedValue(replay);
    const { POST } = await import("./route");
    const response = await POST(
      request("POST", JSON.stringify({ operationId: randomUUID() })),
      context(),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(replay);
    expect(mocks.createResearchVisuals).toHaveBeenCalledTimes(1);
  });

  it.each(["GET", "POST"] as const)(
    "authenticates %s before params, origin, or body",
    async (method) => {
      mocks.requireApiUser.mockRejectedValue(
        new AppError("UNAUTHORIZED", 401, "Authentication required"),
      );
      const req = request(method, method === "POST" ? "{" : undefined);
      if (method === "POST") req.headers.set("origin", "https://evil.example");
      const read = vi.spyOn(req, "json");
      const readParams = vi.fn(() => Promise.resolve({ analysisId: "bad" }));
      const { GET, POST } = await import("./route");
      const response = await (method === "GET" ? GET : POST)(req, {
        get params() {
          return readParams();
        },
      });

      expect(response.status).toBe(401);
      expect(readParams).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(mocks.getInspirationVisualBoard).not.toHaveBeenCalled();
      expect(mocks.createResearchVisuals).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "POST"] as const)(
    "rejects an invalid %s path before service work",
    async (method) => {
      const { GET, POST } = await import("./route");
      const response = await (method === "GET" ? GET : POST)(
        request(
          method,
          method === "POST"
            ? JSON.stringify({ operationId: randomUUID() })
            : undefined,
        ),
        context("invalid-id"),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual(invalid);
      expect(mocks.getInspirationVisualBoard).not.toHaveBeenCalled();
      expect(mocks.createResearchVisuals).not.toHaveBeenCalled();
    },
  );

  it.each([null, "null", "https://evil.example", `${origin}:444`])(
    "rejects POST origin %j before params or body",
    async (requestOrigin) => {
      const req = request("POST", "{");
      if (requestOrigin === null) req.headers.delete("origin");
      else req.headers.set("origin", requestOrigin);
      const read = vi.spyOn(req, "json");
      const readParams = vi.fn(() => Promise.resolve({ analysisId: "bad" }));
      const { POST } = await import("./route");
      const response = await POST(req, {
        get params() {
          return readParams();
        },
      });

      expect(response.status).toBe(403);
      expect(readParams).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(mocks.createResearchVisuals).not.toHaveBeenCalled();
    },
  );

  it.each([
    "{",
    "",
    "null",
    JSON.stringify({ operationId: "bad" }),
    JSON.stringify({ operationId: randomUUID(), ownerId }),
    JSON.stringify({ operationId: randomUUID(), directionIndex: 0 }),
  ])("rejects malformed or additional POST input %s", async (body) => {
    const { POST } = await import("./route");
    const response = await POST(request("POST", body), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalid);
    expect(mocks.createResearchVisuals).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"] as const)(
    "preserves the same 404 for missing or foreign %s records",
    async (method) => {
      const service =
        method === "GET"
          ? mocks.getInspirationVisualBoard
          : mocks.createResearchVisuals;
      service.mockRejectedValue(
        new AppError(
          "INSPIRATION_NOT_FOUND",
          404,
          "Inspiration analysis not found",
        ),
      );
      const { GET, POST } = await import("./route");
      const response = await (method === "GET" ? GET : POST)(
        request(
          method,
          method === "POST"
            ? JSON.stringify({ operationId: randomUUID() })
            : undefined,
        ),
        context(),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "INSPIRATION_NOT_FOUND",
          message: "Inspiration analysis not found",
        },
      });
    },
  );

  it("returns only a safe job ID for visual failures", async () => {
    const jobId = randomUUID();
    mocks.createResearchVisuals.mockRejectedValue(
      new AppError(
        "INSPIRATION_VISUALS_UNAVAILABLE",
        503,
        "Inspiration visuals failed",
        { jobId },
      ),
    );
    const { POST } = await import("./route");
    const response = await POST(
      request("POST", JSON.stringify({ operationId: randomUUID() })),
      context(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INSPIRATION_VISUALS_UNAVAILABLE",
        message: "Inspiration visuals failed",
        details: { jobId },
      },
    });
  });

  it("redacts unexpected service failures", async () => {
    mocks.createResearchVisuals.mockRejectedValue(
      new Error("private provider payload"),
    );
    const { POST } = await import("./route");
    const response = await POST(
      request("POST", JSON.stringify({ operationId: randomUUID() })),
      context(),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });
});
