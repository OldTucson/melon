import "server-only";

import type { LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import { sniffImage, type ImageMetadata } from "./image-sniffer";
import { resolvePublicAddress, validateRemoteUrl, type AddressResolver } from "./remote-address";

export type ImageRequestFactory = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;
export type RemoteImageDependencies = { resolve?: AddressResolver; request?: ImageRequestFactory };
export type RemoteImage = ImageMetadata & { bytes: Buffer };

const MAX_BODY = 8 * 1024 * 1024;
const MAX_HEADERS = 16 * 1024;
const TOTAL_MS = 15_000;
const IDLE_MS = 5_000;
const failure = () => new Error("Remote image unavailable");
type ResponseResult = { redirect: string } | { bytes: Buffer; contentType: string };

function readResponseHeaders(response: IncomingMessage): void {
  let bytes = 0;
  const sensitive = new Set(["content-type", "content-length", "transfer-encoding", "content-encoding", "location"]);
  const seen = new Set<string>();
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i]!;
    const value = response.rawHeaders[i + 1];
    if (value === undefined) throw failure();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    const key = name.toLowerCase();
    if (sensitive.has(key) && seen.has(key)) throw failure();
    seen.add(key);
  }
  if (bytes > MAX_HEADERS) throw failure();
}

function requestImage(url: URL, pinned: LookupAddress, request: ImageRequestFactory, signal: AbortSignal): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error, value?: ResponseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      signal.removeEventListener("abort", onAbort);
      response?.destroy();
      req?.destroy();
      if (error) reject(failure()); else resolve(value!);
    };
    const onAbort = () => finish(failure());
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(onAbort, IDLE_MS);
    };
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (signal.aborted) { callback(failure(), "", 0); return; }
      // Node 24 can request either overload (including auto-family selection).
      if (options.all) callback(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    if (signal.aborted) { reject(failure()); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    touch();
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      req = request({
        protocol: "https:", hostname, port: url.port || 443,
        path: `${url.pathname}${url.search}`, method: "GET",
        // Literal IPs use certificate IP matching; DNS names retain original SNI.
        servername: isIP(hostname) ? "" : hostname,
        headers: { Host: url.host, Accept: "image/webp,image/png,image/jpeg,image/gif", "Accept-Encoding": "identity" },
        maxHeaderSize: MAX_HEADERS, lookup, family: pinned.family,
        agent: false, rejectUnauthorized: true,
      }, (incoming) => {
        response = incoming;
        incoming.on("error", onAbort);
        incoming.on("aborted", onAbort);
        if (settled) { incoming.destroy(); return; }
        touch();
        try {
          readResponseHeaders(incoming);
          const status = incoming.statusCode;
          if (status && [301,302,303,307,308].includes(status)) {
            const location = incoming.headers.location;
            if (!location || location.length > 2048) throw failure();
            finish(undefined, { redirect: location });
            return;
          }
          const contentType = incoming.headers["content-type"];
          const length = incoming.headers["content-length"];
          const encoding = incoming.headers["content-encoding"];
          const transfer = incoming.headers["transfer-encoding"];
          if (status !== 200 || typeof contentType !== "string" || !/^image\/(png|jpeg|webp|gif)$/i.test(contentType)) throw failure();
          if ((encoding && encoding !== "identity") || (transfer && transfer !== "chunked") || (length !== undefined && transfer)) throw failure();
          if (length !== undefined && (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BODY)) throw failure();
          const chunks: Buffer[] = [];
          let received = 0;
          incoming.on("data", (chunk: Buffer) => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) { finish(failure()); return; }
            received += chunk.length;
            if (received > MAX_BODY || (length !== undefined && received > Number(length))) { finish(failure()); return; }
            chunks.push(chunk);
            touch();
          });
          incoming.on("end", () => {
            if (!incoming.complete || received === 0 || (length !== undefined && received !== Number(length))) { finish(failure()); return; }
            finish(undefined, { bytes: Buffer.concat(chunks, received), contentType });
          });
          incoming.on("close", () => { if (!settled) finish(failure()); });
        } catch { finish(failure()); }
      });
      req.on("error", onAbort);
      req.on("close", () => { if (!settled) finish(failure()); });
      req.end();
    } catch { finish(failure()); }
  });
}

/** The authoritative remote URL, DNS, transport, and image-container boundary. */
export async function fetchRemoteImage(value: string, dependencies: RemoteImageDependencies = {}): Promise<RemoteImage> {
  const controller = new AbortController();
  const deadline = Date.now() + TOTAL_MS;
  let rejectDeadline!: (error: Error) => void;
  const expired = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectDeadline(failure()); }, TOTAL_MS);
  try {
    let url = validateRemoteUrl(value);
    for (let redirects = 0; ; redirects++) {
      const pinned = await Promise.race([resolvePublicAddress(url.hostname, dependencies.resolve), expired]);
      if (controller.signal.aborted || Date.now() >= deadline) throw failure();
      const result = await Promise.race([requestImage(url, pinned, dependencies.request ?? httpsRequest, controller.signal), expired]);
      if ("redirect" in result) {
        if (redirects >= 3 || /[\s\u0000-\u001f\u007f\\#]/.test(result.redirect)) throw failure();
        url = validateRemoteUrl(new URL(result.redirect, url).href);
        continue;
      }
      const metadata = sniffImage(result.bytes, result.contentType);
      if (Date.now() >= deadline) throw failure();
      return { bytes: result.bytes, ...metadata };
    }
  } catch {
    // Never propagate network/parser messages, URLs, queries, response bytes, or causes.
    throw failure();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
