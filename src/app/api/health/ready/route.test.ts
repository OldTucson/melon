import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkDatabaseReadiness: vi.fn(),
}));

vi.mock("@/lib/db/health", () => ({
  checkDatabaseReadiness: mocks.checkDatabaseReadiness,
}));

describe("GET /api/health/ready", () => {
  beforeEach(() => {
    mocks.checkDatabaseReadiness.mockReset();
    mocks.checkDatabaseReadiness.mockResolvedValue(undefined);
  });

  it("reports readiness after the database probe succeeds", async () => {
    const { GET } = await import("./route");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("sanitizes database failures", async () => {
    mocks.checkDatabaseReadiness.mockRejectedValueOnce(
      new Error("postgres password stack secret"),
    );
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(body)).toEqual({ status: "unavailable" });
    expect(body).not.toMatch(/postgres|password|stack|secret/i);
  });
});
