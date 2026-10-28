import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { inspirationDetailFixture, inspirationSummaryFixture } from "@/features/inspiration/test-fixtures";
import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  createInspirationAnalysis: vi.fn(),
  listInspirationAnalyses: vi.fn(),
}));
vi.mock("@/features/auth/api-session", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/features/inspiration/analysis-service", () => ({
  createInspirationAnalysis: mocks.createInspirationAnalysis,
  listInspirationAnalyses: mocks.listInspirationAnalyses,
}));
vi.mock("@/lib/env/server", () => ({ getServerEnv: () => ({ APP_ORIGIN: "https://app.example.test" }) }));

const origin = "https://app.example.test";
const endpoint = "http://internal-proxy/api/inspiration-analyses";
const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const invalid = { error: { code: "INSPIRATION_INVALID_INPUT", message: "Invalid inspiration request" } };
const createRequest = (body: string, requestOrigin: string | undefined = origin) => new Request(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", ...(requestOrigin === undefined ? {} : { origin: requestOrigin }) },
  body,
});

describe("inspiration collection Route Handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.createInspirationAnalysis.mockResolvedValue(inspirationDetailFixture);
    mocks.listInspirationAnalyses.mockResolvedValue({ items: [inspirationSummaryFixture], nextCursor: null });
  });

  it("creates a normalized prompt for the session owner and returns 201", async () => {
    const operationId = randomUUID();
    const { POST } = await import("./route");
    const response = await POST(createRequest(JSON.stringify({ operationId, prompt: "  分析都市轻通勤女装 e\u0301  " })));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(inspirationDetailFixture);
    expect(response.headers.get("x-request-id")).toMatch(/^[\da-f-]{36}$/);
    expect(mocks.createInspirationAnalysis).toHaveBeenCalledExactlyOnceWith({ ownerId, operationId, prompt: "分析都市轻通勤女装 é" });
  });

  it.each([
    { operationId: "bad", prompt: "分析都市轻通勤女装" },
    { operationId: "00000000-0000-4000-8000-000000000003", prompt: "短" },
    { operationId: "00000000-0000-4000-8000-000000000003", prompt: "分析都市轻通勤女装", ownerId: attackerId },
    { operationId: "00000000-0000-4000-8000-000000000003", prompt: "分析都市轻通勤女装", title: "forbidden" },
    null,
  ])("rejects invalid or ownership-bearing create input %j before service work", async (body) => {
    const { POST } = await import("./route");
    const response = await POST(createRequest(JSON.stringify(body)));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalid);
    expect(mocks.createInspirationAnalysis).not.toHaveBeenCalled();
  });

  it.each(["{", ""])("maps malformed JSON %j to the feature error", async (body) => {
    const { POST } = await import("./route");
    const response = await POST(createRequest(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalid);
    expect(mocks.createInspirationAnalysis).not.toHaveBeenCalled();
  });

  it("authenticates before reading a create body or checking origin", async () => {
    mocks.requireApiUser.mockRejectedValue(new AppError("UNAUTHORIZED", 401, "Authentication required"));
    const request = createRequest("{", "https://evil.example");
    const read = vi.spyOn(request, "json");
    const { POST } = await import("./route");
    const response = await POST(request);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.createInspirationAnalysis).not.toHaveBeenCalled();
  });

  it.each([null, "null", "https://evil.example", "https://app.example.test:444"])("checks configured origin %j before body parsing", async (requestOrigin) => {
    const request = createRequest("{", requestOrigin ?? origin);
    if (requestOrigin === null) request.headers.delete("origin");
    const read = vi.spyOn(request, "json");
    const { POST } = await import("./route");
    const response = await POST(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "FORBIDDEN_ORIGIN", message: "Request origin is not allowed" } });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.createInspirationAnalysis).not.toHaveBeenCalled();
  });

  it("lists only the session owner with the default limit and no origin requirement", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request(endpoint));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [inspirationSummaryFixture], nextCursor: null });
    expect(mocks.listInspirationAnalyses).toHaveBeenCalledExactlyOnceWith({ ownerId, limit: 20 });
  });

  it("parses the list limit and preserves a valid opaque cursor", async () => {
    const cursor = Buffer.from('{"updatedAt":"2026-10-28T01:00:00.123456Z","id":"00000000-0000-4000-8000-000000000001"}').toString("base64url");
    const { GET } = await import("./route");
    const response = await GET(new Request(`${endpoint}?limit=7&cursor=${cursor}`));
    expect(response.status).toBe(200);
    expect(mocks.listInspirationAnalyses).toHaveBeenCalledExactlyOnceWith({ ownerId, limit: 7, cursor });
  });

  it.each(["limit=0", "limit=101", "limit=1.5", "limit=abc", "cursor=", "cursor=not-a-cursor", "ownerId=attacker", "unknown=1", "limit=7&limit=8", "cursor=a&cursor=b"])("rejects invalid list query %s", async (query) => {
    const { GET } = await import("./route");
    const response = await GET(new Request(`${endpoint}?${query}`));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(invalid);
    expect(mocks.listInspirationAnalyses).not.toHaveBeenCalled();
  });

  it("authenticates before reading the list URL", async () => {
    mocks.requireApiUser.mockRejectedValue(new AppError("UNAUTHORIZED", 401, "Authentication required"));
    const request = new Request(endpoint);
    const readUrl = vi.spyOn(request, "url", "get");
    const { GET } = await import("./route");
    expect((await GET(request)).status).toBe(401);
    expect(readUrl).not.toHaveBeenCalled();
    expect(mocks.listInspirationAnalyses).not.toHaveBeenCalled();
  });

  it("returns only the safe persisted analysis ID for a provider failure", async () => {
    mocks.createInspirationAnalysis.mockRejectedValue(new AppError("INSPIRATION_SEARCH_TIMEOUT", 504, "Inspiration analysis failed", { analysisId: inspirationDetailFixture.id }));
    const { POST } = await import("./route");
    const response = await POST(createRequest(JSON.stringify({ operationId: randomUUID(), prompt: "分析都市轻通勤女装" })));
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: { code: "INSPIRATION_SEARCH_TIMEOUT", message: "Inspiration analysis failed", details: { analysisId: "00000000-0000-4000-8000-000000000001" } } });
  });

  it("does not expose unexpected internal failure messages", async () => {
    mocks.createInspirationAnalysis.mockRejectedValue(new Error("secret provider request and raw payload"));
    const { POST } = await import("./route");
    const response = await POST(createRequest(JSON.stringify({ operationId: randomUUID(), prompt: "分析都市轻通勤女装" })));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  it("preserves operation reuse conflicts", async () => {
    mocks.createInspirationAnalysis.mockRejectedValue(new AppError("OPERATION_ID_REUSED", 409, "Operation ID was already used"));
    const { POST } = await import("./route");
    const response = await POST(createRequest(JSON.stringify({ operationId: randomUUID(), prompt: "分析都市轻通勤女装" })));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: "OPERATION_ID_REUSED", message: "Operation ID was already used" } });
  });
});
