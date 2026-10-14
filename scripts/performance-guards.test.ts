import { describe, expect, it } from "vitest";

import { assertDashboardPlan, assertPerformanceDatabaseUrl, summarizePlan } from "./performance-guards";

describe("performance verification safety", () => {
  it.each([undefined, "postgres://localhost/melon", "postgres://localhost/melon_test", "postgres://localhost/melon_e2e", "https://localhost/melon_performance_test", "postgres://localhost/melon_performance_test/extra"])("rejects unsafe or implicit database %s", (url) => {
    expect(() => assertPerformanceDatabaseUrl(url)).toThrow("PERFORMANCE_DATABASE_UNSAFE");
  });
  it("accepts an explicitly isolated performance database", () => {
    expect(assertPerformanceDatabaseUrl("postgres://localhost/melon_performance_test")).toBe("melon_performance_test");
  });
  it("rejects an unbounded scan even if hidden under aggregate and gather nodes", () => {
    expect(() => summarizePlan({ Plan: { "Node Type": "Aggregate", Plans: [{ "Node Type": "Gather", Plans: [{ "Node Type": "Seq Scan", "Relation Name": "authorizations", "Actual Rows": 100000 }] }] } })).toThrow("UNBOUNDED_SEQUENTIAL_SCAN:authorizations");
  });
  it("permits the planner's owner-bounded full-range scan and records its cost", () => {
    expect(summarizePlan({ "Execution Time": 34.5, Plan: { "Node Type": "Seq Scan", "Relation Name": "authorizations", Filter: "((owner_id = 'owner'::uuid) AND (status = 'active'))", "Actual Rows": 90000, "Rows Removed by Filter": 10000, "Shared Hit Blocks": 500 } })).toMatchObject({ executionMs: 34.5, sequentialScans: [{ relation: "authorizations", rows: 90000, removed: 10000, ownerBounded: true }] });
  });
  it("reports nested index usage without forcing the optimizer", () => {
    expect(summarizePlan({ Plan: { "Node Type": "Bitmap Heap Scan", Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": "authorizations_owner_status_date_idx" }] } }).indexes).toEqual(["authorizations_owner_status_date_idx"]);
  });
  it("rejects a selective period query that loses its owner/date index", () => {
    expect(() => assertDashboardPlan({ Plan: { "Node Type": "Seq Scan", "Relation Name": "authorizations", Filter: "owner_id = 'owner'::uuid" } }, { range: "current_year", metric: "period" })).toThrow("EXPECTED_AUTHORIZATION_INDEX_MISSING");
  });
  it("requires the field index for a selective field filter", () => {
    expect(() => assertDashboardPlan({ Plan: { "Node Type": "Index Scan", "Index Name": "authorizations_owner_status_date_idx" } }, { range: "current_year", metric: "trend", fieldId: "field" })).toThrow("EXPECTED_AUTHORIZATION_INDEX_MISSING");
  });
});
