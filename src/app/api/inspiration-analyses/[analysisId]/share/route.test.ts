import { beforeEach, describe, expect, it, vi } from "vitest";

import { inspirationDetailFixture } from "@/features/inspiration/test-fixtures";
import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({ requireApiUser: vi.fn(), enableInspirationShare: vi.fn(), disableInspirationShare: vi.fn() }));
vi.mock("@/features/auth/api-session", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/features/inspiration/share-service", () => ({ enableInspirationShare: mocks.enableInspirationShare, disableInspirationShare: mocks.disableInspirationShare }));
vi.mock("@/lib/env/server", () => ({ getServerEnv: () => ({ APP_ORIGIN: "https://app.example.test" }) }));

const origin = "https://app.example.test";
const ownerId = "10000000-0000-4000-8000-000000000001";
const analysisId = "abcdef00-0000-4000-8000-000000000001";
const shareUrl = "https://app.example.test/share/inspiration/00000000-0000-4000-8000-000000000099";
const context = (id = analysisId) => ({ params: Promise.resolve({ analysisId: id }) });
const request = (method: string) => new Request(`https://attacker-host.example/api/inspiration-analyses/${analysisId}/share?ownerId=attacker`, {
  method, headers: { origin, "content-type": "application/json" }, body: "{malformed ignored body",
});
const actions = [
  { method: "POST" as const, service: mocks.enableInspirationShare },
  { method: "DELETE" as const, service: mocks.disableInspirationShare },
];

describe("inspiration share Route Handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.enableInspirationShare.mockResolvedValue({ ...inspirationDetailFixture, shareUrl, version: 2 });
    mocks.disableInspirationShare.mockResolvedValue({ ...inspirationDetailFixture, shareUrl: null, version: 3 });
  });

  it.each(actions)("$method returns the share service result for the session owner without parsing a body", async (action) => {
    const route = await import("./route");
    const req = request(action.method);
    const read = vi.spyOn(req, "json");
    const response = await route[action.method](req, context(analysisId.toUpperCase()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...inspirationDetailFixture, shareUrl: action.method === "POST" ? shareUrl : null, version: action.method === "POST" ? 2 : 3 });
    expect(action.service).toHaveBeenCalledExactlyOnceWith({ ownerId, analysisId });
    expect(read).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
    expect(response.headers.get("x-request-id")).toMatch(/^[\da-f-]{36}$/);
  });

  it.each(actions)("$method authenticates before params, body, or origin", async (action) => {
    mocks.requireApiUser.mockRejectedValue(new AppError("UNAUTHORIZED", 401, "Authentication required"));
    const route = await import("./route");
    const req = request(action.method);
    req.headers.delete("origin");
    const read = vi.spyOn(req, "json");
    const readParams = vi.fn(() => Promise.resolve({ analysisId: "bad" }));
    const response = await route[action.method](req, { get params() { return readParams(); } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    expect(readParams).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(action.service).not.toHaveBeenCalled();
  });

  for (const action of actions) {
    it.each([null, "null", "https://attacker-host.example"])(`${action.method} rejects origin %j before params`, async (requestOrigin) => {
      const route = await import("./route");
      const req = request(action.method);
      if (requestOrigin === null) req.headers.delete("origin"); else req.headers.set("origin", requestOrigin);
      const readParams = vi.fn(() => Promise.resolve({ analysisId: "bad" }));
      const response = await route[action.method](req, { get params() { return readParams(); } });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN_ORIGIN", message: "Request origin is not allowed" } });
      expect(readParams).not.toHaveBeenCalled();
      expect(action.service).not.toHaveBeenCalled();
    });

    it.each([
      { state: "missing", targetId: "99999999-0000-4000-8000-000000000009" },
      { state: "foreign", targetId: analysisId },
    ])(`${action.method} keeps $state IDs indistinguishable`, async ({ targetId }) => {
      action.service.mockRejectedValue(new AppError("INSPIRATION_NOT_FOUND", 404, "Inspiration analysis not found"));
      const route = await import("./route");
      const response = await route[action.method](request(action.method), context(targetId));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: { code: "INSPIRATION_NOT_FOUND", message: "Inspiration analysis not found" } });
      expect(action.service).toHaveBeenCalledExactlyOnceWith({ ownerId, analysisId: targetId });
    });
  }

  it.each(actions)("$method rejects an invalid path before the share service", async (action) => {
    const route = await import("./route");
    const response = await route[action.method](request(action.method), context("bad"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "INSPIRATION_INVALID_INPUT", message: "Invalid inspiration request" } });
    expect(action.service).not.toHaveBeenCalled();
  });

  it.each(actions)("$method preserves pending/state conflicts", async (action) => {
    action.service.mockRejectedValue(new AppError("INSPIRATION_BUSY", 409, "Inspiration analysis state changed or is busy"));
    const route = await import("./route");
    const response = await route[action.method](request(action.method), context());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "INSPIRATION_BUSY", message: "Inspiration analysis state changed or is busy" } });
  });
});
