import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listTags: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/features/tags/tag-service", () => ({
  listTags: mocks.listTags,
  createTag: mocks.createTag,
  updateTag: mocks.updateTag,
  deleteTag: mocks.deleteTag,
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const tagId = "30000000-0000-4000-8000-000000000003";

describe("tag Route Handlers", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.listTags.mockResolvedValue([]);
    mocks.createTag.mockResolvedValue({ id: tagId, name: "Summer" });
    mocks.updateTag.mockResolvedValue({ id: tagId, name: "Renamed" });
    mocks.deleteTag.mockResolvedValue({ id: tagId, deleted: true });
  });

  it("lists tags for the authenticated owner and ignores an attacker query owner", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/tags?ownerId=${attackerId}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(mocks.listTags).toHaveBeenCalledWith({ ownerId });
  });

  it("creates a validated tag with an operation envelope and authenticated owner", async () => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          input: {
            name: "  Summer  ",
            colorToken: "green",
            ownerId: attackerId,
          },
          ownerId: attackerId,
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.createTag).toHaveBeenCalledWith({
      ownerId,
      operationId,
      name: "Summer",
      colorToken: "green",
    });
  });

  it("updates only name and color through the authenticated owner", async () => {
    const operationId = randomUUID();
    const { PATCH } = await import("./[tagId]/route");
    const response = await PATCH(
      new Request(`http://localhost/api/tags/${tagId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          ownerId: attackerId,
          patch: { name: " Renamed ", colorToken: "purple", ownerId: attackerId },
        }),
      }),
      { params: Promise.resolve({ tagId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.updateTag).toHaveBeenCalledWith({
      ownerId,
      tagId,
      operationId,
      patch: { name: "Renamed", colorToken: "purple" },
    });
  });

  it("soft-deletes with a required operation ID and authenticated owner", async () => {
    const operationId = randomUUID();
    const { DELETE } = await import("./[tagId]/route");
    const response = await DELETE(
      new Request(`http://localhost/api/tags/${tagId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, ownerId: attackerId }),
      }),
      { params: Promise.resolve({ tagId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.deleteTag).toHaveBeenCalledWith({ ownerId, tagId, operationId });
  });

  it("rejects unknown palette tokens before calling the service", async () => {
    const { POST } = await import("./route");
    for (const input of [
      { name: "Summer", colorToken: "chartreuse" },
      { name: "bad\0name", colorToken: "green" },
    ]) {
      const response = await POST(
        new Request("http://localhost/api/tags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationId: randomUUID(), input }),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid request" },
      });
    }
    expect(mocks.createTag).not.toHaveBeenCalled();
  });

  it("uses the stable 404 shape for unknown and foreign tags", async () => {
    mocks.updateTag.mockRejectedValueOnce(
      new AppError("NOT_FOUND", 404, "Tag not found"),
    );
    const { PATCH } = await import("./[tagId]/route");
    const response = await PATCH(
      new Request(`http://localhost/api/tags/${tagId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: randomUUID(),
          patch: { name: "Nope" },
        }),
      }),
      { params: Promise.resolve({ tagId }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Tag not found" },
    });
  });

  it("sanitizes unexpected failures", async () => {
    mocks.deleteTag.mockRejectedValueOnce(
      new Error("SQL tags password_hash stack secret"),
    );
    const { DELETE } = await import("./[tagId]/route");
    const response = await DELETE(
      new Request(`http://localhost/api/tags/${tagId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: randomUUID() }),
      }),
      { params: Promise.resolve({ tagId }) },
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(body).not.toMatch(/SQL|tags|password_hash|stack|secret/i);
  });
});
