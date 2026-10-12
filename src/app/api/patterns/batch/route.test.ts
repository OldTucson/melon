import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  batchPatterns: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/features/patterns/pattern-batch-service", () => ({
  batchPatterns: mocks.batchPatterns,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const patternId = "30000000-0000-4000-8000-000000000003";
const folderId = "40000000-0000-4000-8000-000000000004";

const post = (body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}/api/patterns/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("pattern batch Route Handler", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.batchPatterns.mockResolvedValue({
      patterns: [{ id: patternId, version: 1 }],
    });
  });

  it.each([
    {
      action: "move" as const,
      folderId: folderId.toUpperCase(),
    },
    { action: "move" as const, folderId: null },
    { action: "trash" as const },
    { action: "favorite" as const, isFavorite: true },
  ])("authenticates and delegates a normalized $action mutation", async (action) => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(
      post({
        operationId: operationId.toUpperCase(),
        ...action,
        patterns: [{ id: patternId.toUpperCase(), version: 0 }],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      patterns: [{ id: patternId, version: 1 }],
    });
    expect(mocks.batchPatterns).toHaveBeenCalledWith({
      ownerId,
      mutation: {
        operationId,
        ...action,
        ...(action.folderId === undefined
          ? {}
          : { folderId: action.folderId?.toLowerCase() ?? null }),
        patterns: [{ id: patternId, version: 0 }],
      },
    });
  });

  it("rejects cross-origin mutations before reading or delegating the body", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      post(
        {
          operationId: randomUUID(),
          action: "trash",
          patterns: [{ id: patternId, version: 0 }],
        },
        "https://evil.test",
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN_ORIGIN",
        message: "Request origin is not allowed",
      },
    });
    expect(mocks.batchPatterns).not.toHaveBeenCalled();
  });

  it("uses the session owner and rejects an attempted body owner override", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      post({
        operationId: randomUUID(),
        ownerId: attackerId,
        action: "trash",
        patterns: [{ id: patternId, version: 0 }],
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.batchPatterns).not.toHaveBeenCalled();

    const validResponse = await POST(
      post({
        operationId: randomUUID(),
        action: "trash",
        patterns: [{ id: patternId, version: 0 }],
      }),
    );
    expect(validResponse.status).toBe(200);
    expect(mocks.batchPatterns).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerId }),
    );
    expect(mocks.batchPatterns).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: attackerId }),
    );
  });

  it.each([
    ["malformed JSON", "not-json", "VALIDATION_ERROR"],
    [
      "duplicate IDs",
      {
        operationId: randomUUID(),
        action: "trash",
        patterns: [
          { id: patternId, version: 0 },
          { id: patternId, version: 1 },
        ],
      },
      "VALIDATION_ERROR",
    ],
    [
      "case-equivalent IDs",
      {
        operationId: randomUUID(),
        action: "trash",
        patterns: [
          { id: patternId, version: 0 },
          { id: patternId.toUpperCase(), version: 1 },
        ],
      },
      "VALIDATION_ERROR",
    ],
    [
      "an oversized batch",
      {
        operationId: randomUUID(),
        action: "trash",
        patterns: Array.from({ length: 101 }, () => ({
          id: randomUUID(),
          version: 0,
        })),
      },
      "BATCH_LIMIT_EXCEEDED",
    ],
    [
      "an incomplete action",
      {
        operationId: randomUUID(),
        action: "move",
        patterns: [{ id: patternId, version: 0 }],
      },
      "VALIDATION_ERROR",
    ],
  ])("rejects %s with a public 400", async (_name, body, code) => {
    const { POST } = await import("./route");
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(mocks.batchPatterns).not.toHaveBeenCalled();
  });

  it("preserves public service errors", async () => {
    mocks.batchPatterns.mockRejectedValueOnce(
      new AppError("PATTERN_STATE_CHANGED", 409, "Pattern state changed"),
    );
    const { POST } = await import("./route");
    const response = await POST(
      post({
        operationId: randomUUID(),
        action: "favorite",
        patterns: [{ id: patternId, version: 0 }],
        isFavorite: true,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PATTERN_STATE_CHANGED",
        message: "Pattern state changed",
      },
    });
  });
});
