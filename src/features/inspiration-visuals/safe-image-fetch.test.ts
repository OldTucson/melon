// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteImage, type ImageRequestFactory } from "./safe-image-fetch";

const gif = Buffer.from("47494638396101000100800000000000ffffff2c00000000010001000002024401003b", "hex");
type Reply = { status?: number; headers?: Record<string,string>; rawHeaders?: string[]; body?: Buffer; complete?: boolean; stall?: boolean; error?: string; stream?: (response: PassThrough) => void };
function transport(replies: Reply[] = [{}]) {
  const options: RequestOptions[] = [];
  const requests: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = [];
  const responses: PassThrough[] = [];
  const lookupOne = vi.fn(), lookupAll = vi.fn();
  const request: ImageRequestFactory = (opts, callback) => {
    options.push(opts);
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: () => {} });
    requests.push(req);
    const reply = replies[options.length - 1]!;
    req.end = () => queueMicrotask(() => {
      opts.lookup!(String(opts.hostname), {}, lookupOne);
      opts.lookup!(String(opts.hostname), { all: true }, lookupAll);
      if (reply.error) { req.emit("error", new Error(reply.error)); return; }
      if (reply.stall) return;
      const headers = reply.headers ?? { "content-type": "image/gif" };
      const response = Object.assign(new PassThrough(), {
        statusCode: reply.status ?? 200, headers,
        rawHeaders: reply.rawHeaders ?? Object.entries(headers).flat(),
        complete: reply.complete ?? true,
      });
      responses.push(response);
      callback(response as unknown as IncomingMessage);
      if (reply.stream) reply.stream(response); else response.end(reply.body ?? gif);
    });
    return req as unknown as ClientRequest;
  };
  const resolve = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  return { request, resolve, options, requests, responses, lookupOne, lookupAll };
}
afterEach(() => vi.useRealTimers());
describe("safe remote image fetch", () => {
  it("returns validated bytes and pins both Node 24 lookup callback shapes while preserving Host/SNI", async () => {
    const t = transport();
    await expect(fetchRemoteImage("https://images.example:8443/image?token=secret", t)).resolves.toEqual({ bytes: gif, contentType: "image/gif", extension: "gif", width: 1, height: 1 });
    const opts = t.options[0]!;
    expect(opts).toMatchObject({ hostname: "images.example", servername: "images.example", port: "8443", path: "/image?token=secret", method: "GET", maxHeaderSize: 16384, agent: false, rejectUnauthorized: true, headers: { Host: "images.example:8443" } });
    expect(t.lookupOne).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(t.lookupAll).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(t.resolve).toHaveBeenCalledTimes(1);
  });
  it.each(["http://example.com", "https://user:password@example.com", "https://example.com/#fragment", "https://127.0.0.1/", "https://[::ffff:127.0.0.1]/"])("rejects unsafe target before creating a socket %s", async (url) => {
    const t = transport(); await expect(fetchRemoteImage(url, t)).rejects.toThrow(); expect(t.options).toHaveLength(0);
  });
  it("rejects mixed DNS answers before creating a socket", async () => {
    const t = transport(); t.resolve.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow(); expect(t.options).toHaveLength(0);
  });
  it("follows three redirects with fresh DNS and closes each previous response", async () => {
    const t = transport([... [1,2,3].map((n) => ({ status: 302, headers: { location: `/image${n}` } })), {}]);
    await expect(fetchRemoteImage("https://example.com/image", t)).resolves.toMatchObject({ width: 1 });
    expect(t.resolve).toHaveBeenCalledTimes(4);
    expect(t.requests.every((r) => r.destroy.mock.calls.length > 0)).toBe(true);
  });
  it("rejects fourth redirect", async () => {
    const t = transport(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/again" } })));
    await expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow(); expect(t.options).toHaveLength(4);
  });
  it.each(["http://example.com/x", "https://127.0.0.1/x", "https://user:pass@example.com/x", "/x#fragment"])("revalidates redirect %s", async (location) => {
    const t = transport([{ status: 302, headers: { location } }]);
    await expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow(); expect(t.options).toHaveLength(1); expect(t.requests[0]!.destroy).toHaveBeenCalled();
  });
  it("rejects same-host DNS rebinding on redirect", async () => {
    const t = transport([{ status: 302, headers: { location: "/next" } }]);
    t.resolve.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow(); expect(t.options).toHaveLength(1);
  });
  it.each<Reply>([
    { headers: { "content-type": "multipart/mixed" } },
    { headers: { "content-type": "image/svg+xml" } },
    { headers: { "content-type": "image/gif", "content-length": "999" } },
    { headers: { "content-type": "image/gif", "content-length": "8388609" } },
    { headers: { "content-type": "image/gif", "content-length": "+35" } },
    { headers: { "content-type": "image/gif", "content-encoding": "gzip" } },
    { headers: { "content-type": "image/gif", "content-length": "35", "transfer-encoding": "chunked" } },
    { rawHeaders: ["Content-Type", "image/gif", "content-type", "image/gif"] },
    { headers: { "content-type": "image/gif", "x-large": "a".repeat(16384) } },
    { body: Buffer.alloc(8 * 1024 * 1024 + 1) },
    { complete: false }, { status: 206 }, { body: gif.subarray(0, 12) },
  ])("fails closed and destroys transport for invalid response %#", async (reply) => {
    const t = transport([reply]); await expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow();
    expect(t.requests[0]!.destroy).toHaveBeenCalled(); expect(t.responses[0]!.destroyed).toBe(true);
  });
  it("enforces the 5s idle deadline before response headers", async () => {
    vi.useFakeTimers(); const t = transport([{ stall: true }]);
    const promise = expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000); await promise;
    expect(t.requests[0]!.destroy).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("enforces the 15s total deadline during DNS and never creates a late socket", async () => {
    vi.useFakeTimers(); const t = transport();
    let finish!: (value: { address: string; family: number }[]) => void;
    t.resolve.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const promise = expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15000); await promise;
    finish([{ address: "8.8.8.8", family: 4 }]); await vi.advanceTimersByTimeAsync(0);
    expect(t.options).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("enforces idle timeout during a partial body and closes the socket", async () => {
    vi.useFakeTimers();
    const t = transport([{ stream: (response) => { response.write(gif.subarray(0, 5)); } }]);
    const promise = expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000); await promise;
    expect(t.requests[0]!.destroy).toHaveBeenCalled(); expect(t.responses[0]!.destroyed).toBe(true);
  });
  it("enforces total deadline despite a body making progress every four seconds", async () => {
    vi.useFakeTimers();
    const t = transport([{ stream: (response) => { response.write(gif.subarray(0, 1)); } }]);
    const promise = expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      t.responses[0]!.write(gif.subarray(i + 1, i + 2));
    }
    await vi.advanceTimersByTimeAsync(3000); await promise;
    expect(t.requests[0]!.destroy).toHaveBeenCalled(); expect(t.responses[0]!.destroyed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("accumulates the body cap across chunks and rejects abrupt stream closure", async () => {
    const t = transport([{ stream: (response) => { response.write(Buffer.alloc(8 * 1024 * 1024)); response.write(Buffer.from([1])); } }]);
    await expect(fetchRemoteImage("https://example.com", t)).rejects.toThrow();
    expect(t.responses[0]!.destroyed).toBe(true);
    const closed = transport([{ stream: (response) => { response.write(gif.subarray(0, 5)); response.destroy(); } }]);
    await expect(fetchRemoteImage("https://example.com", closed)).rejects.toThrow();
  });
  it.each(["8.8.8.8", "[2606:4700:4700::1111]"])("connects public literal %s without DNS or DNS SNI", async (host) => {
    const t = transport(); await expect(fetchRemoteImage(`https://${host}/image`, t)).resolves.toMatchObject({ width: 1 });
    expect(t.resolve).not.toHaveBeenCalled(); expect(t.options[0]!.servername).toBe(""); expect(t.options[0]!.headers).toMatchObject({ Host: host });
  });
  it("accepts exact content-length and chunked transfer framing", async () => {
    const framings: Record<string, string>[] = [{ "content-length": String(gif.length) }, { "transfer-encoding": "chunked" }];
    for (const framing of framings) {
      const t = transport([{ headers: { "content-type": "image/gif", ...framing } }]);
      await expect(fetchRemoteImage("https://example.com", t)).resolves.toMatchObject({ bytes: gif });
    }
  });
  it("sanitizes transport errors without URL, query, body, or cause", async () => {
    const t = transport([{ error: "failed https://example.com?token=secret body=private" }]);
    const error = await fetchRemoteImage("https://example.com?token=secret", t).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toMatch(/secret|private|https/); expect(error).not.toHaveProperty("cause");
  });
});

describe("caller cancellation", () => {
  it("rejects a pre-aborted caller without DNS, sockets or retained listeners", async () => {
    const t = transport();
    const controller = new AbortController();
    controller.abort(new Error("https://private.test?token=secret"));
    const add = vi.spyOn(controller.signal, "addEventListener");
    await expect(fetchRemoteImage("https://example.com", { ...t, signal: controller.signal })).rejects.toThrow(/^Remote image cancelled$/);
    expect(t.resolve).not.toHaveBeenCalled();
    expect(t.options).toHaveLength(0);
    expect(add).not.toHaveBeenCalled();
  });
  it("cancels pending DNS and prevents a late answer from opening a socket", async () => {
    const t = transport();
    const controller = new AbortController();
    let finish!: (addresses: { address: string; family: number }[]) => void;
    t.resolve.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = expect(fetchRemoteImage("https://example.com", { ...t, signal: controller.signal })).rejects.toThrow(/^Remote image cancelled$/);
    controller.abort();
    await pending;
    finish([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    expect(t.options).toHaveLength(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("destroys an active request and partial response on caller abort", async () => {
    const controller = new AbortController();
    const t = transport([{ stream: (response) => {
      response.write(gif.subarray(0, 5));
      controller.abort(new Error("secret upstream cancellation"));
    } }]);
    await expect(fetchRemoteImage("https://example.com", { ...t, signal: controller.signal })).rejects.toThrow(/^Remote image cancelled$/);
    expect(t.requests[0]!.destroy).toHaveBeenCalled();
    expect(t.responses[0]!.destroyed).toBe(true);
  });
});

it("honors internal byte and pixel limits without changing the default boundary", async () => {
  const { crc32 } = await import("node:zlib");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
  png.writeUInt32BE(crc32(png.subarray(37, 52)), 52);
  const padding = Buffer.alloc(8 * 1024 * 1024 + 12); padding.writeUInt32BE(8 * 1024 * 1024); padding.write("tEXt", 4); padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
  const bytes = Buffer.concat([png.subarray(0, 33), padding, png.subarray(33)]);
  const reply = { body: bytes, headers: { "content-type": "image/png", "content-length": String(bytes.length) } };
  await expect(fetchRemoteImage("https://example.com", transport([reply]))).rejects.toThrow();
  await expect(fetchRemoteImage("https://example.com", transport([reply]), { maxBytes: 16 * 1024 * 1024, maxPixels: 40_000_000 })).resolves.toMatchObject({ width: 1, contentType: "image/png" });
  const small = transport();
  await expect(fetchRemoteImage("https://example.com", small, { maxBytes: 1 })).rejects.toThrow();
});
