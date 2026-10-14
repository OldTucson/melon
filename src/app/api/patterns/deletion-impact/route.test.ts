import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/http/app-error";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getPatternDeletionImpact: vi.fn(),
}));

vi.mock("@/features/auth/session", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/features/trash/commercial-impact", () => ({
  getPatternDeletionImpact: mocks.getPatternDeletionImpact,
}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ APP_ORIGIN: "http://localhost:3000" }),
}));

const origin = "http://localhost:3000";
const ownerId = "10000000-0000-4000-8000-000000000001";
const firstPatternId = "20000000-0000-4000-8000-000000000002";
const secondPatternId = "30000000-0000-4000-8000-000000000003";
const impact = {
  activeAuthorizationCount: 2,
  activeRevenueFen: "100000",
  totalAuthorizationCount: 3,
  assetCount: 4,
  purgeOn: "2026-11-13T00:00:00.000Z",
};

const post = (body: unknown, requestOrigin = origin) =>
  new Request(`${origin}/api/patterns/deletion-impact`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: requestOrigin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("pattern deletion-impact Route Handler", () => {
  beforeEach(() => {
    mocks.requireUser.mockResolvedValue({ id: ownerId });
    mocks.getPatternDeletionImpact.mockResolvedValue(impact);
  });

  it("returns an owner-scoped impact for normalized unique pattern IDs", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      post({ patternIds: [secondPatternId, firstPatternId.toUpperCase()] }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(impact);
    expect(mocks.getPatternDeletionImpact).toHaveBeenCalledWith({
      ownerId,
      patternIds: [secondPatternId, firstPatternId],
    });
  });

  it("rejects a cross-origin request before reading the impact", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      post({ patternIds: [firstPatternId] }, "https://evil.test"),
    );

    expect(response.status).toBe(403);
    expect(mocks.getPatternDeletionImpact).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["an empty selection", { patternIds: [] }],
    ["duplicate IDs", { patternIds: [firstPatternId, firstPatternId] }],
    [
      "case-equivalent IDs",
      { patternIds: [firstPatternId, firstPatternId.toUpperCase()] },
    ],
    [
      "an oversized selection",
      {
        patternIds: Array.from(
          { length: 101 },
          (_, index) =>
            `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      },
    ],
    ["unknown properties", { patternIds: [firstPatternId], ownerId }],
  ])("rejects %s", async (_name, body) => {
    const { POST } = await import("./route");
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    expect(mocks.getPatternDeletionImpact).not.toHaveBeenCalled();
  });

  it("preserves a tenant-neutral not-found response", async () => {
    mocks.getPatternDeletionImpact.mockRejectedValueOnce(
      new AppError("NOT_FOUND", 404, "Pattern not found"),
    );
    const { POST } = await import("./route");
    const response = await POST(post({ patternIds: [firstPatternId] }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Pattern not found" },
    });
  });
});
