export function assertPerformanceDatabaseUrl(databaseUrl: string | undefined): string {
  try {
    const url = new URL(databaseUrl ?? "");
    const name = decodeURIComponent(url.pathname.slice(1));
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !/^[a-z0-9_]+_performance_test$/.test(name)) throw new Error();
    return name;
  } catch {
    throw new Error("PERFORMANCE_DATABASE_UNSAFE");
  }
}

export type ExplainNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Filter?: string;
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: ExplainNode[];
};

export type ExplainDocument = { Plan: ExplainNode; "Execution Time"?: number; "Planning Time"?: number };

export function summarizePlan(document: ExplainDocument) {
  const indexes = new Set<string>();
  const sequentialScans: Array<{ relation: string; rows: number; removed: number; ownerBounded: boolean }> = [];
  const visit = (node: ExplainNode) => {
    if (node["Index Name"]) indexes.add(node["Index Name"]);
    if (node["Node Type"].includes("Seq Scan")) {
      const relation = node["Relation Name"] ?? "unknown";
      const ownerBounded = /\bowner_id\s*=/.test(node.Filter ?? "");
      if (["patterns", "authorizations"].includes(relation) && !ownerBounded) {
        throw new Error(`UNBOUNDED_SEQUENTIAL_SCAN:${relation}`);
      }
      sequentialScans.push({ relation, rows: node["Actual Rows"] ?? 0, removed: node["Rows Removed by Filter"] ?? 0, ownerBounded });
    }
    node.Plans?.forEach(visit);
  };
  visit(document.Plan);
  return {
    executionMs: document["Execution Time"] ?? 0,
    planningMs: document["Planning Time"] ?? 0,
    sharedHitBlocks: document.Plan["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: document.Plan["Shared Read Blocks"] ?? 0,
    indexes: [...indexes],
    sequentialScans,
  };
}

export function assertDashboardPlan(document: ExplainDocument, policy: { range: string; metric: string; fieldId?: string }) {
  const summary = summarizePlan(document);
  // The one-owner dataset makes full-range/current-state scans cheaper than
  // indexes. Those two cases may scan owner-filtered rows; selective period
  // queries must retain the intended date/field index. Pattern joins may scan
  // the owner's 10k rows, but never an unbounded patterns table.
  if (policy.range !== "all_time" && policy.metric !== "current_state") {
    const expected = policy.fieldId
      ? "authorizations_owner_field_status_date_idx"
      : "authorizations_owner_status_date_idx";
    if (!summary.indexes.includes(expected)) throw new Error(`EXPECTED_AUTHORIZATION_INDEX_MISSING:${expected}`);
    if (summary.sequentialScans.some((scan) => scan.relation === "authorizations")) throw new Error("UNEXPECTED_SELECTIVE_AUTHORIZATION_SCAN");
  }
  return summary;
}
