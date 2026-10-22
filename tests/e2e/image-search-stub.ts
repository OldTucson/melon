import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { E2E_USERS } from "./environment";
import { IMAGE_SEARCH_PATTERN_SEEDS } from "./image-search-fixtures";

const maximumBodyBytes = 21 * 1024 * 1024;

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

export function createImageSearchStub(token: string) {
  return createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/internal/search") {
        sendJson(response, 404, { detail: { code: "NOT_FOUND" } });
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        sendJson(response, 401, {
          detail: { code: "INTERNAL_AUTH_REQUIRED" },
        });
        return;
      }
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
        typeof rawAllowed === "string"
          ? (JSON.parse(rawAllowed) as unknown)
          : null;
      if (
        ownerId !== E2E_USERS.designer.id ||
        typeof requestId !== "string" ||
        !(image instanceof File) ||
        !Array.isArray(allowed) ||
        allowed.some((value) => typeof value !== "string")
      ) {
        sendJson(response, 415, { detail: { code: "INVALID_FILE" } });
        return;
      }

      const allowedIds = new Set(allowed);
      const known = IMAGE_SEARCH_PATTERN_SEEDS.filter((pattern) =>
        allowedIds.has(pattern.id),
      );
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
    } catch {
      sendJson(response, 500, { detail: { code: "UNAVAILABLE" } });
    }
  });
}
