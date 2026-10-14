import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  listAuthorizationFields: vi.fn(),
  createAuthorizationField: vi.fn(),
  archiveAuthorizationField: vi.fn(),
}));

vi.mock("@/features/auth/api-session", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/features/authorizations/field-service", () => ({
  listAuthorizationFields: mocks.listAuthorizationFields,
  createAuthorizationField: mocks.createAuthorizationField,
  archiveAuthorizationField: mocks.archiveAuthorizationField,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const fieldId = "30000000-0000-4000-8000-000000000003";

describe("authorization field Route Handlers", () => {
  beforeEach(() => {
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.listAuthorizationFields.mockResolvedValue([]);
    mocks.createAuthorizationField.mockResolvedValue({ id: fieldId, name: "童装" });
    mocks.archiveAuthorizationField.mockResolvedValue({
      id: fieldId,
      name: "童装",
      status: "archived",
    });
  });

  it("returns a stable 401 without a session", async () => {
    mocks.requireApiUser.mockRejectedValueOnce(
      new AppError("UNAUTHORIZED", 401, "Authentication required"),
    );
    const { GET } = await import("./route");
    const response = await GET(new Request(`${ORIGIN}/api/authorization-fields`));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });

  it("lists active fields for only the authenticated owner", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `${ORIGIN}/api/authorization-fields?ownerId=${attackerId}&includeArchived=true`,
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.listAuthorizationFields).toHaveBeenCalledWith({
      ownerId,
      includeArchived: true,
    });
  });

  it("creates and archives custom fields without trusting body ownership", async () => {
    const createOperationId = randomUUID();
    const collection = await import("./route");
    const created = await collection.POST(
      new Request(`${ORIGIN}/api/authorization-fields`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          operationId: createOperationId,
          name: "童装",
          ownerId: attackerId,
        }),
      }),
    );
    expect(created.status).toBe(201);
    expect(mocks.createAuthorizationField).toHaveBeenCalledWith({
      ownerId,
      operationId: createOperationId,
      name: "童装",
    });

    const archiveOperationId = randomUUID();
    const item = await import("./[fieldId]/route");
    const archived = await item.DELETE(
      new Request(`${ORIGIN}/api/authorization-fields/${fieldId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ operationId: archiveOperationId, ownerId: attackerId }),
      }),
      { params: Promise.resolve({ fieldId: fieldId.toUpperCase() }) },
    );
    expect(archived.status).toBe(200);
    expect(mocks.archiveAuthorizationField).toHaveBeenCalledWith({
      ownerId,
      fieldId,
      operationId: archiveOperationId,
    });
  });

  it("maps invalid input and name conflicts without calling across boundaries", async () => {
    const { POST } = await import("./route");
    const malformed = await POST(
      new Request(`${ORIGIN}/api/authorization-fields`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ operationId: "bad", name: "" }),
      }),
    );
    expect(malformed.status).toBe(400);

    mocks.createAuthorizationField.mockRejectedValueOnce(
      new AppError(
        "AUTHORIZATION_FIELD_EXISTS",
        409,
        "Authorization field already exists",
      ),
    );
    const conflict = await POST(
      new Request(`${ORIGIN}/api/authorization-fields`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ operationId: randomUUID(), name: "家居服" }),
      }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "AUTHORIZATION_FIELD_EXISTS",
        message: "Authorization field already exists",
      },
    });
  });
});
