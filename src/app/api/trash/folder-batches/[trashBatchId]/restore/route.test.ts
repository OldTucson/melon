import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  restoreFolderBatch: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/features/trash/trash-service", () => ({
  restoreFolderBatch: mocks.restoreFolderBatch,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const trashBatchId = "30000000-0000-4000-8000-000000000003";

const post = (body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}/api/trash/folder-batches/${trashBatchId}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("folder trash batch restore Route Handler", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.restoreFolderBatch.mockResolvedValue({
      state: "restored",
      trashBatchId,
      rootFolderId: "40000000-0000-4000-8000-000000000004",
      folderCount: 2,
      patternCount: 3,
    });
  });

  it("uses normalized path identity and the session owner only", async () => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(post({ operationId: operationId.toUpperCase() }), {
      params: Promise.resolve({ trashBatchId: trashBatchId.toUpperCase() }),
    });

    expect(response.status).toBe(200);
    expect(mocks.restoreFolderBatch).toHaveBeenCalledWith({
      ownerId,
      operationId,
      trashBatchId,
    });
  });

  it("rejects cross-origin requests before delegating", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      post({ operationId: randomUUID() }, "https://evil.test"),
      { params: Promise.resolve({ trashBatchId }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN_ORIGIN" },
    });
    expect(mocks.restoreFolderBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid path", "not-a-uuid", { operationId: randomUUID() }],
    ["malformed JSON", trashBatchId, "not-json"],
    [
      "an owner injection",
      trashBatchId,
      { operationId: randomUUID(), ownerId: attackerId },
    ],
    [
      "a batch injection",
      trashBatchId,
      { operationId: randomUUID(), trashBatchId: randomUUID() },
    ],
  ])("rejects %s", async (_name, pathId, body) => {
    const { POST } = await import("./route");
    const response = await POST(post(body), {
      params: Promise.resolve({ trashBatchId: pathId }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid request" },
    });
    expect(mocks.restoreFolderBatch).not.toHaveBeenCalled();
  });

  it("preserves public service errors", async () => {
    mocks.restoreFolderBatch.mockRejectedValueOnce(
      new AppError("FOLDER_NOT_ACTIVE", 409, "Folder is not active"),
    );
    const { POST } = await import("./route");
    const response = await POST(post({ operationId: randomUUID() }), {
      params: Promise.resolve({ trashBatchId }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FOLDER_NOT_ACTIVE", message: "Folder is not active" },
    });
  });
});
