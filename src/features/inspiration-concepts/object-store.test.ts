// @vitest-environment node
import { randomUUID } from "node:crypto";
import type OSS from "ali-oss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conceptOutputObjectKey, conceptSetObjectPrefix, parseConceptObjectKey } from "./object-keys";
import { createConceptObjectStore } from "./object-store";
const scope = { ownerId: "11111111-1111-4111-8111-111111111111", analysisId: "22222222-2222-4222-8222-222222222222", setId: "33333333-3333-4333-8333-333333333333" };
const outputId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prefix = `users/${scope.ownerId}/inspiration/${scope.analysisId}/concept-sets/${scope.setId}/`;
const key = prefix + `flat/${outputId}.png`;
const config = { region: "oss-cn-hangzhou", bucket: "melon-assets", endpoint: "https://assets.example.test", cname: true };
const credential = { accessKeyId: "id", accessKeySecret: "secret", securityToken: "token" };
const sdk = { put: vi.fn(), get: vi.fn(), listV2: vi.fn(), deleteMulti: vi.fn() };
const createClient = vi.fn<(options: OSS.Options & { retryMax: number }) => typeof sdk>(() => sdk);
const store = () => createConceptObjectStore(config, { getCredential: async () => credential, createClient });
beforeEach(() => { vi.resetAllMocks(); sdk.put.mockResolvedValue({}); sdk.deleteMulti.mockImplementation(async (keys: string[], options: OSS.DeleteMultiOptions) => ({ deleted: options.quiet ? [] : keys.map((Key) => ({ Key })), res: { status: 200, headers: { "x-oss-request-id": "request-private" }, size: 100, rt: 1 } })); sdk.get.mockResolvedValue({ content: Buffer.of(1), res: { headers: { "content-type": "image/png" }, status: 200 } }); });

describe("private concept object scope", () => {
  it("builds canonical PNG concept keys and prefixes", () => {
    expect(conceptOutputObjectKey({ ...scope, outputKind: "flat", outputId: outputId.toUpperCase() })).toBe(key);
    expect(conceptSetObjectPrefix(scope)).toBe(prefix);
    expect(parseConceptObjectKey(key)).toEqual({ ...scope, outputKind: "flat", outputId });
  });
  it("rejects traversal, research/pattern keys, alternate formats and noncanonical keys", async () => {
    for (const bad of [key.replace("/concept-sets/", "/research/"), key.replace("/flat/", "/../"), key.replace(".png", ".jpg"), key.replace(outputId, outputId.toUpperCase()), key + "?secret", key.replace("/inspiration/", "/patterns/")]) {
      expect(() => parseConceptObjectKey(bad)).toThrow();
      await expect(store().get(bad)).rejects.toThrow();
      await expect(store().delete([key, bad])).rejects.toThrow();
    }
    expect(createClient).not.toHaveBeenCalled();
  });
  it("writes privately with MIME checks and shared transport safeguards", async () => {
    await store().put({ key, bytes: Buffer.from([1, 2]), contentType: "image/png" });
    expect(sdk.put).toHaveBeenCalledWith(key, Buffer.from([1, 2]), { mime: "image/png", headers: { "x-oss-object-acl": "private" } });
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ secure: true, authorizationV4: true, retryMax: 0, stsToken: "token", timeout: 120_000 }));
    await expect(store().put({ key, bytes: Buffer.of(1), contentType: "image/jpeg" })).rejects.toThrow();
  });
  it("refreshes STS through the existing resolver and sanitizes refresh failures", async () => {
    const resolve = vi.fn().mockResolvedValueOnce(credential).mockResolvedValueOnce({ accessKeyId: "next", accessKeySecret: "next-secret", securityToken: "next-token" }).mockRejectedValueOnce(new Error(key));
    await createConceptObjectStore(config, { getCredential: resolve, createClient }).put({ key, bytes: Buffer.of(1), contentType: "image/png" });
    const refresh = createClient.mock.calls[0]![0].refreshSTSToken!;
    await expect(refresh()).resolves.toEqual({ accessKeyId: "next", accessKeySecret: "next-secret", stsToken: "next-token" });
    await expect(refresh()).rejects.toThrow(/^Concept object unavailable$/);
  });
  it("copies bytes from the SDK response and enforces PNG content type", async () => {
    const bytes = Buffer.of(1, 2);
    sdk.get.mockResolvedValue({ content: bytes, res: { headers: { "Content-Type": "image/png" }, status: 200 } });
    const result = await store().get(key); result.bytes[0] = 4;
    expect(bytes[0]).toBe(1); expect(result.contentType).toBe("image/png");
  });
  it("lists every page under an exact concept prefix and validates every returned key", async () => {
    const second = prefix + `sketch/${outputId}.png`;
    sdk.listV2.mockResolvedValueOnce({ objects: [{ name: key }], isTruncated: true, nextContinuationToken: "page-2", res: { status: 200 } }).mockResolvedValueOnce({ objects: [{ name: second }], isTruncated: false, nextContinuationToken: "", res: { status: 200 } });
    await expect(store().listObjectKeys(prefix)).resolves.toEqual([key, second]);
    expect(sdk.listV2.mock.calls).toEqual([[{ prefix, "max-keys": 1000 }], [{ prefix, "max-keys": 1000, "continuation-token": "page-2" }]]);
    for (const bad of ["users/", prefix.slice(0, -1), prefix.replace("/concept-sets/", "/research/")]) await expect(store().listObjectKeys(bad)).rejects.toThrow();
    sdk.listV2.mockResolvedValue({ objects: [{ name: key.replace(scope.setId, randomUUID()) }], isTruncated: false });
    await expect(store().listObjectKeys(prefix)).rejects.toThrow();
  });
  it("rejects repeated/missing continuation tokens and malformed list envelopes", async () => {
    for (const result of [{ objects: [], isTruncated: true }, { objects: [], isTruncated: true, nextContinuationToken: "repeat" }, { objects: [], isTruncated: "false" }, { isTruncated: false }]) {
      sdk.listV2.mockResolvedValue(result);
      await expect(store().listObjectKeys(prefix)).rejects.toThrow(/^Concept object unavailable$/);
    }
  });
  it("batches deletion at 1000 after validating the whole batch, and retries client initialization safely", async () => {
    const keys = Array.from({ length: 1001 }, () => conceptOutputObjectKey({ ...scope, outputKind: "flat", outputId: randomUUID() }));
    const storage = store();
    await storage.delete([]); expect(createClient).not.toHaveBeenCalled();
    await storage.delete(keys); expect(sdk.deleteMulti.mock.calls.map(([keys]) => keys.length)).toEqual([1000, 1]);
    createClient.mockImplementationOnce(() => { throw new Error(key); });
    const fresh = store(); await expect(fresh.get(key)).rejects.toThrow(/^Concept object unavailable$/);
    await fresh.get(key); expect(createClient).toHaveBeenCalledTimes(3);
  });
});


