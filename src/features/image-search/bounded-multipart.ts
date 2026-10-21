import "server-only";

import Busboy from "busboy";
import type { Readable } from "node:stream";

import { AppError } from "@/lib/http/app-error";

export const MAX_IMAGE_SEARCH_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_SEARCH_BODY_BYTES = 21 * 1024 * 1024;
export const MAX_IMAGE_SEARCH_FIELD_BYTES = 512 * 1024;

const MAX_PART_HEADER_BYTES = 16 * 1024;
const EXPECTED_FIELDS = new Set(["image", "filters", "requestId"]);
const acceptedImageTypes = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
]);

type ParsedPart = {
  name: string;
  filename?: string;
  mimeType?: string;
};

export type BoundedImageSearchMultipart = {
  image: File;
  filters: string;
  requestId: string;
};

const invalidFile = () =>
  new AppError("IMAGE_SEARCH_INVALID_FILE", 415, "Invalid search image");

const imageTooLarge = () =>
  new AppError(
    "IMAGE_SEARCH_IMAGE_TOO_LARGE",
    413,
    "Search image is too large",
  );

function extractBoundary(contentType: string | null) {
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw invalidFile();
  }
  const match = /(?:^|;)\s*boundary=(?:"([^"\r\n]{1,200})"|([^;\s\r\n]{1,200}))/i.exec(
    contentType,
  );
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || /[\x00-\x1f\x7f]/.test(boundary)) throw invalidFile();
  return boundary;
}

function parsePartHeaders(headers: Buffer): ParsedPart {
  const text = headers.toString("latin1");
  const disposition = text
    .split("\r\n")
    .find((line) => line.toLowerCase().startsWith("content-disposition:"));
  if (!disposition || !/form-data/i.test(disposition)) throw invalidFile();
  const name = /(?:^|;)\s*name="([^"\r\n]*)"/i.exec(disposition)?.[1];
  if (!name) throw invalidFile();
  const filename = /(?:^|;)\s*filename="([^"\r\n]*)"/i.exec(
    disposition,
  )?.[1];
  const mimeType = /^content-type:\s*([^\s;\r\n]+).*$/im.exec(text)?.[1];
  return { name, filename, mimeType };
}

class MultipartStreamGuard {
  readonly #boundary: Buffer;
  readonly #bodyMarker: Buffer;
  readonly #seen = new Set<string>();
  #buffer = Buffer.alloc(0);
  #state: "boundary" | "headers" | "body" | "done" = "boundary";
  #currentIsFile = false;
  #currentBytes = 0;

  constructor(boundary: string) {
    this.#boundary = Buffer.from(`--${boundary}`, "latin1");
    this.#bodyMarker = Buffer.from(`\r\n--${boundary}`, "latin1");
  }

  push(value: Uint8Array) {
    if (this.#state === "done") return;
    this.#buffer = Buffer.concat([
      this.#buffer,
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    ]);
    this.#process();
  }

  finish() {
    this.#process();
    if (this.#state !== "done" || this.#seen.size !== EXPECTED_FIELDS.size) {
      throw invalidFile();
    }
  }

  #process() {
    while (true) {
      if (this.#state === "boundary") {
        if (this.#buffer.length < this.#boundary.length + 2) return;
        if (!this.#buffer.subarray(0, this.#boundary.length).equals(this.#boundary)) {
          throw invalidFile();
        }
        const suffix = this.#buffer.subarray(
          this.#boundary.length,
          this.#boundary.length + 2,
        );
        this.#buffer = this.#buffer.subarray(this.#boundary.length + 2);
        if (suffix.equals(Buffer.from("--"))) {
          this.#state = "done";
          return;
        }
        if (!suffix.equals(Buffer.from("\r\n"))) throw invalidFile();
        this.#state = "headers";
        continue;
      }

      if (this.#state === "headers") {
        const end = this.#buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.#buffer.length > MAX_PART_HEADER_BYTES) throw invalidFile();
          return;
        }
        if (end > MAX_PART_HEADER_BYTES) throw invalidFile();
        const part = parsePartHeaders(this.#buffer.subarray(0, end));
        if (!EXPECTED_FIELDS.has(part.name) || this.#seen.has(part.name)) {
          throw invalidFile();
        }
        this.#seen.add(part.name);
        this.#currentIsFile = part.name === "image";
        if (this.#currentIsFile) {
          if (!part.filename || !part.mimeType) throw invalidFile();
        } else if (part.filename !== undefined) {
          throw invalidFile();
        }
        this.#currentBytes = 0;
        this.#buffer = this.#buffer.subarray(end + 4);
        this.#state = "body";
        continue;
      }

      if (this.#state === "body") {
        const boundaryIndex = this.#findBodyBoundary();
        if (boundaryIndex >= 0) {
          this.#countBodyBytes(boundaryIndex);
          this.#buffer = this.#buffer.subarray(boundaryIndex + 2);
          this.#state = "boundary";
          continue;
        }
        const retained = this.#bodyMarker.length + 2;
        const safeBytes = Math.max(0, this.#buffer.length - retained);
        if (safeBytes === 0) return;
        this.#countBodyBytes(safeBytes);
        this.#buffer = this.#buffer.subarray(safeBytes);
        return;
      }

      return;
    }
  }

  #findBodyBoundary() {
    let from = 0;
    while (true) {
      const index = this.#buffer.indexOf(this.#bodyMarker, from);
      if (index < 0) return -1;
      const suffixIndex = index + this.#bodyMarker.length;
      if (this.#buffer.length < suffixIndex + 2) return -1;
      const suffix = this.#buffer.subarray(suffixIndex, suffixIndex + 2);
      if (suffix.equals(Buffer.from("--")) || suffix.equals(Buffer.from("\r\n"))) {
        return index;
      }
      from = index + 1;
    }
  }

  #countBodyBytes(count: number) {
    this.#currentBytes += count;
    const limit = this.#currentIsFile
      ? MAX_IMAGE_SEARCH_FILE_BYTES
      : MAX_IMAGE_SEARCH_FIELD_BYTES;
    if (this.#currentBytes > limit) {
      throw this.#currentIsFile ? imageTooLarge() : invalidFile();
    }
  }
}

