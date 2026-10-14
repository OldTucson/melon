import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { resetDatabase } from "@/test/database";

import { dashboardQuerySchema } from "./contracts";
import { getAuthorizationDashboard } from "./dashboard-service";

const HOMEWEAR_FIELD_ID = "00000000-0000-4000-8000-000000000001";
const STATIONERY_FIELD_ID = "00000000-0000-4000-8000-000000000008";
const today = "2026-10-08";

describe("authorization dashboard service", () => {
  let ownerId: string;
  let otherOwnerId: string;
  let ids: Record<
    "standard" | "exclusive" | "buyout" | "trash" | "unlicensed" | "historical" | "deleted",
    string
  >;

  const insertPattern = async (
    id: string,
    name: string,
    status: "ready" | "trashed" | "deleted" = "ready",
    targetOwnerId = ownerId,
  ) => {
    await db.execute(sql`
      insert into patterns (
        id, owner_id, name, original_filename, extension, size_bytes,
        status, pre_trash_status, trashed_at, deleted_at
      ) values (
        ${id}, ${targetOwnerId}, ${name}, ${`${name}.png`}, 'png', 1024,
        ${status}::pattern_status,
        ${status === "trashed" ? "ready" : null}::pattern_status,
        ${status === "trashed" ? "2026-10-01T00:00:00.000Z" : null},
        ${status === "deleted" ? "2026-10-02T00:00:00.000Z" : null}
      )
    `);
  };

  const insertAuthorization = async (input: {
    patternId: string;
    kind: "standard" | "field_exclusive" | "global_buyout";
    fieldId: string | null;
    fieldName: string | null;
    priceFen: bigint;
    authorizedOn: string;
    status?: "active" | "void";
    targetOwnerId?: string;
  }) => {
    await db.execute(sql`
      insert into authorizations (
        id, owner_id, pattern_id, operation_id, kind, field_id,
        field_name_snapshot, licensee_name, price_fen, authorized_on,
        status, voided_at
      ) values (
        ${randomUUID()}, ${input.targetOwnerId ?? ownerId}, ${input.patternId},
        ${randomUUID()}, ${input.kind}::authorization_kind, ${input.fieldId},
        ${input.fieldName}, '客户', ${input.priceFen}, ${input.authorizedOn}::date,
        ${input.status ?? "active"}::authorization_status,
        ${input.status === "void" ? "2026-04-01T00:00:00.000Z" : null}
      )
    `);
  };

  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    ids = {
      standard: randomUUID(),
      exclusive: randomUUID(),
      buyout: randomUUID(),
      trash: randomUUID(),
      unlicensed: randomUUID(),
      historical: randomUUID(),
      deleted: randomUUID(),
    };

    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values
        (${ownerId}, 'dashboard@example.test', 'Dashboard', 'hash'),
        (${otherOwnerId}, 'dashboard-other@example.test', 'Other', 'hash')
    `);
    await insertPattern(ids.standard, "Alpha");
    await insertPattern(ids.exclusive, "Beta");
    await insertPattern(ids.buyout, "Gamma");
    await insertPattern(ids.trash, "Delta", "trashed");
    await insertPattern(ids.unlicensed, "Epsilon");
    await insertPattern(ids.historical, "Zeta");
    await insertPattern(ids.deleted, "Deleted", "deleted");

    await insertAuthorization({
      patternId: ids.standard,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      fieldName: "家居服",
      priceFen: 10_000n,
      authorizedOn: "2026-01-10",
    });
    await insertAuthorization({
      patternId: ids.standard,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      fieldName: "家居服",
      priceFen: 0n,
      authorizedOn: "2026-02-01",
    });
    await insertAuthorization({
      patternId: ids.standard,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      fieldName: "家居服",
      priceFen: 999_000n,
      authorizedOn: "2026-03-01",
      status: "void",
    });
    await insertAuthorization({
      patternId: ids.exclusive,
      kind: "field_exclusive",
      fieldId: STATIONERY_FIELD_ID,
      fieldName: "文具纸品",
      priceFen: 30_000n,
      authorizedOn: "2026-03-15",
    });
    await insertAuthorization({
      patternId: ids.buyout,
      kind: "global_buyout",
      fieldId: null,
      fieldName: null,
      priceFen: 70_000n,
      authorizedOn: "2026-07-20",
    });
    await insertAuthorization({
      patternId: ids.trash,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      fieldName: "家居服",
      priceFen: 50_000n,
      authorizedOn: "2026-09-01",
    });
    await insertAuthorization({
      patternId: ids.historical,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      fieldName: "家居服",
      priceFen: 80_000n,
      authorizedOn: "2025-02-01",
    });
    await insertAuthorization({
      patternId: ids.deleted,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      fieldName: "家居服",
      priceFen: 900_000n,
      authorizedOn: "2026-05-01",
    });

    const otherPatternId = randomUUID();
    await insertPattern(otherPatternId, "Other", "ready", otherOwnerId);
    await insertAuthorization({
      patternId: otherPatternId,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      fieldName: "家居服",
      priceFen: 800_000n,
      authorizedOn: "2026-06-01",
      targetOwnerId: otherOwnerId,
    });

    await db.execute(sql`
      update authorization_fields
      set status = 'archived', archived_at = now()
      where id = ${HOMEWEAR_FIELD_ID}
    `);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("aggregates effective period revenue, comparison, rankings, and current states", async () => {
    const result = await getAuthorizationDashboard({
      ownerId,
      query: dashboardQuerySchema.parse({ range: "current_year" }),
      today,
    });

    expect(result.range).toEqual({
      start: "2026-01-01",
      end: today,
      comparison: { start: "2025-01-01", end: "2025-10-08" },
    });
    expect(result.metrics).toEqual({
      revenueFen: "160000",
      count: 5,
      patternCount: 4,
      averageFen: "32000",
      comparisonPercent: "100.00",
    });
    expect(result.trend).toEqual([
      { bucket: "2026-01-01", revenueFen: "10000", count: 1 },
      { bucket: "2026-02-01", revenueFen: "0", count: 1 },
      { bucket: "2026-03-01", revenueFen: "30000", count: 1 },
      { bucket: "2026-07-01", revenueFen: "70000", count: 1 },
      { bucket: "2026-09-01", revenueFen: "50000", count: 1 },
    ]);
    expect(result.currentStates).toEqual([
      { state: "unlicensed", patternCount: 1 },
      { state: "standard", patternCount: 2 },
      { state: "field_exclusive", patternCount: 1 },
      { state: "global_buyout", patternCount: 1 },
    ]);
    expect(result.fields).toEqual([
      {
        fieldId: HOMEWEAR_FIELD_ID,
        fieldName: "家居服",
        count: 3,
        revenueFen: "60000",
      },
      {
        fieldId: STATIONERY_FIELD_ID,
        fieldName: "文具纸品",
        count: 1,
        revenueFen: "30000",
      },
    ]);
    expect(result.topPatterns).toEqual([
      {
        patternId: ids.buyout,
        patternName: "Gamma",
        lifecycle: "library",
        count: 1,
        revenueFen: "70000",
      },
      {
        patternId: ids.trash,
        patternName: "Delta",
        lifecycle: "trash",
        count: 1,
        revenueFen: "50000",
      },
      {
        patternId: ids.exclusive,
        patternName: "Beta",
        lifecycle: "library",
        count: 1,
        revenueFen: "30000",
      },
      {
        patternId: ids.standard,
        patternName: "Alpha",
        lifecycle: "library",
        count: 2,
        revenueFen: "10000",
      },
    ]);
  });

  it("applies custom date, kind, and field filters without changing current states", async () => {
    const result = await getAuthorizationDashboard({
      ownerId,
      query: dashboardQuerySchema.parse({
        range: "custom",
        start: "2026-01-01",
        end: "2026-06-30",
        kind: "standard",
        fieldId: HOMEWEAR_FIELD_ID,
      }),
      today,
    });

    expect(result.metrics).toEqual({
      revenueFen: "10000",
      count: 2,
      patternCount: 1,
      averageFen: "5000",
      comparisonPercent: null,
    });
    expect(result.trend).toEqual([
      { bucket: "2026-01-01", revenueFen: "10000", count: 1 },
      { bucket: "2026-02-01", revenueFen: "0", count: 1 },
    ]);
    expect(result.fields).toEqual([
      {
        fieldId: HOMEWEAR_FIELD_ID,
        fieldName: "家居服",
        count: 2,
        revenueFen: "10000",
      },
    ]);
    expect(result.topPatterns).toEqual([
      {
        patternId: ids.standard,
        patternName: "Alpha",
        lifecycle: "library",
        count: 2,
        revenueFen: "10000",
      },
    ]);
    expect(result.currentStates).toEqual([
      { state: "unlicensed", patternCount: 1 },
      { state: "standard", patternCount: 2 },
      { state: "field_exclusive", patternCount: 1 },
      { state: "global_buyout", patternCount: 1 },
    ]);
  });

  it("returns all-time values with no comparison and no bigint JSON values", async () => {
    const result = await getAuthorizationDashboard({
      ownerId,
      query: dashboardQuerySchema.parse({ range: "all_time" }),
      today,
    });

    expect(result.range).toEqual({ start: null, end: today, comparison: null });
    expect(result.metrics).toEqual({
      revenueFen: "240000",
      count: 6,
      patternCount: 5,
      averageFen: "40000",
      comparisonPercent: null,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.stringify(result)).not.toContain("900000");
  });
});