describe("verified concept deletion acknowledgement", () => {
  it("requires verbose acknowledgements for every key across 1000-object batches", async () => {
    const keys = Array.from({ length: 1001 }, () => conceptOutputObjectKey({ ...scope, outputKind: "flat", outputId: randomUUID() }));
    await expect(store().delete(keys)).resolves.toBeUndefined();
    expect(sdk.deleteMulti.mock.calls).toEqual([[keys.slice(0, 1000), { quiet: false }], [[keys[1000]], { quiet: false }]]);
  });
  it.each([
    { deleted: [] },
    { deleted: [{ Key: key }], errors: [{ Key: prefix + `sketch/${outputId}.png`, Code: "AccessDenied", Message: "provider-private-secret" }] },
    { deleted: [key] },
    { deleted: [{ Key: key }, { Key: key }] },
    { deleted: [{ Key: key }, { Key: key.replace(scope.ownerId, "44444444-4444-4444-8444-444444444444") }] },
    { deleted: undefined },
  ])("rejects incomplete or malformed acknowledgements without private details %#", async (response) => {
    const keys = [key, prefix + `sketch/${outputId}.png`];
    sdk.deleteMulti.mockResolvedValueOnce({ ...response, res: { status: 200, headers: { "x-oss-request-id": "request-private" }, size: 100, rt: 1 } });
    const error = await store().delete(keys).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: Concept object unavailable");
    expect(String(error) + JSON.stringify(error)).not.toMatch(/users\/|provider-private|secret|request-private|AccessDenied/);
    expect(error).not.toHaveProperty("cause");
  });
  it("stops before later batches if an earlier batch was not fully deleted", async () => {
    const keys = Array.from({ length: 1001 }, () => conceptOutputObjectKey({ ...scope, outputKind: "flat", outputId: randomUUID() }));
    sdk.deleteMulti.mockResolvedValueOnce({ deleted: keys.slice(0, 999).map((Key) => ({ Key })), res: { status: 200, headers: {}, size: 100, rt: 1 } });
    await expect(store().delete(keys)).rejects.toThrow(/^Concept object unavailable$/);
    expect(sdk.deleteMulti).toHaveBeenCalledOnce();
  });
});
