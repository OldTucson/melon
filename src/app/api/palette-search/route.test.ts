import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  searchPatternsByPalette: vi.fn(),
}));

vi.mock("@/features/auth/api-session", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/features/palette-search/palette-search-service", () => ({
  searchPatternsByPalette: mocks.searchPatternsByPalette,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const origin = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const requestId = "123e4567-e89b-42d3-a456-426614174000";

function request(
  body: string = JSON.stringify({
    requestId,
    colors: ["#285947", "#CC9C3F"],
    filters: { favorite: true },
  }),
  options: { origin?: string; contentType?: string } = {},
) {
  return new Request(`${origin}/api/palette-search`, {
    method: "POST",
    headers: {
      origin: options.origin ?? origin,
      ...(options.contentType === undefined
        ? { "content-type": "application/json" }
        : options.contentType
          ? { "content-type": options.contentType }
          : {}),
    },
    body,
    signal: new AbortController().signal,
  });
}

describe("POST /api/palette-search", () => {
  beforeEach(() => {
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.searchPatternsByPalette.mockResolvedValue({
      query: { colors: ["#285947", "#CC9C3F"] },
      items: [],
      timing: { totalMs: 20 },
    });
  });

  it("authenticates before reading the request body", async () => {
    mocks.requireApiUser.mockRejectedValueOnce(
      new AppError("UNAUTHORIZED", 401, "Authentication required"),
    );
    const req = request("{");
    const json = vi.spyOn(req, "json");
    const { POST } = await import("./route");

    const response = await POST(req);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(json).not.toHaveBeenCalled();
    expect(mocks.searchPatternsByPalette).not.toHaveBeenCalled();
  });

  it("checks same origin before reading the request body", async () => {
    const req = request("{", { origin: "https://evil.test" });
    const json = vi.spyOn(req, "json");
    const { POST } = await import("./route");

    const response = await POST(req);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(json).not.toHaveBeenCalled();
    expect(mocks.searchPatternsByPalette).not.toHaveBeenCalled();
  });

  it("rejects non-JSON media before parsing the request body", async () => {
    const req = request("not-json", { contentType: "text/plain" });
    const json = vi.spyOn(req, "json");
    const { POST } = await import("./route");

    const response = await POST(req);

    expect(response.status).toBe(415);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "PALETTE_SEARCH_INVALID_COLORS" },
    });
    expect(json).not.toHaveBeenCalled();
  });

  it("passes only authenticated ownership, validated input, and request signal", async () => {
    const req = request(undefined, {
      contentType: "application/json; charset=utf-8",
    });
    const { POST } = await import("./route");

    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.searchPatternsByPalette).toHaveBeenCalledWith({
      ownerId,
      requestId,
      colors: ["#285947", "#CC9C3F"],
      filters: {
        favorite: true,
        formats: [],
        tagIds: [],
        tagMode: "all",
        includeDescendants: true,
      },
      signal: req.signal,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "empty colors",
      JSON.stringify({ requestId, colors: [], filters: {} }),
    ],
    [
      "duplicate colors",
      JSON.stringify({
        requestId,
        colors: ["#285947", "#285947"],
        filters: {},
      }),
    ],
    [
      "unknown fields",
      JSON.stringify({
        requestId,
        colors: ["#285947"],
        filters: {},
        ownerId: randomUUID(),
      }),
    ],
  ])("maps %s to the stable invalid-colors error", async (_name, body) => {
    const { POST } = await import("./route");

    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "PALETTE_SEARCH_INVALID_COLORS" },
    });
    expect(mocks.searchPatternsByPalette).not.toHaveBeenCalled();
  });

  it("sets no-store on service errors", async () => {
    mocks.searchPatternsByPalette.mockRejectedValueOnce(
      new AppError(
        "PALETTE_SEARCH_NO_INDEX",
        409,
        "No searchable palette index",
      ),
    );
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "PALETTE_SEARCH_NO_INDEX" },
    });
  });
});
