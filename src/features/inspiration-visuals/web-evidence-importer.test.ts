// @vitest-environment node
import { describe, expect, it } from "vitest";

import { webEvidenceAssetDtoSchema } from "./contracts";
import { sniffImage } from "./image-sniffer";
import type { RemoteImage } from "./safe-image-fetch";
import type { VisualObjectStore } from "./visual-object-store";
import { importWebEvidence } from "./web-evidence-importer";
import type { ClassifiedWebEvidenceCandidate } from "./web-evidence-intents";

const scope = { ownerId: "11111111-1111-4111-8111-111111111111", analysisId: "22222222-2222-4222-8222-222222222222", jobId: "33333333-3333-4333-8333-333333333333" };
const candidate = (n: number, role: ClassifiedWebEvidenceCandidate["role"] = "evidence"): ClassifiedWebEvidenceCandidate => ({
  role, title: `Image ${n}`, imageUrl: `https://images.test/${n}.png?secret=1`, sourcePageUrl: `https://source.test/${n}`,
  sourceSiteName: "Source", sourceQuery: "sourced query", sourceIndexes: [1, 3],
  productName: role === "product" ? `Product ${n}` : null, brand: role === "product" ? "Brand" : null, priceText: role === "product" ? "$10" : null,
});
function image(n: number): RemoteImage {
  const bytes = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0x12,0xff,0x00,0x34,0xff,0xd9]);
  bytes[25] = n + 1;
  return { bytes, ...sniffImage(bytes, "image/jpeg") };
}
function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[][] = [];
  const store: VisualObjectStore = {
    async put({ key, bytes }) { objects.set(key, Uint8Array.from(bytes)); },
    async get(key) { return { bytes: objects.get(key)!, contentType: "image/jpeg" }; },
    async delete(keys) { deleted.push([...keys]); keys.forEach((key) => objects.delete(key)); },
  };
  return { store, objects, deleted };
}
const input = (candidates: ClassifiedWebEvidenceCandidate[], signal = new AbortController().signal) => ({ ...scope, candidates, signal, maxImages: 8 });
const number = (url: string) => Number(new URL(url).pathname.split("/").pop()!.split(".")[0]);
const sequence = () => { let n = 0; return () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`; };

describe("bounded deterministic evidence import", () => {
  it("fills quotas after invalid fetches and failed puts, preserving trusted metadata and successful write keys", async () => {
    const memory = memoryStore();
    const put = memory.store.put;
    memory.store.put = async (value) => {
      if (value.bytes[25] === 4) throw new Error(`private key ${value.key}`);
      await put(value);
    };
    const candidates = [candidate(0, "hero"), candidate(1, "hero"), candidate(2, "hero"), ...[3,4,5,6,7,8].map((n) => candidate(n, "product")), ...[9,10,11,12,13,14].map((n) => candidate(n))];
    const result = await importWebEvidence(input(candidates), { store: memory.store, createAssetId: sequence(), fetchImage: async (url) => {
      const n = number(url);
      if (n === 0) throw new Error("https://secret.test/?credential=secret");
      if (n === 9) return { ...image(n), bytes: Buffer.from("invalid") };
      return image(n);
    } });
    expect(result.assets.map(({ title }) => title)).toEqual(["Image 1", "Image 4", "Image 5", "Image 6", "Image 7", "Image 10", "Image 11", "Image 12"]);
    expect(result.assets.map(({ ordinal }) => ordinal)).toEqual([0,1,2,3,4,5,6,7]);
    expect(result.assets[1]).toMatchObject({ documentRole: "product", sourceIndexes: [1,3], productName: "Product 4", brand: "Brand", priceText: "$10", sourceSiteName: "Source", sourceQuery: "sourced query" });
    expect(result.writtenKeys).toEqual([...memory.objects.keys()]);
    expect(result.writtenKeys).toHaveLength(8);
    expect(result.warnings).toEqual(["INSPIRATION_WEB_VISUALS_UNAVAILABLE"]);
  });
  it("never has more than three fetched or retained results ahead of ordered writes", async () => {
    const memory = memoryStore();
    const started: number[] = [];
    const finish = new Map<number, (image: RemoteImage) => void>();
    let active = 0, peak = 0;
    const imported = importWebEvidence({ ...input(Array.from({ length: 12 }, (_, n) => candidate(n))), maxImages: 2 }, {
      store: memory.store, createAssetId: sequence(),
      fetchImage: async (url) => {
        const n = number(url); started.push(n); peak = Math.max(peak, ++active);
        const value = await new Promise<RemoteImage>((resolve) => { finish.set(n, resolve); });
        active--; return value;
      },
    });
    await Promise.resolve();
    expect(started).toEqual([0,1,2]);
    finish.get(2)!(image(2)); finish.get(1)!(image(1));
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0,1,2]);
    expect(memory.objects.size).toBe(0);
    finish.get(0)!(image(0));
    const result = await imported;
    expect(peak).toBe(3);
    expect(result.assets.map(({ title }) => title)).toEqual(["Image 0", "Image 1"]);
    expect(memory.objects.size).toBe(2);
  });
  it("generates IDs before fetching and derives extension and dimensions from bytes", async () => {
    const memory = memoryStore(); let generated = false;
    const result = await importWebEvidence(input([candidate(0)]), { store: memory.store,
      createAssetId: () => { generated = true; return "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"; },
      fetchImage: async () => { expect(generated).toBe(true); return { ...image(0), extension: "png", width: 999, height: 999 }; },
    });
    expect(result.assets[0]).toMatchObject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", width: 1, height: 1, contentType: "image/jpeg", objectKey: "users/11111111-1111-4111-8111-111111111111/inspiration/22222222-2222-4222-8222-222222222222/research/33333333-3333-4333-8333-333333333333/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg" });
    // Task 7 owns the actual browser projection; its contract forbids private keys.
    const asset = result.assets[0]!;
    const projection = {
      id: asset.id, kind: asset.kind, ordinal: asset.ordinal, title: asset.title,
      altText: asset.altText, imageUrl: `/api/inspiration-visual-assets/${asset.id}`,
      role: asset.documentRole, sourceIndexes: asset.sourceIndexes,
      brand: asset.brand, productName: asset.productName, priceText: asset.priceText,
      sourcePageUrl: asset.sourcePageUrl, sourceSiteName: asset.sourceSiteName,
      sourceQuery: asset.sourceQuery, width: asset.width, height: asset.height,
    };
    expect(webEvidenceAssetDtoSchema.safeParse(projection).success).toBe(true);
    expect(webEvidenceAssetDtoSchema.safeParse({ ...projection, objectKey: asset.objectKey }).success).toBe(false);
  });
  it("skips duplicate remote images and duplicate bytes independently", async () => {
    const memory = memoryStore(); const calls: number[] = [];
    const duplicate = { ...candidate(0), sourcePageUrl: "https://source.test/another" };
    const result = await importWebEvidence(input([candidate(0), duplicate, candidate(1), candidate(2)]), { store: memory.store, createAssetId: sequence(), fetchImage: async (url) => {
      const n = number(url); calls.push(n); return image(n === 1 ? 0 : n);
    } });
    expect(calls).toEqual([0,1,2]);
    expect(result.assets.map(({ title }) => title)).toEqual(["Image 0", "Image 2"]);
    expect(memory.objects.size).toBe(2);
  });
  it("returns no asset or key for a failed put and uses one stable warning", async () => {
    const memory = memoryStore();
    memory.store.put = async () => { throw new Error("https://secret.test/credentials"); };
    const result = await importWebEvidence(input([candidate(0), candidate(1)]), { store: memory.store, fetchImage: async (url) => image(number(url)) });
    expect(result).toEqual({ assets: [], writtenKeys: [], warnings: ["INSPIRATION_WEB_VISUALS_UNAVAILABLE"] });
  });
  it.each([false, true])("compensates writes on abort; cleanup failure=%s never masks cancellation", async (cleanupFails) => {
    const memory = memoryStore(); const controller = new AbortController(); const put = memory.store.put;
    memory.store.put = async (value) => { await put(value); controller.abort(new Error("https://private.test?token=secret")); };
    const remove = memory.store.delete;
    memory.store.delete = async (keys) => {
      if (cleanupFails) { memory.deleted.push([...keys]); throw new Error("private cleanup failure"); }
      await remove(keys);
    };
    await expect(importWebEvidence(input([candidate(0), candidate(1), candidate(2), candidate(3)], controller.signal), { store: memory.store, fetchImage: async (url, { signal }) => { expect(signal).toBeInstanceOf(AbortSignal); return image(number(url)); } })).rejects.toThrow(/^Web evidence import cancelled$/);
    expect(memory.deleted).toHaveLength(1);
    expect(memory.deleted[0]).toHaveLength(1);
    expect(memory.objects.size).toBe(cleanupFails ? 1 : 0);
  });
  it("propagates pre-abort without generating IDs, fetching or writing", async () => {
    const controller = new AbortController(); controller.abort(); const memory = memoryStore();
    await expect(importWebEvidence(input([candidate(0)], controller.signal), { store: memory.store, createAssetId: () => { throw new Error("should never generate"); }, fetchImage: async () => { throw new Error("should never fetch"); } })).rejects.toThrow(/^Web evidence import cancelled$/);
    expect(memory.objects.size).toBe(0);
  });
  it("cancels active fetches and does not convert caller abort into image warnings", async () => {
    const controller = new AbortController(); const memory = memoryStore(); let cancelled = 0;
    const pending = importWebEvidence(input([candidate(0), candidate(1), candidate(2), candidate(3)], controller.signal), { store: memory.store, fetchImage: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled++; reject(new Error("private abort")); }, { once: true });
    }) });
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toThrow(/^Web evidence import cancelled$/);
    expect(cancelled).toBe(3);
    expect(memory.objects.size).toBe(0);
  });
  it("compensates earlier writes on a fatal ID-generator failure", async () => {
    const memory = memoryStore(); const next = sequence(); let ids = 0;
    let fetchSignal: AbortSignal | undefined;
    const remove = memory.store.delete;
    let cancelledBeforeCleanup = false;
    memory.store.delete = async (keys) => { cancelledBeforeCleanup = fetchSignal?.aborted ?? false; await remove(keys); };
    await expect(importWebEvidence(input([candidate(0), candidate(1), candidate(2), candidate(3)]), { store: memory.store,
      createAssetId: () => { if (++ids === 4) throw new Error("credential=secret"); return next(); }, fetchImage: async (url, { signal }) => { fetchSignal = signal; return image(number(url)); },
    })).rejects.toThrow(/^Web evidence import unavailable$/);
    expect(memory.deleted[0]).toHaveLength(1);
    expect(memory.objects.size).toBe(0);
    expect(cancelledBeforeCleanup).toBe(true);
  });
});
