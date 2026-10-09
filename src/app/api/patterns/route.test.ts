import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listPatterns: vi.fn(),
  getPattern: vi.fn(),
  updatePattern: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));

vi.mock("@/features/patterns/pattern-service", () => ({
  listPatterns: mocks.listPatterns,
  getPattern: mocks.getPattern,
  updatePattern: mocks.updatePattern,
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const patternId = "30000000-0000-4000-8000-000000000003";

const expectRequestId = (response: Response) => {
  expect(response.headers.get("x-request-id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
};

describe("pattern Route Handlers", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.listPatterns.mockResolvedValue({ items: [], nextCursor: null });
    mocks.getPattern.mockResolvedValue({ id: patternId, name: "Pattern" });
    mocks.updatePattern.mockResolvedValue({
      id: patternId,
      name: "Renamed",
      version: 1,
    });
  });

  it("parses repeated formats and tag IDs without trusting query ownerId", async () => {
    const tagA = randomUUID();
    const tagB = randomUUID();
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `http://localhost/api/patterns?formats=psd&formats=png&tagIds=${tagA}&tagIds=${tagB}&tagMode=any&favorite=true&ownerId=${attackerId}`,
      ),
    );

    expect(response.status).toBe(200);
    expectRequestId(response);
    expect(mocks.listPatterns).toHaveBeenCalledWith({
      ownerId,
      input: expect.objectContaining({
        formats: ["psd", "png"],
        tagIds: [tagA, tagB],
        tagMode: "any",
        favorite: true,
      }),
    });
    expect(mocks.listPatterns).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: attackerId }),
    );
  });

  it("accepts the task-6 singular query aliases while preserving repeated values", async () => {
    const tagA = randomUUID();
    const tagB = randomUUID();
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `http://localhost/api/patterns?format=ai&format=jpg&tag=${tagA}&tag=${tagB}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.listPatterns).toHaveBeenCalledWith({
      ownerId,
      input: expect.objectContaining({
        formats: ["ai", "jpg"],
        tagIds: [tagA, tagB],
      }),
    });
  });

  it("authenticates before parsing query input", async () => {
    const authFailure = new Error("AUTH_SENTINEL");
    mocks.requireUser.mockRejectedValueOnce(authFailure);
    const { GET } = await import("./route");

    const response = await GET(
      new Request("http://localhost/api/patterns?limit=not-a-number"),
    );

    expect(response.status).toBe(500);
    expect(mocks.listPatterns).not.toHaveBeenCalled();
  });

  it("maps Zod failures to a stable 400 response", async () => {
    const { GET } = await import("./route");
    for (const q of ["x".repeat(101), "bad\0query"]) {
      const response = await GET(
        new Request(
          `http://localhost/api/patterns?q=${encodeURIComponent(q)}`,
        ),
      );

      expect(response.status).toBe(400);
      expectRequestId(response);
      await expect(response.json()).resolves.toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid request" },
      });
    }
    expect(mocks.listPatterns).not.toHaveBeenCalled();
  });

  it("returns AppError status and shape with a request ID", async () => {
    mocks.listPatterns.mockRejectedValueOnce(
      new AppError("INVALID_CURSOR", 400, "Invalid cursor"),
    );
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/patterns"));

    expect(response.status).toBe(400);
    expectRequestId(response);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_CURSOR", message: "Invalid cursor" },
    });
  });

  it("sanitizes unknown errors without leaking database details or stack traces", async () => {
    mocks.listPatterns.mockRejectedValueOnce(
      new Error("SQL select * from users password_hash stack secret"),
    );
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/patterns"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expectRequestId(response);
    expect(JSON.parse(body)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(body).not.toMatch(/SQL|users|password_hash|stack|secret/i);
  });

  it("loads a detail with only the authenticated owner", async () => {
    const { GET } = await import("./[patternId]/route");
    const response = await GET(
      new Request(
        `http://localhost/api/patterns/${patternId}?ownerId=${attackerId}`,
      ),
      { params: Promise.resolve({ patternId }) },
    );

    expect(response.status).toBe(200);
    expectRequestId(response);
    expect(mocks.getPattern).toHaveBeenCalledWith({ ownerId, patternId });
  });

  it("passes only the authenticated owner and validated patch envelope", async () => {
    const operationId = randomUUID();
    const { PATCH } = await import("./[patternId]/route");
    const response = await PATCH(
      new Request(`http://localhost/api/patterns/${patternId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          ownerId: attackerId,
          patch: {
            version: 0,
            name: "  Renamed  ",
            ownerId: attackerId,
          },
        }),
      }),
      { params: Promise.resolve({ patternId }) },
    );

    expect(response.status).toBe(200);
    expectRequestId(response);
    expect(mocks.updatePattern).toHaveBeenCalledWith({
      ownerId,
      patternId,
      operationId,
      patch: { version: 0, name: "Renamed" },
    });
  });

  it("uses the same 404 response shape for unknown and cross-owner details", async () => {
    const { GET } = await import("./[patternId]/route");

    for (const target of [patternId, randomUUID()]) {
      mocks.getPattern.mockRejectedValueOnce(
        new AppError("NOT_FOUND", 404, "Pattern not found"),
      );
      const response = await GET(
        new Request(`http://localhost/api/patterns/${target}`),
        { params: Promise.resolve({ patternId: target }) },
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "NOT_FOUND", message: "Pattern not found" },
      });
    }
  });

  it("rejects malformed JSON and non-patch fields with a stable 400", async () => {
    const { PATCH } = await import("./[patternId]/route");
    for (const body of [
      "not-json",
      JSON.stringify({
        operationId: randomUUID(),
        patch: { version: 0, originalFilename: "stolen.psd" },
      }),
      JSON.stringify({
        operationId: randomUUID(),
        patch: { version: 0, name: "bad\0name" },
      }),
    ]) {
      const response = await PATCH(
        new Request(`http://localhost/api/patterns/${patternId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body,
        }),
        { params: Promise.resolve({ patternId }) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid request" },
      });
    }
    expect(mocks.updatePattern).not.toHaveBeenCalled();
  });
});
