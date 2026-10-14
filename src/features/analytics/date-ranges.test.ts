import { describe, expect, it } from "vitest";

import { resolveRange, resolveTrendGranularity } from "./date-ranges";

const today = "2026-10-08";

describe("dashboard date ranges", () => {
  it("resolves current year with the same year-to-date comparison", () => {
    expect(resolveRange({ range: "current_year" }, today)).toEqual({
      start: "2026-01-01",
      end: "2026-10-08",
      comparison: { start: "2025-01-01", end: "2025-10-08" },
    });
  });

  it("clamps leap-day year-to-date comparisons", () => {
    expect(resolveRange({ range: "current_year" }, "2024-02-29")).toEqual({
      start: "2024-01-01",
      end: "2024-02-29",
      comparison: { start: "2023-01-01", end: "2023-02-28" },
    });
  });

  it("resolves rolling twelve months and its immediately preceding period", () => {
    expect(resolveRange({ range: "last_12_months" }, today)).toEqual({
      start: "2025-10-09",
      end: "2026-10-08",
      comparison: { start: "2024-10-09", end: "2025-10-08" },
    });
  });

  it("keeps rolling twelve-month comparisons exact across a leap-day start", () => {
    expect(
      resolveRange({ range: "last_12_months" }, "2025-02-28"),
    ).toEqual({
      start: "2024-02-29",
      end: "2025-02-28",
      comparison: { start: "2023-03-01", end: "2024-02-28" },
    });
  });

  it("compares a custom range with the preceding equal inclusive day count", () => {
    expect(
      resolveRange(
        { range: "custom", start: "2026-09-01", end: "2026-10-08" },
        today,
      ),
    ).toEqual({
      start: "2026-09-01",
      end: "2026-10-08",
      comparison: { start: "2026-07-25", end: "2026-08-31" },
    });
  });

  it("leaves all-time open ended with no comparison", () => {
    expect(resolveRange({ range: "all_time" }, today)).toEqual({
      start: null,
      end: today,
      comparison: null,
    });
  });

  it("rejects reversed or future custom periods", () => {
    expect(() =>
      resolveRange(
        { range: "custom", start: "2026-10-09", end: "2026-10-08" },
        today,
      ),
    ).toThrow();
    expect(() =>
      resolveRange(
        { range: "custom", start: "2026-10-01", end: "2026-10-09" },
        today,
      ),
    ).toThrow();
  });

  it("uses deterministic day, month, and year trend boundaries", () => {
    expect(
      resolveTrendGranularity(
        { start: "2026-09-01", end: "2026-10-08" },
        "custom",
      ),
    ).toBe("day");
    expect(
      resolveTrendGranularity(
        { start: "2026-01-01", end: "2026-03-03" },
        "custom",
      ),
    ).toBe("day");
    expect(
      resolveTrendGranularity(
        { start: "2026-01-01", end: "2026-03-04" },
        "custom",
      ),
    ).toBe("month");
    expect(
      resolveTrendGranularity(
        { start: "2024-01-01", end: "2025-12-31" },
        "custom",
      ),
    ).toBe("month");
    expect(
      resolveTrendGranularity(
        { start: "2024-01-01", end: "2026-01-01" },
        "custom",
      ),
    ).toBe("year");
    expect(
      resolveTrendGranularity(
        { start: "2026-09-01", end: "2026-10-08" },
        "current_year",
      ),
    ).toBe("month");
    expect(
      resolveTrendGranularity(
        { start: "2024-10-09", end: "2026-10-08" },
        "all_time",
      ),
    ).toBe("month");
    expect(
      resolveTrendGranularity(
        { start: "2024-10-07", end: "2026-10-08" },
        "all_time",
      ),
    ).toBe("year");
  });
});
