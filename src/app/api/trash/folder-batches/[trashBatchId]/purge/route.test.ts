import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  purgeFolderBatch: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/features/trash/trash-purge-service", () => ({
  purgeFolderBatch: mocks.purgeFolderBatch,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const trashBatchId = "20000000-0000-4000-8000-000000000002";
const post = (body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}/api/trash/folder-batches/${trashBatchId}/purge`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("folder trash batch purge Route Handler", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.purgeFolderBatch.mockResolvedValue({
      state: "complete",
      deletedPatternCount: 2,
      deletedFolderCount: 3,
    });
  });

  it("normalizes path identity and delegates with the session owner", async () => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(post({ operationId: operationId.toUpperCase() }), {
      params: Promise.resolve({ trashBatchId: trashBatchId.toUpperCase() }),
    });

    expect(response.status).toBe(200);
    expect(mocks.purgeFolderBatch).toHaveBeenCalledWith({
      ownerId,
      operationId,
      trashBatchId,
    });
  });

  it("rejects cross-origin and injected batch identities", async () => {
    const { POST } = await import("./route");
    const crossOrigin = await POST(
      post({ operationId: randomUUID() }, "https://evil.test"),
      { params: Promise.resolve({ trashBatchId }) },
    );
    expect(crossOrigin.status).toBe(403);

    const injected = await POST(
      post({ operationId: randomUUID(), trashBatchId: randomUUID() }),
      { params: Promise.resolve({ trashBatchId }) },
    );
    expect(injected.status).toBe(400);
    expect(mocks.purgeFolderBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid path", "not-a-uuid", { operationId: randomUUID() }],
    ["malformed JSON", trashBatchId, "not-json"],
    [
      "owner injection",
      trashBatchId,
      { operationId: randomUUID(), ownerId: randomUUID() },
    ],
  ])("rejects %s", async (_name, pathId, body) => {
    const { POST } = await import("./route");
    const response = await POST(post(body), {
      params: Promise.resolve({ trashBatchId: pathId }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });
});
