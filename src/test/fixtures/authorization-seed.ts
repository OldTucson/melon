import { createHash } from "node:crypto";

import postgres from "postgres";

export const HOMEWEAR_FIELD_ID = "00000000-0000-4000-8000-000000000001";
export const STATIONERY_FIELD_ID = "00000000-0000-4000-8000-000000000008";

export function fixtureId(key: string) {
  const hex = createHash("sha256").update(`commercial-e2e:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function withAuthorizationFixtureDatabase<T>(databaseUrl: string, ownerId: string, work: (client: postgres.Sql) => Promise<T>) {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!/^[a-z0-9_]+_e2e$/.test(name)) throw new Error("E2E_DATABASE_NAME_UNSAFE");
  if (!["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"].includes(ownerId)) throw new Error("E2E_OWNER_ID_UNSAFE");
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await client`select count(*)::int as count from assets`;
    if (row?.count !== 0) throw new Error("E2E_METADATA_ASSETS_PRESENT");
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function seedCommercialPattern(databaseUrl: string, ownerId: string, key: string) {
  const id = fixtureId(key);
  const name = `商业验证 ${key}`;
  await withAuthorizationFixtureDatabase(databaseUrl, ownerId, async (client) => {
    await client`delete from authorizations where owner_id = ${ownerId} and pattern_id = ${id}`;
    await client`delete from patterns where owner_id = ${ownerId} and id = ${id}`;
    await client`insert into patterns (id, owner_id, name, original_filename, extension, detected_mime_type, size_bytes, status, preview_status)
      values (${id}, ${ownerId}, ${name}, 'metadata-only.png', 'png', 'image/png', 0, 'ready', 'unsupported')`;
  });
  return { id, name };
}

// Dates are anchored to the server's current Shanghai calendar date; amounts
// stay constant across years. No time overrides are added to production APIs.
export async function seedDashboard(databaseUrl: string, ownerId: string, today: string) {
  const year = Number(today.slice(0, 4));
  const current = `${year}-01-01`;
  const prior = `${year - 1}-12-31`;
  const old = `${year - 2}-01-01`;
  const patterns = ["普通图案", "独占图案", "买断图案", "回收站图案", "未授权图案", "历史图案", "已删除图案"].map((name) => ({ id: fixtureId(`dashboard:${name}`), name }));
  await withAuthorizationFixtureDatabase(databaseUrl, ownerId, async (client) => {
    const ids = patterns.map((pattern) => pattern.id);
    await client`delete from authorizations where owner_id = ${ownerId} and pattern_id in ${client(ids)}`;
    await client`delete from patterns where owner_id = ${ownerId} and id in ${client(ids)}`;
    for (const [index, pattern] of patterns.entries()) {
      const status = index === 3 ? "trashed" : index === 6 ? "deleted" : "ready";
      await client`insert into patterns (id, owner_id, name, original_filename, extension, size_bytes, status, preview_status, pre_trash_status, trashed_at, trash_batch_id, deleted_at)
        values (${pattern.id}, ${ownerId}, ${pattern.name}, 'metadata-only.png', 'png', 0,
          ${status}, 'unsupported', ${status === "trashed" ? "ready" : null},
          ${status === "trashed" ? `${today}T00:00:00Z` : null},
          ${status === "trashed" ? fixtureId("dashboard:trash") : null},
          ${status === "deleted" ? `${today}T00:00:00Z` : null})`;
    }
    const rows = [
      { p: 0, price: 100000, date: current, kind: "standard", field: HOMEWEAR_FIELD_ID, name: "家居服" },
      { p: 1, price: 500000, date: current, kind: "field_exclusive", field: HOMEWEAR_FIELD_ID, name: "家居服" },
      { p: 2, price: 1000000, date: today, kind: "global_buyout", field: null, name: null },
      { p: 3, price: 280000, date: today, kind: "standard", field: STATIONERY_FIELD_ID, name: "文具纸品" },
      { p: 0, price: 70000, date: prior, kind: "standard", field: HOMEWEAR_FIELD_ID, name: "家居服" },
      { p: 5, price: 30000, date: old, kind: "standard", field: STATIONERY_FIELD_ID, name: "文具纸品" },
      { p: 0, price: 9999900, date: today, kind: "standard", field: HOMEWEAR_FIELD_ID, name: "家居服", status: "void" },
    ];
    for (const [index, row] of rows.entries()) {
      await client`insert into authorizations (id, owner_id, pattern_id, operation_id, kind, field_id, field_name_snapshot, licensee_name, price_fen, authorized_on, status)
        values (${fixtureId(`dashboard:authorization:${index}`)}, ${ownerId}, ${patterns[row.p]!.id}, ${fixtureId(`dashboard:operation:${index}`)},
        ${row.kind}, ${row.field}, ${row.name}, '确定性客户', ${row.price}, ${row.date}, ${row.status ?? "active"})`;
    }
  });
  return { patterns, current, prior, old, today };
}
