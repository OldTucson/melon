// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({ requireApiUser: vi.fn(), findCompletedVisualResource: vi.fn(), get: vi.fn() }));
vi.mock("@/features/auth/api-session", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/features/inspiration-visuals/visual-repository", () => ({ findCompletedVisualResource: mocks.findCompletedVisualResource }));
vi.mock("@/features/inspiration-visuals/visual-object-store", () => ({ createVisualObjectStore: () => ({ get: mocks.get }) }));
vi.mock("@/lib/env/server", () => ({ getServerEnv: () => ({}) }));

const ownerId = "10000000-0000-4000-8000-000000000001";
const assetId = "abcdef00-0000-4000-8000-000000000001";
const objectKey = `users/${ownerId}/private/image.png`;
const bytes = Uint8Array.from([137, 80, 78, 71]);
const context = (id = assetId) => ({ params: Promise.resolve({ assetId: id }) });
const request = (query = "") => new Request(`https://app.test/api/inspiration-visual-assets/${assetId}${query}`);
const denial = { error: { code: "NOT_FOUND", message: "Not found" } };

describe("owner inspiration image bytes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.findCompletedVisualResource.mockResolvedValue({ objectKey, contentType: "image/png" });
    mocks.get.mockResolvedValue({ bytes, contentType: "image/png" });
  });

  it("serves opaque image bytes with the exact private security headers", async () => {
    const { GET } = await import("./route");
    const response = await GET(request(), context(assetId.toUpperCase()));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/png", "content-length": "4", "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff", "cache-control": "private, no-store", "x-request-id": expect.any(String),
    });
    expect(mocks.findCompletedVisualResource).toHaveBeenCalledExactlyOnceWith({ ownerId, assetId });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(objectKey);
  });

  it("authenticates before even reading the params property and keeps auth errors private", async () => {
    mocks.requireApiUser.mockRejectedValue(new AppError("UNAUTHORIZED", 401, "Authentication required"));
    const readParams = vi.fn(() => Promise.resolve({ assetId: "invalid" }));
    const { GET } = await import("./route");
    const response = await GET(request(), { get params() { return readParams(); } });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(readParams).not.toHaveBeenCalled();
    expect(mocks.findCompletedVisualResource).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each(["invalid", "", "https://provider.test/image.png", "../../private.png"])(
    "returns the same 404 for malformed path %j before repository or storage access", async (invalid) => {
      const { GET } = await import("./route");
      const response = await GET(request(), context(invalid));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual(denial);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(mocks.findCompletedVisualResource).not.toHaveBeenCalled();
      expect(mocks.get).not.toHaveBeenCalled();
    },
  );

  it("cannot override the session owner or private storage target using query input", async () => {
    const { GET } = await import("./route");
    const response = await GET(request("?ownerId=other&url=https://evil.test&bucket=other&key=other"), context());
    expect(response.status).toBe(200);
    expect(mocks.findCompletedVisualResource).toHaveBeenCalledExactlyOnceWith({ ownerId, assetId });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(objectKey);
  });

  it.each(["denied", "missing object", "repository error"])("redacts %s as an indistinguishable noncacheable 404", async (failure) => {
    const secret = `private-bucket ${objectKey} https://oss.test/private?Signature=secret ${ownerId}`;
    if (failure === "denied") mocks.findCompletedVisualResource.mockResolvedValue(undefined);
    if (failure === "missing object") mocks.get.mockRejectedValue(new Error(secret));
    if (failure === "repository error") mocks.findCompletedVisualResource.mockRejectedValue(new Error(secret));
    const { GET } = await import("./route");
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(denial);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "application/json", "content-security-policy": "sandbox", "x-content-type-options": "nosniff",
      "cache-control": "private, no-store", "x-request-id": expect.any(String),
    });
    if (failure !== "missing object") expect(mocks.get).not.toHaveBeenCalled();
  });
});
