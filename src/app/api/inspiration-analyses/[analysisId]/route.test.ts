import { beforeEach, describe, expect, it, vi } from "vitest";

import { inspirationDetailFixture } from "@/features/inspiration/test-fixtures";
import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  getInspirationAnalysis: vi.fn(),
  renameInspirationAnalysis: vi.fn(),
  deleteInspirationAnalysis: vi.fn(),
  retryInspirationAnalysis: vi.fn(),
}));
vi.mock("@/features/auth/api-session", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/features/inspiration/analysis-service", () => ({
  getInspirationAnalysis: mocks.getInspirationAnalysis,
  renameInspirationAnalysis: mocks.renameInspirationAnalysis,
  deleteInspirationAnalysis: mocks.deleteInspirationAnalysis,
  retryInspirationAnalysis: mocks.retryInspirationAnalysis,
}));
vi.mock("@/lib/env/server", () => ({ getServerEnv: () => ({ APP_ORIGIN: "https://app.example.test" }) }));

const origin = "https://app.example.test";
const ownerId = "10000000-0000-4000-8000-000000000001";
const analysisId = "abcdef00-0000-4000-8000-000000000001";
const invalid = { error: { code: "INSPIRATION_INVALID_INPUT", message: "Invalid inspiration request" } };
const context = (id = analysisId) => ({ params: Promise.resolve({ analysisId: id }) });
const request = (method: string, body?: string) => new Request(`http://internal-proxy/api/inspiration-analyses/${analysisId}`, {
  method, headers: { "content-type": "application/json", origin }, ...(body === undefined ? {} : { body }),
});
const actions = [
  { name: "detail", method: "GET", service: mocks.getInspirationAnalysis, load: async () => (await import("./route")).GET, body: undefined },
  { name: "rename", method: "PATCH", service: mocks.renameInspirationAnalysis, load: async () => (await import("./route")).PATCH, body: JSON.stringify({ title: "  新标题 e\u0301  ", version: 4 }) },
  { name: "delete", method: "DELETE", service: mocks.deleteInspirationAnalysis, load: async () => (await import("./route")).DELETE, body: undefined },
  { name: "retry", method: "POST", service: mocks.retryInspirationAnalysis, load: async () => (await import("./retry/route")).POST, body: undefined },
];