function validateImage(filename: string, mimeType: string, bytes: Buffer) {
  const extension = filename.toLowerCase().split(".").pop();
  if (
    !extension ||
    acceptedImageTypes.get(extension) !== mimeType.toLowerCase() ||
    bytes.byteLength === 0
  ) {
    throw invalidFile();
  }
}

function cancelBody(request: Request, reason?: unknown) {
  try {
    const cancellation = request.body?.cancel(reason);
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // The body may already be locked by a reader or closed by the client.
  }
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
) {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best effort after a malformed body or disconnect.
  }
}

export async function parseBoundedImageSearchMultipart(
  request: Request,
): Promise<BoundedImageSearchMultipart> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      cancelBody(request);
      throw invalidFile();
    }
    if (Number(declaredLength) > MAX_IMAGE_SEARCH_BODY_BYTES) {
      cancelBody(request, imageTooLarge());
      throw imageTooLarge();
    }
  }

  let boundary: string;
  try {
    boundary = extractBoundary(request.headers.get("content-type"));
  } catch (error) {
    cancelBody(request, error);
    throw error;
  }
  if (!request.body) throw invalidFile();

  const guard = new MultipartStreamGuard(boundary);
  const reader = request.body.getReader();
  const fields = new Map<string, string>();
  const fileChunks: Buffer[] = [];
  const fileStreams = new Set<Readable>();
  let totalBytes = 0;
  let filename: string | undefined;
  let mimeType: string | undefined;
  let parserError: unknown;

  let resolveParser!: () => void;
  const parserDone = new Promise<void>((resolve) => {
    resolveParser = resolve;
  });

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: Object.fromEntries(request.headers.entries()),
      limits: {
        // The streaming guard enforces the inclusive public caps. Busboy's
        // limit event fires when the threshold is reached, so give it one
        // byte of headroom to keep an exact-limit payload valid.
        fileSize: MAX_IMAGE_SEARCH_FILE_BYTES + 1,
        files: 1,
        fields: 3,
        fieldSize: MAX_IMAGE_SEARCH_FIELD_BYTES + 1,
        parts: 4,
        headerPairs: 32,
      },
    });
  } catch {
    reader.releaseLock();
    cancelBody(request);
    throw invalidFile();
  }

  const fail = (error: unknown) => {
    if (parserError !== undefined) return;
    parserError = error;
    parser.destroy(error instanceof Error ? error : invalidFile());
  };

  parser.on("file", (name, stream, info) => {
    fileStreams.add(stream);
    if (name !== "image" || filename !== undefined || !info.filename) {
      stream.resume();
      fail(invalidFile());
      return;
    }
    filename = info.filename;
    mimeType = info.mimeType;
    stream.on("data", (chunk: Buffer) => fileChunks.push(Buffer.from(chunk)));
    stream.once("limit", () => fail(imageTooLarge()));
    stream.once("error", fail);
    stream.once("close", () => fileStreams.delete(stream));
  });
  parser.on("field", (name, value, info) => {
    if (
      name === "image" ||
      !EXPECTED_FIELDS.has(name) ||
      fields.has(name) ||
      info.valueTruncated
    ) {
      fail(invalidFile());
      return;
    }
    fields.set(name, value);
  });
  parser.once("filesLimit", () => fail(invalidFile()));
  parser.once("fieldsLimit", () => fail(invalidFile()));
  parser.once("partsLimit", () => fail(invalidFile()));
  parser.once("error", (error) => {
    parserError ??= error;
    resolveParser();
  });
  parser.once("close", () => {
    resolveParser();
  });

  const abortReason = () =>
    request.signal.reason ?? new DOMException("Request aborted", "AbortError");
  const onAbort = () => {
    const reason = abortReason();
    cancelReader(reader, reason);
    fail(reason);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (request.signal.aborted) throw abortReason();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (request.signal.aborted) throw abortReason();
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMAGE_SEARCH_BODY_BYTES) throw imageTooLarge();
      guard.push(value);
      await new Promise<void>((resolve, reject) => {
        parser.write(Buffer.from(value), (error) =>
          error ? reject(error) : resolve(),
        );
      });
      if (parserError !== undefined) throw parserError;
    }
    guard.finish();
    parser.end();
    await parserDone;
    if (parserError !== undefined) throw parserError;

    const filters = fields.get("filters");
    const requestId = fields.get("requestId");
    if (
      filename === undefined ||
      mimeType === undefined ||
      filters === undefined ||
      requestId === undefined ||
      fields.size !== 2
    ) {
      throw invalidFile();
    }
    const bytes = Buffer.concat(fileChunks);
    validateImage(filename, mimeType, bytes);
    return {
      image: new File([bytes], filename, { type: mimeType }),
      filters,
      requestId,
    };
  } catch (error) {
    for (const stream of fileStreams) stream.destroy();
    if (!parser.destroyed) parser.destroy(invalidFile());
    cancelReader(reader, error);
    await parserDone;
    if (request.signal.aborted) throw abortReason();
    if (error instanceof AppError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw invalidFile();
  } finally {
    request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
    parser.removeAllListeners();
    for (const stream of fileStreams) stream.removeAllListeners();
  }
}
