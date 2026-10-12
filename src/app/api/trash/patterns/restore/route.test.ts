import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  restorePatterns: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/features/trash/trash-service", () => ({
  restorePatterns: mocks.restorePatterns,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const patternId = "30000000-0000-4000-8000-000000000003";

const post = (body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}/api/trash/patterns/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("ordinary trash pattern restore Route Handler", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.restorePatterns.mockResolvedValue({
      state: "restored",
      patterns: [{ id: patternId, status: "ready", version: 2 }],
    });
  });

  it("normalizes identities and delegates with the session owner", async () => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(
      post({
        operationId: operationId.toUpperCase(),
        patternIds: [patternId.toUpperCase()],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "restored",
      patterns: [{ id: patternId, status: "ready", version: 2 }],
    });
    expect(mocks.restorePatterns).toHaveBeenCalledWith({
      ownerId,
      operationId,
      patternIds: [patternId],
    });
  });

  it("rejects cross-origin requests before delegating", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      post(
        { operationId: randomUUID(), patternIds: [patternId] },
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
    expect(mocks.restorePatterns).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "not-json", "VALIDATION_ERROR"],
    [
      "an owner injection",
      {
        operationId: randomUUID(),
        patternIds: [patternId],
        ownerId: attackerId,
      },
      "VALIDATION_ERROR",
    ],
    [
      "duplicate IDs",
      { operationId: randomUUID(), patternIds: [patternId, patternId] },
      "VALIDATION_ERROR",
    ],
    [
      "case-equivalent IDs",
      {
        operationId: randomUUID(),
        patternIds: [patternId, patternId.toUpperCase()],
      },
      "VALIDATION_ERROR",
    ],
    [
      "an oversized selection",
      {
        operationId: randomUUID(),
        patternIds: Array.from({ length: 101 }, () => randomUUID()),
      },
      "BATCH_LIMIT_EXCEEDED",
    ],
  ])("rejects %s", async (_name, body, code) => {
    const { POST } = await import("./route");
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(mocks.restorePatterns).not.toHaveBeenCalled();
  });

  it("preserves public service errors", async () => {
    mocks.restorePatterns.mockRejectedValueOnce(
      new AppError(
        "FOLDER_BATCH_ACTION_REQUIRED",
        409,
        "Folder batch action required",
      ),
    );
    const { POST } = await import("./route");
    const response = await POST(
      post({ operationId: randomUUID(), patternIds: [patternId] }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FOLDER_BATCH_ACTION_REQUIRED",
        message: "Folder batch action required",
      },
    });
  });
});
