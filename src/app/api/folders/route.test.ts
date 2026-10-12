import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listFolders: vi.fn(),
  createFolder: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/features/folders/folder-service", () => ({
  listFolders: mocks.listFolders,
  createFolder: mocks.createFolder,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const folderId = "30000000-0000-4000-8000-000000000003";

const expectRequestId = (response: Response) => {
  expect(response.headers.get("x-request-id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
};

describe("folder collection Route Handlers", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.listFolders.mockResolvedValue([{ id: folderId, name: "Summer" }]);
    mocks.createFolder.mockResolvedValue({ id: folderId, name: "Caf\u00e9" });
  });

  it("lists folders using only the authenticated owner", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `http://localhost/api/folders?ownerId=${encodeURIComponent(attackerId)}`,
      ),
    );

    expect(response.status).toBe(200);
    expectRequestId(response);
    await expect(response.json()).resolves.toEqual([
      { id: folderId, name: "Summer" },
    ]);
    expect(mocks.listFolders).toHaveBeenCalledWith({ ownerId });
    expect(mocks.listFolders).not.toHaveBeenCalledWith({ ownerId: attackerId });
  });

  it("creates a canonical folder with the authenticated owner", async () => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          operationId,
          ownerId: attackerId,
          input: {
            name: "  Cafe\u0301  ",
            parentId: folderId,
            ownerId: attackerId,
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expectRequestId(response);
    expect(mocks.createFolder).toHaveBeenCalledWith({
      ownerId,
      operationId,
      name: "Caf\u00e9",
      parentId: folderId,
    });
    expect(mocks.createFolder).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: attackerId }),
    );
  });

  it("rejects cross-origin creates before calling the service", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request(`${ORIGIN}/api/folders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.test",
        },
        body: JSON.stringify({
          operationId: randomUUID(),
          input: { name: "Summer", parentId: null },
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN_ORIGIN",
        message: "Request origin is not allowed",
      },
    });
    expect(mocks.createFolder).not.toHaveBeenCalled();
  });

  it("rejects malformed create bodies before calling the service", async () => {
    const { POST } = await import("./route");
    for (const body of [
      "not-json",
      JSON.stringify({ operationId: randomUUID() }),
      JSON.stringify({
        operationId: randomUUID(),
        input: { name: "Folder", parentId: "not-a-uuid" },
      }),
      JSON.stringify({
        operationId: randomUUID(),
        input: { name: "bad\0name", parentId: null },
      }),
    ]) {
      const response = await POST(
        new Request("http://localhost/api/folders", {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body,
        }),
      );

      expect(response.status).toBe(400);
      expectRequestId(response);
      await expect(response.json()).resolves.toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid request" },
      });
    }
    expect(mocks.createFolder).not.toHaveBeenCalled();
  });

  it("preserves a service AppError code and status", async () => {
    mocks.createFolder.mockRejectedValueOnce(
      new AppError(
        "FOLDER_NAME_CONFLICT",
        409,
        "Folder name already exists",
      ),
    );
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          operationId: randomUUID(),
          input: { name: "Summer", parentId: null },
        }),
      }),
    );

    expect(response.status).toBe(409);
    expectRequestId(response);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FOLDER_NAME_CONFLICT",
        message: "Folder name already exists",
      },
    });
  });
});
