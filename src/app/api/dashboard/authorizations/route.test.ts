import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  getAuthorizationDashboard: vi.fn(),
}));

vi.mock("@/features/auth/api-session", () => ({
  requireApiUser: mocks.requireApiUser,
}));
vi.mock("@/features/analytics/dashboard-service", () => ({
  getAuthorizationDashboard: mocks.getAuthorizationDashboard,
}));

const ownerId = "10000000-0000-4000-8000-000000000001";
const attackerId = "20000000-0000-4000-8000-000000000002";
const fieldId = "00000000-0000-4000-8000-000000000003";
const responseDto = {
  range: {
    start: "2026-09-01",
    end: "2026-10-08",
    comparison: { start: "2026-07-25", end: "2026-08-31" },
  },
  metrics: {
    revenueFen: "128000",
    count: 1,
    patternCount: 1,
    averageFen: "128000",
    comparisonPercent: null,
  },
  trend: [],
  currentStates: [],
  fields: [],
  topPatterns: [],
};

describe("authorization dashboard route", () => {
  beforeEach(() => {
    mocks.requireApiUser.mockResolvedValue({ id: ownerId });
    mocks.getAuthorizationDashboard.mockResolvedValue(responseDto);
  });

  it("passes validated filters with authenticated ownership only", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `http://localhost/api/dashboard/authorizations?range=custom&start=2026-09-01&end=2026-10-08&kind=standard&field=${fieldId.toUpperCase()}&ownerId=${attackerId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.getAuthorizationDashboard).toHaveBeenCalledWith({
      ownerId,
      query: {
        range: "custom",
        start: "2026-09-01",
        end: "2026-10-08",
        kind: "standard",
        fieldId,
      },
    });
    await expect(response.json()).resolves.toEqual(responseDto);
  });

  it("defaults to current year", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/dashboard/authorizations"),
    );

    expect(response.status).toBe(200);
    expect(mocks.getAuthorizationDashboard).toHaveBeenCalledWith({
      ownerId,
      query: {
        range: "current_year",
      },
    });
  });

  it("authenticates before parsing malformed filters", async () => {
    mocks.requireApiUser.mockRejectedValueOnce(new Error("AUTH_SENTINEL"));
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard/authorizations?range=custom",
      ),
    );

    expect(response.status).toBe(500);
    expect(mocks.getAuthorizationDashboard).not.toHaveBeenCalled();
  });

  it("rejects incomplete custom ranges and malformed filters", async () => {
    const { GET } = await import("./route");
    for (const search of [
      "range=custom&start=2026-09-01",
      "range=unknown",
      "kind=unknown",
      "field=not-a-uuid",
    ]) {
      const response = await GET(
        new Request(
          `http://localhost/api/dashboard/authorizations?${search}`,
        ),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.getAuthorizationDashboard).not.toHaveBeenCalled();
  });
});
