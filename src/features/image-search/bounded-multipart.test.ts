import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_IMAGE_SEARCH_BODY_BYTES,
  MAX_IMAGE_SEARCH_FIELD_BYTES,
  MAX_IMAGE_SEARCH_FILE_BYTES,
  parseBoundedImageSearchMultipart,
} from "./bounded-multipart";

const encoder = new TextEncoder();
const requestId = randomUUID();

type Settlement =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; error: unknown }
  | { status: "pending" };

function settleWithin(
  promise: Promise<unknown>,
  milliseconds = 100,
): Promise<Settlement> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: "pending" }), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ status: "fulfilled", value });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        resolve({ status: "rejected", error });
      },
    );
  });
}

function multipartBody(
  boundary: string,
  parts: Array<{
    name: string;
    value: Uint8Array | string;
    filename?: string;
    contentType?: string;
  }>,
) {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(encoder.encode(`--${boundary}\r\n`));
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`;
    chunks.push(encoder.encode(disposition));
    chunks.push(typeof part.value === "string" ? encoder.encode(part.value) : part.value);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function streamRequest(
  chunks: readonly Uint8Array[],
  input: {
    boundary?: string;
    contentLength?: string;
    contentType?: string;
    keepOpen?: boolean;
    onCancel?: (reason?: unknown) => void | PromiseLike<void>;
    signal?: AbortSignal;
  } = {},
) {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk) controller.enqueue(chunk);
      else if (!input.keepOpen) controller.close();
    },
    cancel(reason) {
      cancelled = true;
      return input.onCancel?.(reason);
    },
  });
  const boundary = input.boundary ?? "melon-boundary";
  const headers = new Headers({
    "content-type":
      input.contentType ?? `multipart/form-data; boundary=${boundary}`,
  });
  if (input.contentLength) headers.set("content-length", input.contentLength);
  const request = new Request("http://localhost/api/image-search", {
    method: "POST",
    headers,
    body,
    duplex: "half",
    signal: input.signal,
  } as RequestInit & { duplex: "half" });
  return {
    request,
    pulls: () => pulls,
    cancelled: () => cancelled,
  };
}

const validParts = (image: Uint8Array = encoder.encode("image")) => [
  {
    name: "image",
    filename: "query.jpg",
    contentType: "image/jpeg",
    value: image,
  },
  { name: "filters", value: JSON.stringify({ favorite: true }) },
  { name: "requestId", value: requestId },
];

describe("parseBoundedImageSearchMultipart", () => {
  it("parses a chunked body without requiring Content-Length", async () => {
    const body = multipartBody("melon-boundary", validParts());
    const stream = streamRequest([body.subarray(0, 29), body.subarray(29)]);

    const result = await parseBoundedImageSearchMultipart(stream.request);

    expect(result.image.name).toBe("query.jpg");
    expect(result.image.type).toBe("image/jpeg");
    expect(await result.image.text()).toBe("image");
    expect(result.filters).toBe(JSON.stringify({ favorite: true }));
    expect(result.requestId).toBe(requestId);
  });

  it("does not trust a forged small Content-Length and stops at 21 MiB", async () => {
    const body = multipartBody("melon-boundary", [
      validParts(new Uint8Array(MAX_IMAGE_SEARCH_FILE_BYTES - 1))[0]!,
      { name: "filters", value: "x".repeat(512 * 1024 - 1) },
      { name: "requestId", value: "x".repeat(512 * 1024 - 1) },
    ]);
    const chunkBytes = 1024 * 1024;
    const chunks: Uint8Array[] = [
      ...Array.from(
        { length: Math.ceil(body.byteLength / chunkBytes) },
        (_, index) =>
          body.subarray(index * chunkBytes, (index + 1) * chunkBytes),
      ),
      new Uint8Array(chunkBytes),
      new Uint8Array(chunkBytes),
      new Uint8Array(chunkBytes),
    ];
    const stream = streamRequest(chunks, { contentLength: "1" });

    await expect(
      parseBoundedImageSearchMultipart(stream.request),
    ).rejects.toMatchObject({
      code: "IMAGE_SEARCH_IMAGE_TOO_LARGE",
      status: 413,
    });
    expect(stream.pulls()).toBeLessThan(chunks.length);
    expect(stream.cancelled()).toBe(true);
  });

  it("rejects a declared body above 21 MiB without pulling the stream", async () => {
    const cancelBody = vi.fn(() => new Promise<void>(() => undefined));
    const stream = streamRequest([encoder.encode("must-not-be-read")], {
      contentLength: String(MAX_IMAGE_SEARCH_BODY_BYTES + 1),
      onCancel: cancelBody,
    });

    const settlement = await settleWithin(
      parseBoundedImageSearchMultipart(stream.request),
    );
    expect(settlement).toMatchObject({
      status: "rejected",
      error: { code: "IMAGE_SEARCH_IMAGE_TOO_LARGE", status: 413 },
    });
    expect(stream.pulls()).toBe(0);
    expect(stream.cancelled()).toBe(true);
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });

  it("rejects an image above 20 MiB", async () => {
    const body = multipartBody(
      "melon-boundary",
      validParts(new Uint8Array(MAX_IMAGE_SEARCH_FILE_BYTES + 1)),
    );

    await expect(
      parseBoundedImageSearchMultipart(streamRequest([body]).request),
    ).rejects.toMatchObject({
      code: "IMAGE_SEARCH_IMAGE_TOO_LARGE",
      status: 413,
    });
  });

  it("accepts a file and text field exactly at their byte limits", async () => {
    const filters = "x".repeat(MAX_IMAGE_SEARCH_FIELD_BYTES);
    const body = multipartBody(
      "melon-boundary",
      validParts(new Uint8Array(MAX_IMAGE_SEARCH_FILE_BYTES)).map((part) =>
        part.name === "filters" ? { ...part, value: filters } : part,
      ),
    );

    const result = await parseBoundedImageSearchMultipart(
      streamRequest([body]).request,
    );

    expect(result.image.size).toBe(MAX_IMAGE_SEARCH_FILE_BYTES);
    expect(result.filters).toHaveLength(MAX_IMAGE_SEARCH_FIELD_BYTES);
  });

  it("rejects a second file before reading its payload", async () => {
    const boundary = "melon-boundary";
    const first = multipartBody(boundary, validParts()).subarray(
      0,
      -encoder.encode(`--${boundary}--\r\n`).byteLength,
    );
    const secondHeader = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="second.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    );
    const stream = streamRequest([
      Buffer.concat([first, secondHeader]),
      encoder.encode("payload-that-must-not-be-read"),
    ]);

    await expect(
      parseBoundedImageSearchMultipart(stream.request),
    ).rejects.toMatchObject({ code: "IMAGE_SEARCH_INVALID_FILE", status: 415 });
    expect(stream.pulls()).toBe(1);
    expect(stream.cancelled()).toBe(true);
  });

  it("stops reading and cancels when a recognized text field exceeds its cap", async () => {
    const oversized = multipartBody("melon-boundary", [
      validParts()[0]!,
      { name: "filters", value: "x".repeat(600 * 1024) },
      validParts()[2]!,
    ]);
    const chunks: Uint8Array[] = [
      ...Array.from(
        { length: Math.ceil(oversized.byteLength / (64 * 1024)) },
        (_, index) =>
          oversized.subarray(index * 64 * 1024, (index + 1) * 64 * 1024),
      ),
      new Uint8Array(64 * 1024),
      new Uint8Array(64 * 1024),
      new Uint8Array(64 * 1024),
    ];
    const stream = streamRequest(chunks);
    await expect(
      parseBoundedImageSearchMultipart(stream.request),
    ).rejects.toMatchObject({ code: "IMAGE_SEARCH_INVALID_FILE", status: 415 });
    expect(stream.pulls()).toBeLessThan(chunks.length);
    expect(stream.cancelled()).toBe(true);
  });

  it("rejects extra, duplicate, and missing fields", async () => {
    for (const parts of [
      [...validParts(), { name: "extra", value: "no" }],
      [...validParts(), { name: "filters", value: "{}" }],
      validParts().filter((part) => part.name !== "requestId"),
    ]) {
      const body = multipartBody("melon-boundary", parts);
      await expect(
        parseBoundedImageSearchMultipart(streamRequest([body]).request),
      ).rejects.toMatchObject({
        code: "IMAGE_SEARCH_INVALID_FILE",
        status: 415,
      });
    }
  });

  it("rejects malformed boundaries and releases its abort listener", async () => {
    const stream = streamRequest([encoder.encode("not multipart")]);
    const addListener = vi.spyOn(stream.request.signal, "addEventListener");
    const removeListener = vi.spyOn(stream.request.signal, "removeEventListener");
    await expect(
      parseBoundedImageSearchMultipart(stream.request),
    ).rejects.toMatchObject({ code: "IMAGE_SEARCH_INVALID_FILE", status: 415 });
    expect(stream.pulls()).toBe(2);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("settles a parse error when source cancellation never settles", async () => {
    const cancelBody = vi.fn(() => new Promise<void>(() => undefined));
    const stream = streamRequest([encoder.encode("not multipart payload")], {
      keepOpen: true,
      onCancel: cancelBody,
    });
    const addListener = vi.spyOn(stream.request.signal, "addEventListener");
    const removeListener = vi.spyOn(stream.request.signal, "removeEventListener");

    const settlement = await settleWithin(
      parseBoundedImageSearchMultipart(stream.request),
    );

    expect(settlement).toMatchObject({
      status: "rejected",
      error: { code: "IMAGE_SEARCH_INVALID_FILE", status: 415 },
    });
    expect(cancelBody).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("cancels without reading when the multipart boundary is missing", async () => {
    const stream = streamRequest([encoder.encode("must-not-be-read")], {
      contentType: "multipart/form-data",
    });

    await expect(
      parseBoundedImageSearchMultipart(stream.request),
    ).rejects.toMatchObject({ code: "IMAGE_SEARCH_INVALID_FILE", status: 415 });
    expect(stream.pulls()).toBe(0);
    expect(stream.cancelled()).toBe(true);
  });

  it("stops and releases the source when the client aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          encoder.encode(
            '--melon-boundary\r\nContent-Disposition: form-data; name="image"; filename="query.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
          ),
        );
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const request = new Request("http://localhost/api/image-search", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=melon-boundary",
      },
      body,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" });
    const addListener = vi.spyOn(request.signal, "addEventListener");
    const removeListener = vi.spyOn(request.signal, "removeEventListener");

    const pending = parseBoundedImageSearchMultipart(request);
    controller.abort();

    const settlement = await settleWithin(pending);
    expect(settlement).toMatchObject({
      status: "rejected",
      error: { name: "AbortError" },
    });
    expect(cancelled).toBe(true);
    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
