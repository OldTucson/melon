// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { importConceptOutput } from "./output-importer";
import type { ImageRequestFactory } from "@/features/inspiration-visuals/safe-image-fetch";
import { createConceptObjectStore } from "./object-store";
const identity = { ownerId: "11111111-1111-4111-8111-111111111111", analysisId: "22222222-2222-4222-8222-222222222222", setId: "33333333-3333-4333-8333-333333333333", outputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const input = { ...identity, outputKind: "flat" as const, temporaryImageUrl: "https://provider.example/private-result?TemporarySignature=secret", title: "款式图", altText: "正反面款式图" };
const config = { region: "oss-cn-hangzhou", bucket: "melon-assets", endpoint: "https://assets.example.test", cname: true };
function dependencies(bytes: Buffer, contentType = "image/png") {
  const sdk = { put: vi.fn().mockResolvedValue({}), get: vi.fn(), listV2: vi.fn(), deleteMulti: vi.fn().mockResolvedValue({}) };
  const store = createConceptObjectStore(config, { getCredential: async () => ({ accessKeyId: "id", accessKeySecret: "secret" }), createClient: () => sdk });
  const request: ImageRequestFactory = (_options, onResponse) => {
    const req = Object.assign(new EventEmitter(), { destroy: () => {}, end: () => queueMicrotask(() => {
      const headers = { "content-type": contentType, "content-length": String(bytes.length) };
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers, rawHeaders: Object.entries(headers).flat(), complete: true });
      onResponse(response as unknown as IncomingMessage); response.end(bytes);
    }) });
    return req as unknown as ClientRequest;
  };
  const remote = { request, resolve: async () => [{ address: "8.8.8.8", family: 4 }] };
  return { store, remote, sdk };
}
const png = (width = 2048, height = 1536) => sharp({ create: { width, height, channels: 3, background: "#385b8a" } }).png().toBuffer();
describe("concept output import", () => {
  it("downloads safely, fully decodes PNG, normalizes and privately persists before returning an asset", async () => {
    const deps = dependencies(await png());
    const result = await importConceptOutput(input, deps);
    const key = `users/${identity.ownerId}/inspiration/${identity.analysisId}/concept-sets/${identity.setId}/flat/${identity.outputId}.png`;
    expect(result).toEqual({ writtenKey: key, asset: { id: identity.outputId, title: "款式图", altText: "正反面款式图", objectKey: key, contentType: "image/png", width: 2048, height: 1536 } });
    expect(await sharp(deps.sdk.put.mock.calls[0]![1]).metadata()).toMatchObject({ format: "png", width: 2048, height: 1536 });
    expect(deps.sdk.deleteMulti).not.toHaveBeenCalled();
  });
  it("rejects format, exact dimension, container and compressed-data failures before storage", async () => {
    const corrupt = await png(); corrupt.fill(0, 50, corrupt.length - 20);
    for (const [bytes, mime] of [[await png(1536, 2048), "image/png"], [await sharp(await png()).jpeg().toBuffer(), "image/jpeg"], [corrupt, "image/png"], [Buffer.alloc(16 * 1024 * 1024 + 1), "image/png"]] as const) {
      const deps = dependencies(bytes, mime);
      await expect(importConceptOutput(input, deps)).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_IMPORT_FAILED" });
      expect(deps.sdk.put).not.toHaveBeenCalled();
    }
  });
  it("reuses the SSRF boundary and redacts temporary URLs and private storage errors", async () => {
    const deps = dependencies(await png());
    for (const url of ["https://127.0.0.1/private", "https://user:secret@provider.example/image", "http://provider.example/image"]) {
      await expect(importConceptOutput({ ...input, temporaryImageUrl: url }, deps)).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_IMPORT_FAILED" });
    }
    deps.sdk.put.mockRejectedValueOnce(new Error(input.temporaryImageUrl));
    const error = await importConceptOutput(input, deps).catch((e: unknown) => e);
    expect(String(error) + JSON.stringify(error)).not.toMatch(/TemporarySignature|private-result|secret|users\//);
    expect(error).not.toHaveProperty("cause");
  });
  it("deletes a completed write if cancellation prevents post-write publication", async () => {
    const deps = dependencies(await png()); const controller = new AbortController();
    deps.sdk.put.mockImplementationOnce(async () => { controller.abort(); return {}; });
    await expect(importConceptOutput({ ...input, signal: controller.signal }, deps)).rejects.toThrow();
    expect(deps.sdk.deleteMulti).toHaveBeenCalledWith([deps.sdk.put.mock.calls[0]![0]], { quiet: true });
  });
  it("returns the exact written key for caller compensation after DB publication failure", async () => {
    const deps = dependencies(await png());
    const { asset, writtenKey } = await importConceptOutput(input, deps);
    const publish = async () => { expect(asset.width).toBe(2048); throw new Error("database unavailable"); };
    await expect(publish().catch(async () => { await deps.store.delete([writtenKey]); throw new Error("publication failed"); })).rejects.toThrow("publication failed");
    expect(deps.sdk.deleteMulti).toHaveBeenCalledWith([writtenKey], { quiet: true });
  });
});

it("rejects invalid compressed entropy even with valid PNG framing and CRC", async () => {
  const { crc32 } = await import("node:zlib");
  const { sniffImage } = await import("@/features/inspiration-visuals/image-sniffer");
  const bytes = await png();
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      bytes.fill(0, offset + 8, offset + 8 + length);
      bytes.writeUInt32BE(crc32(bytes.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
    }
    offset += 12 + length;
  }
  expect(sniffImage(bytes, "image/png")).toMatchObject({ width: 2048, height: 1536 });
  const deps = dependencies(bytes);
  await expect(importConceptOutput(input, deps)).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_IMPORT_FAILED" });
  expect(deps.sdk.put).not.toHaveBeenCalled();
});

it("rejects a provider PNG above the decoded-pixel limit before persistence", async () => {
  const deps = dependencies(await png(8000, 5001));
  await expect(importConceptOutput(input, deps)).rejects.toMatchObject({ code: "INSPIRATION_CONCEPT_IMPORT_FAILED" });
  expect(deps.sdk.put).not.toHaveBeenCalled();
});