describe("inspiration detail and retry Route Handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.getInspirationAnalysis.mockResolvedValue(inspirationDetailFixture);
    mocks.renameInspirationAnalysis.mockResolvedValue({ ...inspirationDetailFixture, title: "新标题 é", version: 5 });
    mocks.deleteInspirationAnalysis.mockResolvedValue({ id: analysisId, deleted: true });
    mocks.retryInspirationAnalysis.mockResolvedValue(inspirationDetailFixture);
  });

  it.each(actions)("returns the $name result for only the session owner with a normalized ID", async (action) => {
    const handler = await action.load();
    const req = request(action.method, action.body);
    if (action.method === "GET") req.headers.delete("origin");
    const response = await handler(req, context(analysisId.toUpperCase()));
    expect(response.status).toBe(200);
    expect(action.service).toHaveBeenCalledExactlyOnceWith({ ownerId, analysisId, ...(action.name === "rename" ? { title: "新标题 é", version: 4 } : {}) });
    await expect(response.json()).resolves.toEqual(action.name === "delete" ? { id: analysisId, deleted: true } : action.name === "rename" ? { ...inspirationDetailFixture, title: "新标题 é", version: 5 } : inspirationDetailFixture);
  });

  it.each(actions)("rejects an invalid $name path before service work", async (action) => {
    const handler = await action.load();
    const response = await handler(request(action.method, action.body), context("invalid-id"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalid);
    expect(action.service).not.toHaveBeenCalled();
  });

  it.each(actions)("authenticates $name before accessing params, body, or origin", async (action) => {
    mocks.requireApiUser.mockRejectedValue(new AppError("UNAUTHORIZED", 401, "Authentication required"));
    const req = request(action.method, action.method === "GET" ? undefined : "{");
    req.headers.delete("origin");
    const read = vi.spyOn(req, "json");
    const readParams = vi.fn(() => Promise.resolve({ analysisId: "bad" }));
    const handler = await action.load();
    const response = await handler(req, { get params() { return readParams(); } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    expect(readParams).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(action.service).not.toHaveBeenCalled();
  });

  for (const action of actions.filter((action) => action.method !== "GET")) {
    it.each([null, "null", "https://evil.example"])(`checks origin %j for ${action.name} before parsing`, async (requestOrigin) => {
      const req = request(action.method, "{");
      if (requestOrigin === null) req.headers.delete("origin"); else req.headers.set("origin", requestOrigin);
      const read = vi.spyOn(req, "json");
      const readParams = vi.fn(() => Promise.resolve({ analysisId: "bad" }));
      const handler = await action.load();
      const response = await handler(req, { get params() { return readParams(); } });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN_ORIGIN", message: "Request origin is not allowed" } });
      expect(readParams).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(action.service).not.toHaveBeenCalled();
    });
  }

  it.each([
    "{", "", "null", JSON.stringify({ title: "", version: 0 }), JSON.stringify({ title: "标题", version: -1 }),
    JSON.stringify({ title: "标题" }), JSON.stringify({ title: "标题", version: 0, ownerId: "attacker" }),
    JSON.stringify({ title: "标题", version: 0, prompt: "forbidden" }),
  ])("rejects malformed or non-title PATCH body %s", async (body) => {
    const { PATCH } = await import("./route");
    const response = await PATCH(request("PATCH", body), context());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalid);
    expect(mocks.renameInspirationAnalysis).not.toHaveBeenCalled();
  });

  it.each(actions.filter((action) => action.name === "delete" || action.name === "retry"))("does not read an unintended $name body", async (action) => {
    const req = request(action.method, "{malformed ignored body");
    const read = vi.spyOn(req, "json");
    const handler = await action.load();
    const response = await handler(req, context());
    expect(response.status).toBe(200);
    expect(read).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
    expect(action.service).toHaveBeenCalledExactlyOnceWith({ ownerId, analysisId });
  });

  for (const action of actions) {
    it.each([
      { state: "missing", targetId: "99999999-0000-4000-8000-000000000009" },
      { state: "foreign", targetId: analysisId },
    ])(`preserves the same 404 for ${action.name} on a $state record`, async ({ targetId }) => {
      action.service.mockRejectedValue(new AppError("INSPIRATION_NOT_FOUND", 404, "Inspiration analysis not found"));
      const handler = await action.load();
      const response = await handler(request(action.method, action.body), context(targetId));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: { code: "INSPIRATION_NOT_FOUND", message: "Inspiration analysis not found" } });
      expect(action.service).toHaveBeenCalledWith(expect.objectContaining({ ownerId, analysisId: targetId }));
    });
  }

  it.each(actions.filter((action) => action.method !== "GET"))("preserves pending/state conflicts for $name", async (action) => {
    action.service.mockRejectedValue(new AppError("INSPIRATION_BUSY", 409, "Inspiration analysis state changed or is busy"));
    const handler = await action.load();
    const response = await handler(request(action.method, action.body), context());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "INSPIRATION_BUSY", message: "Inspiration analysis state changed or is busy" } });
  });

  it("returns the safe persisted ID when retry fails upstream", async () => {
    mocks.retryInspirationAnalysis.mockRejectedValue(new AppError("INSPIRATION_STRUCTURE_INVALID", 502, "Inspiration analysis failed", { analysisId }));
    const { POST } = await import("./retry/route");
    const response = await POST(request("POST"), context());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: { code: "INSPIRATION_STRUCTURE_INVALID", message: "Inspiration analysis failed", details: { analysisId } } });
  });
});
