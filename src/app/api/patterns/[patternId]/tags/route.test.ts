import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listPatternTags: vi.fn(),
  addTagToPattern: vi.fn(),
  removeTagFromPattern: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/features/tags/tag-service", () => ({
  listPatternTags: mocks.listPatternTags,
  addTagToPattern: mocks.addTagToPattern,
  removeTagFromPattern: mocks.removeTagFromPattern,
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const patternId = "30000000-0000-4000-8000-000000000003";
const tagId = "40000000-0000-4000-8000-000000000004";

const context = { params: Promise.resolve({ patternId }) };
const relationContext = { params: Promise.resolve({ patternId, tagId }) };

describe("pattern tag Route Handlers", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.listPatternTags.mockResolvedValue({ items: [] });
    mocks.addTagToPattern.mockResolvedValue({ patternId, tagId, isActive: true });
    mocks.removeTagFromPattern.mockResolvedValue({
      patternId,
      tagId,
      isActive: false,
    });
  });

  it("lists active relations with only the authenticated owner", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `http://localhost/api/patterns/${patternId}/tags?ownerId=${attackerId}`,
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(mocks.listPatternTags).toHaveBeenCalledWith({ ownerId, patternId });
  });

  it.each([
    ["PUT", "addTagToPattern", true],
    ["DELETE", "removeTagFromPattern", false],
  ] as const)(
    "%s mutates the relation with the authenticated owner and operation envelope",
    async (method, serviceName, isActive) => {
      const operationId = randomUUID();
      const handlers = await import("./[tagId]/route");
      const response = await handlers[method](
        new Request(
          `http://localhost/api/patterns/${patternId}/tags/${tagId}`,
          {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId, ownerId: attackerId }),
          },
        ),
        relationContext,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBeTruthy();
      expect(mocks[serviceName]).toHaveBeenCalledWith({
        ownerId,
        patternId,
        tagId,
        operationId,
      });
      await expect(response.json()).resolves.toMatchObject({ isActive });
    },
  );

  it("authenticates before parsing relation params or body", async () => {
    mocks.requireUser.mockRejectedValueOnce(new Error("AUTH_SENTINEL"));
    const { PUT } = await import("./[tagId]/route");
    const response = await PUT(
      new Request("http://localhost/api/patterns/not-uuid/tags/not-uuid", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
      { params: Promise.resolve({ patternId: "not-uuid", tagId: "not-uuid" }) },
    );

    expect(response.status).toBe(500);
    expect(mocks.addTagToPattern).not.toHaveBeenCalled();
  });

  it("rejects malformed relation input with a stable 400", async () => {
    const handlers = await import("./[tagId]/route");
    for (const [method, body, params] of [
      ["PUT", "not-json", { patternId, tagId }],
      ["DELETE", JSON.stringify({ operationId: "not-uuid" }), { patternId, tagId }],
      ["PUT", JSON.stringify({ operationId: randomUUID() }), { patternId: "bad", tagId }],
    ] as const) {
      const response = await handlers[method](
        new Request(
          `http://localhost/api/patterns/${params.patternId}/tags/${params.tagId}`,
          {
            method,
            headers: { "content-type": "application/json" },
            body,
          },
        ),
        { params: Promise.resolve(params) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "VALIDATION_ERROR", message: "Invalid request" },
      });
    }
    expect(mocks.addTagToPattern).not.toHaveBeenCalled();
    expect(mocks.removeTagFromPattern).not.toHaveBeenCalled();
  });

  it("preserves the tenant-safe 404 response shape", async () => {
    mocks.listPatternTags.mockRejectedValueOnce(
      new AppError("NOT_FOUND", 404, "Pattern not found"),
    );
    const { GET } = await import("./route");
    const response = await GET(
      new Request(`http://localhost/api/patterns/${patternId}/tags`),
      context,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Pattern not found" },
    });
  });

  it("sanitizes unexpected relation failures", async () => {
    mocks.removeTagFromPattern.mockRejectedValueOnce(
      new Error("SQL relation password_hash stack secret"),
    );
    const { DELETE } = await import("./[tagId]/route");
    const response = await DELETE(
      new Request(
        `http://localhost/api/patterns/${patternId}/tags/${tagId}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operationId: randomUUID() }),
        },
      ),
      relationContext,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(body).not.toMatch(/SQL|relation|password_hash|stack|secret/i);
  });
});
