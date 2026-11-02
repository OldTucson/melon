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
  retryConceptDerivative: mocks.mutate,
  listConceptSets: mocks.list,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "https://app.example.test" }),
}));
const ownerId = "10000000-0000-4000-8000-000000000001";
const analysisId = "abcdef00-0000-4000-8000-000000000001";
const setId = conceptSetFixture.id;
const operationId = randomUUID();
const params = { analysisId, setId, outputKind: "effect" };
const context = () => ({ params: Promise.resolve(params) });
const request = (
  body: unknown = { operationId },
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
describe("retryConceptDerivative route", () => {
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
    mocks.mutate.mockResolvedValue(conceptSetFixture);
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
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(conceptSetFixture);
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      ownerId,
      analysisId,
      setId,
      outputKind: "effect",
      operationId,
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
    JSON.stringify({ operationId, ownerId }),
    JSON.stringify({ operationId, prompt: "private" }),
    JSON.stringify({ operationId: "bad" }),
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
      ...conceptSetFixture,
      providerId: "private-provider",
    });
    const { POST } = await import("./route");
    const response = await POST(request(), context());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-provider");
  });
  it("does not allow sketch retry", async () => {
    const { POST } = await import("./route");
    expect(
      (
        await POST(request(), {
          params: Promise.resolve({ ...params, outputKind: "sketch" }),
        })
      ).status,
    ).toBe(400);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
