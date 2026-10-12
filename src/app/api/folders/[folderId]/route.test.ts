import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  renameFolder: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/features/folders/folder-service", () => ({
  renameFolder: mocks.renameFolder,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const folderId = "30000000-0000-4000-8000-000000000003";

describe("folder item Route Handlers", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.renameFolder.mockResolvedValue({
      id: folderId,
      name: "Caf\u00e9",
      version: 2,
    });
  });

  it("renames using the path identity and authenticated owner only", async () => {
    const operationId = randomUUID();
    const route = await import("./route");
    const response = await route.PATCH(
      new Request(`http://localhost/api/folders/${folderId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          operationId,
          ownerId: attackerId,
          patch: {
            name: "  Cafe\u0301  ",
            version: 1,
            ownerId: attackerId,
          },
        }),
      }),
      { params: Promise.resolve({ folderId: folderId.toUpperCase() }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.renameFolder).toHaveBeenCalledWith({
      ownerId,
      folderId,
      operationId,
      name: "Caf\u00e9",
      version: 1,
    });
    expect(mocks.renameFolder).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: attackerId }),
    );
    expect("DELETE" in route).toBe(false);
  });

  it("rejects cross-origin renames before calling the service", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request(`${ORIGIN}/api/folders/${folderId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.test",
        },
        body: JSON.stringify({
          operationId: randomUUID(),
          patch: { name: "Renamed", version: 0 },
        }),
      }),
      { params: Promise.resolve({ folderId }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN_ORIGIN",
        message: "Request origin is not allowed",
      },
    });
    expect(mocks.renameFolder).not.toHaveBeenCalled();
  });

  it("rejects malformed folder IDs and bodies before calling the service", async () => {
    const { PATCH } = await import("./route");
    const cases = [
      {
        folderId: "not-a-uuid",
        body: JSON.stringify({
          operationId: randomUUID(),
          patch: { name: "Valid", version: 0 },
        }),
      },
      { folderId, body: "not-json" },
      {
        folderId,
        body: JSON.stringify({
          operationId: randomUUID(),
          patch: { name: "Valid", version: -1 },
        }),
      },
    ];

    for (const input of cases) {
      const response = await PATCH(
        new Request(`http://localhost/api/folders/${input.folderId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: input.body,
        }),
        { params: Promise.resolve({ folderId: input.folderId }) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid request" },
      });
    }
    expect(mocks.renameFolder).not.toHaveBeenCalled();
  });

  it("preserves public state-change errors from the service", async () => {
    mocks.renameFolder.mockRejectedValueOnce(
      new AppError("FOLDER_STATE_CHANGED", 409, "Folder state changed"),
    );
    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request(`http://localhost/api/folders/${folderId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          operationId: randomUUID(),
          patch: { name: "Renamed", version: 0 },
        }),
      }),
      { params: Promise.resolve({ folderId }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FOLDER_STATE_CHANGED", message: "Folder state changed" },
    });
  });
});
