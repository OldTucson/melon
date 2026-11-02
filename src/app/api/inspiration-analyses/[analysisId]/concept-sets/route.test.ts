import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conceptSetFixture } from "@/features/inspiration-concepts/test-fixtures";
import { AppError } from "@/lib/http/app-error";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  mutate: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@/features/auth/api-session", () => ({ requireApiUser: mocks.auth }));
vi.mock("@/features/inspiration-concepts/service", () => ({
  createConceptSetWithOutcome: mocks.mutate,
  listConceptSets: mocks.list,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "https://app.example.test" }),
}));
const ownerId = "10000000-0000-4000-8000-000000000001";
const analysisId = "abcdef00-0000-4000-8000-000000000001";
const operationId = randomUUID();
const createInput = {
  operationId,
  directionIndex: 0,
  visualJobId: null,
  referenceAssetIds: [],
};
const params = { analysisId };
const context = () => ({ params: Promise.resolve(params) });
const request = (
  body: unknown = { ...createInput },
  origin: string | null = "https://app.example.test",
) =>
  new Request("http://internal/api/concepts", {
    method: "POST",
    headers: {
      ...(origin === null ? {} : { origin }),
      "content-type": "application/json",
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
describe("createConceptSetWithOutcome route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({
      id: ownerId,
      email: "designer@example.test",
      displayName: "Designer",
      role: "user",
      mustChangePassword: false,
      themePreference: "system",
      sessionVersion: 1,
    });
    mocks.mutate.mockResolvedValue({ set: conceptSetFixture, created: true });
    mocks.list.mockResolvedValue([conceptSetFixture]);
  });
  it("forwards normalized params and only the session owner", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(), {
      params: Promise.resolve({
        ...params,
        analysisId: analysisId.toUpperCase(),
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(conceptSetFixture);
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      ownerId,
      analysisId,
      ...createInput,
    });
  });
  it("authenticates before reading origin, params, or body", async () => {
    mocks.auth.mockRejectedValue(
      new AppError("UNAUTHORIZED", 401, "Authentication required"),
    );
    const read = vi.fn(() => Promise.resolve(params));
    const { POST } = await import("./route");
    const response = await POST(request(undefined, "https://evil.test"), {
      get params() {
        return read();
      },
    });
    expect(response.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it.each([null, "null", "https://evil.test", "https://app.example.test:444"])(
    "denies origin %s before params",
    async (origin) => {
      const read = vi.fn(() => Promise.resolve(params));
      const { POST } = await import("./route");
      expect(
        (
          await POST(request(undefined, origin), {
            get params() {
              return read();
            },
          })
        ).status,
      ).toBe(403);
      expect(read).not.toHaveBeenCalled();
      expect(mocks.mutate).not.toHaveBeenCalled();
    },
  );
  it.each(Object.keys(params))(
    "strictly validates path parameter %s",
    async (key) => {
      const { POST } = await import("./route");
      expect(
        (
          await POST(request(), {
            params: Promise.resolve({ ...params, [key]: "invalid" }),
          })
        ).status,
      ).toBe(400);
      expect(mocks.mutate).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "foreign", "hard-cleaned"])(
    "preserves safe 404 for %s resources",
    async () => {
      mocks.mutate.mockRejectedValue(
        new AppError(
          "INSPIRATION_NOT_FOUND",
          404,
          "Inspiration analysis not found",
        ),
      );
      const { POST } = await import("./route");
      const response = await POST(request(), context());
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(ownerId);
    },
  );
  it("redacts unexpected internal failures", async () => {
    mocks.mutate.mockRejectedValue(
      new Error("private-provider-id oss-key Signature=secret"),
    );
    const { POST } = await import("./route");
    const response = await POST(request(), context());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });
  it.each([
    "{",
    "",
    "null",
    JSON.stringify({ ...createInput, ownerId }),
    JSON.stringify({ ...createInput, prompt: "private" }),
    JSON.stringify({ ...createInput, operationId: "bad" }),
    " ".repeat(16385),
  ])("rejects malformed, extra, or oversized input", async (body) => {
    const { POST } = await import("./route");
    const response = await POST(request(body), context());
    expect(response.status).toBe(400);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("rejects dishonest content length by counting streamed bytes", async () => {
    const req = request(" ".repeat(16385));
    req.headers.set("content-length", "1");
    const { POST } = await import("./route");
    expect((await POST(req, context())).status).toBe(400);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("rejects unsafe service response DTOs", async () => {
    mocks.mutate.mockResolvedValue({
      set: { ...conceptSetFixture, providerId: "private-provider" },
      created: true,
    });
    const { POST } = await import("./route");
    const response = await POST(request(), context());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-provider");
  });
  it("returns 200 for an authoritative replay", async () => {
    mocks.mutate.mockResolvedValue({ set: conceptSetFixture, created: false });
    const { POST } = await import("./route");
    expect((await POST(request(), context())).status).toBe(200);
  });
  it("maps concurrent authoritative outcomes to exactly one 201 and one 200", async () => {
    mocks.mutate
      .mockResolvedValueOnce({ set: conceptSetFixture, created: true })
      .mockResolvedValueOnce({ set: conceptSetFixture, created: false });
    const { POST } = await import("./route");
    expect(
      (
        await Promise.all([
          POST(request(), context()),
          POST(request(), context()),
        ])
      )
        .map((r) => r.status)
        .sort(),
    ).toEqual([200, 201]);
  });
  it("returns an uncached normalized owned list", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://internal/api/concepts"),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([conceptSetFixture]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ ownerId, analysisId });
  });
  it("authenticates and strictly parses GET", async () => {
    const { GET } = await import("./route");
    expect(
      (
        await GET(new Request("http://internal/api/concepts"), {
          params: Promise.resolve({ analysisId: "bad" }),
        })
      ).status,
    ).toBe(400);
    mocks.auth.mockRejectedValue(
      new AppError("UNAUTHORIZED", 401, "Authentication required"),
    );
    expect(
      (await GET(new Request("http://internal/api/concepts"), context()))
        .status,
    ).toBe(401);
  });
  it("bounds list responses", async () => {
    mocks.list.mockResolvedValue(Array(16).fill(conceptSetFixture));
    const { GET } = await import("./route");
    expect(
      (await GET(new Request("http://internal/api/concepts"), context()))
        .status,
    ).toBe(500);
  });
});
