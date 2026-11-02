import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/http/app-error";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), authorize: vi.fn() }));
vi.mock("@/features/auth/api-session", () => ({ requireApiUser: mocks.auth }));
vi.mock(
  "@/features/inspiration-concepts/resource-service",
  async (original) => ({
    ...(await original<
      typeof import("@/features/inspiration-concepts/resource-service")
    >()),
    authorizeOwnedConceptResource: mocks.authorize,
  }),
);
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({
    DATABASE_URL: "postgres://test:test@localhost:55432/melon_test",
  }),
}));
const ownerId = "10000000-0000-4000-8000-000000000001";
const assetId = "abcdef00-0000-4000-8000-000000000001";
const bytes = Uint8Array.from([137, 80, 78, 71]);
const resource = {
  bytes,
  contentType: "image/png" as const,
  filename: "柔和通勤-方案01-服装效果图.png",
};
const request = () => new Request("http://internal/api/concept-assets");
const context = (id = assetId) => ({
  params: Promise.resolve({ assetId: id }),
});
describe("private concept download route", () => {
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
    mocks.authorize.mockResolvedValue(resource);
  });
  it("serves authorized bytes with safe private headers and no redirect", async () => {
    const { GET, dynamic } = await import("./route");
    const response = await GET(request(), context(assetId.toUpperCase()));
    expect(dynamic).toBe("force-dynamic");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith({
      ownerId,
      assetId,
    });
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="concept.png"; filename*=UTF-8''${encodeURIComponent(resource.filename)}`,
    );
  });
  it("authenticates before params or resource lookup and keeps failures private", async () => {
    mocks.auth.mockRejectedValue(
      new AppError("UNAUTHORIZED", 401, "Authentication required"),
    );
    const read = vi.fn(() => Promise.resolve({ assetId: "bad" }));
    const { GET } = await import("./route");
    const response = await GET(request(), {
      get params() {
        return read();
      },
    });
    expect(response.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("denies malformed path IDs before resource lookup", async () => {
    const { GET } = await import("./route");
    expect((await GET(request(), context("bad"))).status).toBe(404);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it.each([
    "missing",
    "foreign",
    "soft-deleted",
    "hard-cleaned",
    "missing-object",
  ])("returns indistinguishable private 404 for %s", async () => {
    mocks.authorize.mockRejectedValue(
      new AppError("NOT_FOUND", 404, "Not found"),
    );
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
  });
  it("does not serialize unexpected storage failures", async () => {
    mocks.authorize.mockRejectedValue(
      new Error("oss/private-provider?Signature=secret"),
    );
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/oss|provider|Signature/);
    expect(response.headers.get("location")).toBeNull();
  });
});
