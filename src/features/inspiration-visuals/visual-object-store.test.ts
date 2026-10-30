// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseObjectKey } from "@/features/storage/object-keys";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "@/features/storage/upload-timing";

const sdk = vi.hoisted(() => ({ construct: vi.fn(), put: vi.fn(), get: vi.fn(), deleteMulti: vi.fn() }));
vi.mock("ali-oss", () => ({ default: function Client(options: unknown) {
  sdk.construct(options);
  return sdk;
} }));

import { assertVisualObjectKeyBelongsToResearch, parseVisualObjectKey, researchVisualObjectKey } from "./visual-object-keys";
import { createVisualObjectStore } from "./visual-object-store";

const scope = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  analysisId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
  assetId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
};
const key = "users/11111111-1111-4111-8111-111111111111/inspiration/22222222-2222-4222-8222-222222222222/research/33333333-3333-4333-8333-333333333333/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
const config = { region: "oss-cn-hangzhou", bucket: "melon-assets", endpoint: "https://assets.example.test", cname: true };
const credentials = { accessKeyId: "id", accessKeySecret: "secret", securityToken: "token" };
const store = (getCredential = async (): Promise<unknown> => credentials) => createVisualObjectStore(config, { getCredential });

beforeEach(() => { vi.resetAllMocks(); sdk.put.mockResolvedValue({}); sdk.deleteMulti.mockResolvedValue({}); });

describe("canonical private research keys", () => {
  it("normalizes UUIDs and supported extensions when building, but parses only canonical keys", () => {
    expect(researchVisualObjectKey({ ...scope, extension: "PNG" })).toBe(key);
    expect(parseVisualObjectKey(key)).toEqual({ ...scope, assetId: scope.assetId.toLowerCase(), extension: "png" });
    for (const extension of ["jpg", "png", "webp", "gif"]) {
      expect(parseVisualObjectKey(researchVisualObjectKey({ ...scope, extension })).extension).toBe(extension);
    }
    expect(() => parseObjectKey(key)).toThrow();
  });
  it("rejects traversal, noncanonical identities, pattern keys and unsupported formats", () => {
    for (const invalid of [key.replace("/research/", "/../"), key.replace(".png", ".svg"), key.replace(".png", ".jpeg"), key.replace("aaaaaaaa", "AAAAAAAA"), `${key}?secret=1`, key.replace("/inspiration/", "/patterns/"), key.replace("/research/", "/research/%2e%2e/")]) {
      expect(() => parseVisualObjectKey(invalid)).toThrow("Invalid visual object key");
    }
    expect(() => researchVisualObjectKey({ ...scope, ownerId: "../secret", extension: "png" })).toThrow("Invalid visual object key");
  });
  it.each(["ownerId", "analysisId", "jobId"] as const)("rejects a different %s scope", (field) => {
    expect(() => assertVisualObjectKeyBelongsToResearch({ ...scope, key, [field]: randomUUID() })).toThrow();
    expect(assertVisualObjectKeyBelongsToResearch({ ...scope, key }).assetId).toBe(scope.assetId.toLowerCase());
  });
});

describe("dedicated visual OSS store", () => {
  it("writes MIME-checked bytes with V4, HTTPS, no retries and the shared timeout", async () => {
    await store().put({ key, bytes: Uint8Array.of(1, 2), contentType: "image/png" });
    expect(sdk.put).toHaveBeenCalledWith(key, Buffer.from([1, 2]), { mime: "image/png" });
    expect(sdk.construct).toHaveBeenCalledWith(expect.objectContaining({ authorizationV4: true, secure: true, retryMax: 0, timeout: UPLOAD_REQUEST_TIMEOUT_MS, stsToken: "token" }));
    await expect(store().put({ key, bytes: Uint8Array.of(1), contentType: "image/jpeg" })).rejects.toThrow("Visual object unavailable");
  });
  it("copies SDK response bytes and reads content type case insensitively", async () => {
    const bytes = Buffer.from([1, 2]);
    sdk.get.mockResolvedValue({ content: bytes, res: { headers: { "Content-Type": "image/png" } } });
    const result = await store().get(key);
    result.bytes[0] = 9;
    expect(bytes[0]).toBe(1);
    expect(result.contentType).toBe("image/png");
  });
  it("validates all keys before client access and batches deletes at 1000", async () => {
    const storage = store();
    await expect(storage.get("users/private/patterns/x/source/x.png")).rejects.toThrow();
    await expect(storage.delete([key, "../private"])).rejects.toThrow();
    await storage.delete([]);
    expect(sdk.construct).not.toHaveBeenCalled();
    const keys = Array.from({ length: 1001 }, () => researchVisualObjectKey({ ...scope, assetId: randomUUID(), extension: "png" }));
    await storage.delete(keys);
    expect(sdk.deleteMulti.mock.calls.map(([keys]) => keys.length)).toEqual([1000, 1]);
    expect(sdk.deleteMulti.mock.calls[1]).toEqual([[keys[1000]], { quiet: true }]);
  });
  it("retries creation after an SDK constructor failure without retaining the rejected client", async () => {
    sdk.construct.mockImplementationOnce(() => { throw new Error("private credential"); });
    const storage = store();
    await expect(storage.put({ key, bytes: Uint8Array.of(1), contentType: "image/png" })).rejects.toThrow(/^Visual object unavailable$/);
    await storage.put({ key, bytes: Uint8Array.of(1), contentType: "image/png" });
    expect(sdk.construct).toHaveBeenCalledTimes(2);
    expect(sdk.put).toHaveBeenCalledOnce();
  });
  it("recreates a client after credential resolution and SDK operation failures, sanitizing failures", async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error("https://secret.test?credential=secret")).mockResolvedValue(credentials);
    const storage = store(resolve);
    await expect(storage.put({ key, bytes: Uint8Array.of(1), contentType: "image/png" })).rejects.toThrow(/^Visual object unavailable$/);
    sdk.put.mockRejectedValueOnce(new Error(key));
    await expect(storage.put({ key, bytes: Uint8Array.of(1), contentType: "image/png" })).rejects.toThrow(/^Visual object unavailable$/);
    await storage.put({ key, bytes: Uint8Array.of(1), contentType: "image/png" });
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(sdk.construct).toHaveBeenCalledTimes(2);
  });
});
