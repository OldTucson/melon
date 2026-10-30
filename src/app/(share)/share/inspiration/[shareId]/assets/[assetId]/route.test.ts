// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findCompletedVisualResource: vi.fn(), get: vi.fn() }));
vi.mock("@/features/inspiration-visuals/visual-repository", () => ({ findCompletedVisualResource: mocks.findCompletedVisualResource }));
vi.mock("@/features/inspiration-visuals/visual-object-store", () => ({ createVisualObjectStore: () => ({ get: mocks.get }) }));
vi.mock("@/lib/env/server", () => ({ getServerEnv: () => ({}) }));

const shareId = "abcdef00-0000-4000-8000-000000000002";
const assetId = "abcdef00-0000-4000-8000-000000000001";
const objectKey = "users/private-owner/private/image.png";
const bytes = Uint8Array.from([137, 80, 78, 71]);
const context = (share = shareId, asset = assetId) => ({ params: Promise.resolve({ shareId: share, assetId: asset }) });
const request = (query = "") => new Request(`https://app.test/share/inspiration/${shareId}/assets/${assetId}${query}`);
const denial = { error: { code: "NOT_FOUND", message: "Not found" } };

describe("live share inspiration image bytes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findCompletedVisualResource.mockResolvedValue({ objectKey, contentType: "image/png" });
    mocks.get.mockResolvedValue({ bytes, contentType: "image/png" });
  });

  it("serves an active shared image without auth or a redirect and with exact private headers", async () => {
    const { GET } = await import("./route");
    const response = await GET(request(), context(shareId.toUpperCase(), assetId.toUpperCase()));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "image/png", "content-length": "4", "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff", "cache-control": "private, no-store", "x-request-id": expect.any(String),
    });
    expect(mocks.findCompletedVisualResource).toHaveBeenCalledExactlyOnceWith({ shareId, assetId });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(objectKey);
  });

  it.each([
    ["invalid", assetId], [shareId, "invalid"], ["", assetId], [shareId, ""],
    ["https://provider.test/image.png", assetId], [shareId, "../../private.png"],
  ])("validates both UUID path identifiers (%s, %s) before any lookup", async (share, asset) => {
    const { GET } = await import("./route");
    const response = await GET(request(), context(share, asset));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(denial);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.findCompletedVisualResource).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("rechecks authorization before every read even with conditional request headers", async () => {
    const { GET } = await import("./route");
    expect((await GET(request(), context())).status).toBe(200);
    mocks.findCompletedVisualResource.mockResolvedValue(undefined);
    const nextRequest = request();
    nextRequest.headers.set("if-none-match", "cached-image");
    const denied = await GET(nextRequest, context());
    expect(denied.status).toBe(404);
    await expect(denied.json()).resolves.toEqual(denial);
    expect(mocks.findCompletedVisualResource).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("cannot override the share or private storage target using query input", async () => {
    const { GET } = await import("./route");
    const response = await GET(request("?shareId=other&url=https://evil.test&bucket=other&key=other"), context());
    expect(response.status).toBe(200);
    expect(mocks.findCompletedVisualResource).toHaveBeenCalledExactlyOnceWith({ shareId, assetId });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith(objectKey);
  });

  it.each(["denied", "missing object", "repository error"])("redacts %s into the same owner/share denial", async (failure) => {
    const secret = `private-bucket ${objectKey} https://oss.test/private?Signature=secret`;
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
