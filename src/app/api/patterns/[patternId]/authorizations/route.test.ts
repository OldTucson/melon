import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  listAuthorizations: vi.fn(),
  createAuthorization: vi.fn(),
}));

vi.mock("@/features/auth/api-session", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/features/authorizations/authorization-service", () => ({
  listAuthorizations: mocks.listAuthorizations,
  createAuthorization: mocks.createAuthorization,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const ORIGIN = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const patternId = "30000000-0000-4000-8000-000000000003";
const fieldId = "00000000-0000-4000-8000-000000000001";

const payload = () => ({
  operationId: randomUUID(),
  commercialVersion: 0,
  kind: "standard",
  fieldId,
  licenseeName: "示例客户",
  priceYuan: "1280.00",
  authorizedOn: "2026-10-08",
  note: "首批授权",
  historyConfirmed: false,
});

describe("pattern authorization Route Handlers", () => {
  beforeEach(() => {
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.listAuthorizations.mockResolvedValue({
      items: [],
      nextCursor: null,
      commercialVersion: 0,
    });
    mocks.createAuthorization.mockResolvedValue({
      id: randomUUID(),
      priceFen: "128000",
      priceYuan: "1280.00",
    });
  });

  it("parses history options and uses only authenticated ownership", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `${ORIGIN}/api/patterns/${patternId}/authorizations?includeVoid=true&limit=20&cursor=opaque&ownerId=${attackerId}`,
      ),
      { params: Promise.resolve({ patternId: patternId.toUpperCase() }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.listAuthorizations).toHaveBeenCalledWith({
      ownerId,
      patternId,
      includeVoid: true,
      limit: 20,
      cursor: "opaque",
    });
  });

  it("creates from validated strings and ignores injected ownership", async () => {
    const input = payload();
    const { POST } = await import("./route");
    const response = await POST(
      new Request(`${ORIGIN}/api/patterns/${patternId}/authorizations`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ ...input, ownerId: attackerId, priceFen: "1" }),
      }),
      { params: Promise.resolve({ patternId }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.createAuthorization).toHaveBeenCalledWith({
      ownerId,
      patternId,
      ...input,
    });
    await expect(response.json()).resolves.toMatchObject({
      priceFen: "128000",
      priceYuan: "1280.00",
    });
  });

  it("rejects malformed type, field, amount, date, and path before service", async () => {
    const { POST } = await import("./route");
    const cases = [
      { path: "bad", body: payload() },
      { path: patternId, body: { ...payload(), kind: "unknown" } },
      { path: patternId, body: { ...payload(), fieldId: null } },
      { path: patternId, body: { ...payload(), priceYuan: "1.234" } },
      { path: patternId, body: { ...payload(), authorizedOn: "2026-02-29" } },
    ];

    for (const input of cases) {
      const response = await POST(
        new Request(`${ORIGIN}/api/patterns/${input.path}/authorizations`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify(input.body),
        }),
        { params: Promise.resolve({ patternId: input.path }) },
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.createAuthorization).not.toHaveBeenCalled();
  });

  it("preserves commercial conflict details", async () => {
    mocks.createAuthorization.mockRejectedValueOnce(
      new AppError(
        "AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED",
        409,
        "Authorization history confirmation is required",
        { activeCount: 2 },
      ),
    );
    const { POST } = await import("./route");
    const response = await POST(
      new Request(`${ORIGIN}/api/patterns/${patternId}/authorizations`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(payload()),
      }),
      { params: Promise.resolve({ patternId }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED",
        message: "Authorization history confirmation is required",
        details: { activeCount: 2 },
      },
    });
  });
});
