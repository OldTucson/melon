import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  parseBoundedImageSearchMultipart: vi.fn(),
  searchPatternsByImage: vi.fn(),
}));

vi.mock("@/features/auth/api-session", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/features/image-search/bounded-multipart", () => ({
  parseBoundedImageSearchMultipart: mocks.parseBoundedImageSearchMultipart,
}));
vi.mock("@/features/image-search/search-service", () => ({
  searchPatternsByImage: mocks.searchPatternsByImage,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const origin = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const requestId = randomUUID();
const image = new File(["jpeg"], "query.jpg", { type: "image/jpeg" });

function request(requestOrigin = origin) {
  return new Request(`${origin}/api/image-search`, {
    method: "POST",
    headers: { origin: requestOrigin },
    body: "unparsed",
    signal: new AbortController().signal,
  });
}

describe("POST /api/image-search", () => {
  beforeEach(() => {
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.parseBoundedImageSearchMultipart.mockResolvedValue({
      image,
      filters: JSON.stringify({ favorite: true }),
      requestId,
    });
    mocks.searchPatternsByImage.mockResolvedValue({
      query: { width: 400, height: 300 },
      groups: [
        {
          kind: "probable_source",
          items: [{ id: randomUUID(), matchKind: "probable_source" }],
        },
      ],
      timing: { totalMs: 120 },
    });
  });

  it("authenticates before reading or parsing the body", async () => {
    mocks.requireApiUser.mockRejectedValueOnce(
      new AppError("UNAUTHORIZED", 401, "Authentication required"),
    );
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.parseBoundedImageSearchMultipart).not.toHaveBeenCalled();
    expect(mocks.searchPatternsByImage).not.toHaveBeenCalled();
  });

  it("checks same origin before reading or parsing the body", async () => {
    const { POST } = await import("./route");

    const response = await POST(request("https://evil.test"));

    expect(response.status).toBe(403);
    expect(mocks.parseBoundedImageSearchMultipart).not.toHaveBeenCalled();
    expect(mocks.searchPatternsByImage).not.toHaveBeenCalled();
  });

  it("passes only authenticated ownership, validated fields, and request signal", async () => {
    const req = request();
    const { POST } = await import("./route");

    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.searchPatternsByImage).toHaveBeenCalledWith({
      ownerId,
      image,
      filters: {
        favorite: true,
        formats: [],
        tagIds: [],
        tagMode: "all",
        includeDescendants: true,
      },
      requestId,
      signal: req.signal,
    });
    const body = await response.text();
    expect(body).not.toMatch(/score|feature|signed|objectKey/i);
  });

  it("rejects malformed JSON filters before invoking search", async () => {
    mocks.parseBoundedImageSearchMultipart.mockResolvedValueOnce({
      image,
      filters: "not-json",
      requestId,
    });
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(mocks.searchPatternsByImage).not.toHaveBeenCalled();
  });
});
