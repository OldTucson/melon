import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  editAuthorization: vi.fn(),
  voidAuthorization: vi.fn(),
  restoreAuthorization: vi.fn(),
}));

vi.mock("@/features/auth/api-session", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/features/authorizations/authorization-service", () => ({
  editAuthorization: mocks.editAuthorization,
  voidAuthorization: mocks.voidAuthorization,
  restoreAuthorization: mocks.restoreAuthorization,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const authorizationId = "30000000-0000-4000-8000-000000000003";

describe("authorization item Route Handlers", () => {
  beforeEach(() => {
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.editAuthorization.mockResolvedValue({ id: authorizationId, version: 1 });
    mocks.voidAuthorization.mockResolvedValue({
      id: authorizationId,
      status: "void",
      version: 1,
    });
    mocks.restoreAuthorization.mockResolvedValue({
      id: authorizationId,
      status: "active",
      version: 2,
    });
  });

  it("edits only the validated full record for the authenticated owner", async () => {
    const operationId = randomUUID();
    const body = {
      operationId,
      version: 0,
      commercialVersion: 1,
      kind: "global_buyout",
      fieldId: null,
      licenseeName: "买断客户",
      priceYuan: "5000.00",
      authorizedOn: "2026-10-08",
      note: null,
      historyConfirmed: true,
    };
    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request(`${ORIGIN}/api/authorizations/${authorizationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ ...body, ownerId: attackerId }),
      }),
      { params: Promise.resolve({ authorizationId: authorizationId.toUpperCase() }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.editAuthorization).toHaveBeenCalledWith({
      ownerId,
      authorizationId,
      ...body,
    });
  });

  it("voids and restores with the same status envelope", async () => {
    const body = {
      operationId: randomUUID(),
      version: 0,
      commercialVersion: 1,
    };
    const voidRoute = await import("./void/route");
    const voided = await voidRoute.POST(
      new Request(`${ORIGIN}/api/authorizations/${authorizationId}/void`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ authorizationId }) },
    );
    expect(voided.status).toBe(200);
    expect(mocks.voidAuthorization).toHaveBeenCalledWith({
      ownerId,
      authorizationId,
      ...body,
    });

    const restoreRoute = await import("./restore/route");
    const restored = await restoreRoute.POST(
      new Request(`${ORIGIN}/api/authorizations/${authorizationId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ authorizationId }) },
    );
    expect(restored.status).toBe(200);
    expect(mocks.restoreAuthorization).toHaveBeenCalledWith({
      ownerId,
      authorizationId,
      ...body,
    });
  });

  it("preserves the neutral 404 response for foreign IDs", async () => {
    mocks.editAuthorization.mockRejectedValueOnce(
      new AppError("NOT_FOUND", 404, "Authorization not found"),
    );
    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request(`${ORIGIN}/api/authorizations/${authorizationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          operationId: randomUUID(),
          version: 0,
          commercialVersion: 0,
          kind: "standard",
          fieldId: "00000000-0000-4000-8000-000000000001",
          licenseeName: "客户",
          priceYuan: "100",
          authorizedOn: "2026-10-08",
          note: null,
          historyConfirmed: false,
        }),
      }),
      { params: Promise.resolve({ authorizationId }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Authorization not found" },
    });
  });
});
