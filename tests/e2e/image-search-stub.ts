import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { E2E_USERS } from "./environment";
import { IMAGE_SEARCH_PATTERN_SEEDS } from "./image-search-fixtures";

const maximumBodyBytes = 21 * 1024 * 1024;
const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const paletteHex = /^#[0-9A-F]{6}$/;

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximumBodyBytes) throw new Error("E2E_STUB_BODY_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(encoded),
    "content-type": "application/json",
  });
  response.end(encoded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function knownAllowedPatternIds(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > 10_000 ||
    value.some((item) => typeof item !== "string" || !canonicalUuid.test(item)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  const allowed = new Set(value);
  return IMAGE_SEARCH_PATTERN_SEEDS.filter((pattern) => allowed.has(pattern.id));
}

async function handleImageSearch(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const body = await readBody(request);
  const parsedRequest = new Request("http://127.0.0.1/internal/search", {
    body,
    headers: request.headers as HeadersInit,
    method: "POST",
  });
  const form = await parsedRequest.formData();
  const ownerId = form.get("ownerId");
  const requestId = form.get("requestId");
  const image = form.get("image");
  const rawAllowed = form.get("allowedPatternIds");
  const allowed =
    typeof rawAllowed === "string" ? (JSON.parse(rawAllowed) as unknown) : null;
  const known = knownAllowedPatternIds(allowed);
  if (
    ownerId !== E2E_USERS.designer.id ||
    typeof requestId !== "string" ||
    !canonicalUuid.test(requestId) ||
    !(image instanceof File) ||
    known === null
  ) {
    sendJson(response, 415, { detail: { code: "INVALID_FILE" } });
    return;
  }

  const filteredRerun = known.length <= 2;
  const items = known.slice(0, 3).map((pattern, index) => ({
    patternId: pattern.id,
    kind: filteredRerun ? "visually_similar" : pattern.kind,
    score: 0.99 - index * 0.05,
  }));
  sendJson(response, 200, {
    requestId,
    query: { width: 320, height: 240 },
    items,
  });
}

async function handlePaletteSearch(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0];
  const payload: unknown = JSON.parse((await readBody(request)).toString("utf8"));
  if (
    contentType !== "application/json" ||
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      "ownerId",
      "allowedPatternIds",
      "requestId",
      "colors",
    ])
  ) {
    sendJson(response, 422, { detail: { code: "INVALID_COLORS" } });
    return;
  }
  const known = knownAllowedPatternIds(payload.allowedPatternIds);
  const colors = payload.colors;
  if (
    payload.ownerId !== E2E_USERS.designer.id ||
    typeof payload.requestId !== "string" ||
    !canonicalUuid.test(payload.requestId) ||
    known === null ||
    !Array.isArray(colors) ||
    colors.length < 1 ||
    colors.length > 5 ||
    colors.some((color) => typeof color !== "string" || !paletteHex.test(color)) ||
    new Set(colors).size !== colors.length
  ) {
    sendJson(response, 422, { detail: { code: "INVALID_COLORS" } });
    return;
  }

  const order = known.length <= 2 ? [1, 0] : [2, 0, 3, 1];
  const knownById = new Map(known.map((pattern) => [pattern.id, pattern]));
  const items = order
    .flatMap((index) => {
      const pattern = IMAGE_SEARCH_PATTERN_SEEDS[index];
      return pattern && knownById.has(pattern.id) ? [pattern] : [];
    })
    .map((pattern, index) => ({
      patternId: pattern.id,
      distance: 0.01 + index * 0.01,
    }));
  sendJson(response, 200, {
    requestId: payload.requestId,
    query: { colors },
    items,
  });
}

export function createImageSearchStub(token: string) {
  return createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        !["/internal/search", "/internal/palette-search"].includes(
          request.url ?? "",
        )
      ) {
        sendJson(response, 404, { detail: { code: "NOT_FOUND" } });
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        sendJson(response, 401, {
          detail: { code: "INTERNAL_AUTH_REQUIRED" },
        });
        return;
      }
      if (request.url === "/internal/search") {
        await handleImageSearch(request, response);
      } else {
        await handlePaletteSearch(request, response);
      }
    } catch {
      sendJson(response, 500, { detail: { code: "UNAVAILABLE" } });
    }
  });
}
