import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  purgePatterns: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/features/trash/trash-purge-service", () => ({
  purgePatterns: mocks.purgePatterns,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const patternId = "20000000-0000-4000-8000-000000000002";

const post = (body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}/api/trash/patterns/purge`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("ordinary trash pattern purge Route Handler", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.purgePatterns.mockResolvedValue({
      state: "complete",
      deletedPatternCount: 1,
      deletedFolderCount: 0,
    });
  });

  it("normalizes identities and uses only the session owner", async () => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(
      post({
        operationId: operationId.toUpperCase(),
        patternIds: [patternId.toUpperCase()],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.purgePatterns).toHaveBeenCalledWith({
      ownerId,
      operationId,
      patternIds: [patternId],
    });
  });

  it("rejects cross-origin and owner-injected requests", async () => {
    const { POST } = await import("./route");
    const crossOrigin = await POST(
      post(
        { operationId: randomUUID(), patternIds: [patternId] },
        "https://evil.test",
      ),
    );
    expect(crossOrigin.status).toBe(403);

    const injected = await POST(
      post({
        operationId: randomUUID(),
        patternIds: [patternId],
        ownerId: randomUUID(),
      }),
    );
    expect(injected.status).toBe(400);
    expect(mocks.purgePatterns).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "not-json", "VALIDATION_ERROR"],
    [
      "duplicate IDs",
      { operationId: randomUUID(), patternIds: [patternId, patternId] },
      "VALIDATION_ERROR",
    ],
    [
      "oversized selection",
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
  });

  it("preserves public purge errors", async () => {
    mocks.purgePatterns.mockRejectedValueOnce(
      new AppError("OSS_DELETE_FAILED", 502, "OSS object deletion failed"),
    );
    const { POST } = await import("./route");
    const response = await POST(
      post({ operationId: randomUUID(), patternIds: [patternId] }),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "OSS_DELETE_FAILED",
        message: "OSS object deletion failed",
      },
    });
  });
});
