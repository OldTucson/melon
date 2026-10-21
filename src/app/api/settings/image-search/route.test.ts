import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  getImageSearchIndexStatus: vi.fn(),
  retryFailedImageSearchJobs: vi.fn(),
  rebuildImageSearchIndex: vi.fn(),
}));

vi.mock("@/features/auth/api-session", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/features/image-search/index-admin-service", () => ({
  getImageSearchIndexStatus: mocks.getImageSearchIndexStatus,
  retryFailedImageSearchJobs: mocks.retryFailedImageSearchJobs,
  rebuildImageSearchIndex: mocks.rebuildImageSearchIndex,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const origin = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const status = {
  indexVersion: "visual-search-v1",
  eligible: 4,
  ready: 2,
  pending: 1,
  indexing: 0,
  failed: 1,
  worker: "online",
} as const;

describe("image search index settings routes", () => {
  beforeEach(() => {
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.getImageSearchIndexStatus.mockResolvedValue({
      ...status,
      modelSha256: "a".repeat(64),
      objectKey: "users/private/search-features.npz",
    });
    mocks.retryFailedImageSearchJobs.mockResolvedValue({ enqueued: 1 });
    mocks.rebuildImageSearchIndex.mockResolvedValue({
      enqueued: 3,
      alreadyExisting: 1,
    });
  });

  it("authenticates and returns only the owner-scoped status DTO", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(`${origin}/api/settings/image-search`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getImageSearchIndexStatus).toHaveBeenCalledWith(ownerId);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(status);
    expect(body).not.toMatch(/model|sha256|objectKey|signed|token|oss/i);
  });

  it("does not query index state when authentication fails", async () => {
    mocks.requireApiUser.mockRejectedValueOnce(
      new AppError("UNAUTHORIZED", 401, "Authentication required"),
    );
    const { GET } = await import("./route");
    const response = await GET(
      new Request(`${origin}/api/settings/image-search`),
    );

    expect(response.status).toBe(401);
    expect(mocks.getImageSearchIndexStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["retry", () => import("./retry/route")],
    ["rebuild", () => import("./rebuild/route")],
  ] as const)("protects the %s mutation with same-origin checks", async (path, load) => {
    const { POST } = await load();
    const response = await POST(
      new Request(`${origin}/api/settings/image-search/${path}`, {
        method: "POST",
        headers: { origin: "https://evil.test" },
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.retryFailedImageSearchJobs).not.toHaveBeenCalled();
    expect(mocks.rebuildImageSearchIndex).not.toHaveBeenCalled();
  });

  it("retries failures and rebuilds for the authenticated owner", async () => {
    const [{ POST: retry }, { POST: rebuild }] = await Promise.all([
      import("./retry/route"),
      import("./rebuild/route"),
    ]);
    const retryResponse = await retry(
      new Request(`${origin}/api/settings/image-search/retry`, {
        method: "POST",
        headers: { origin },
      }),
    );
    const rebuildResponse = await rebuild(
      new Request(`${origin}/api/settings/image-search/rebuild`, {
        method: "POST",
        headers: { origin },
      }),
    );

    expect(mocks.retryFailedImageSearchJobs).toHaveBeenCalledWith(ownerId);
    expect(mocks.rebuildImageSearchIndex).toHaveBeenCalledWith(ownerId);
    expect(await retryResponse.json()).toEqual({ enqueued: 1 });
    expect(await rebuildResponse.json()).toEqual({
      enqueued: 3,
      alreadyExisting: 1,
    });
  });
});
