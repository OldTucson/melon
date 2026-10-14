import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { SYSTEM_AUTHORIZATION_FIELD_SEED } from "../src/features/authorizations/system-fields";
import { assertDashboardPlan, assertPerformanceDatabaseUrl, type ExplainDocument } from "./performance-guards";

// Never load .env.local or fall back to DATABASE_URL. This owner is reserved for
// synthetic data and is the only owner this script is allowed to delete/reseed.
const ownerId = "eeeeeeee-0000-4000-8000-000000000001";
const ownerEmail = "performance-fixture@melon.invalid";

async function main() {
  const databaseUrl = process.env.PERFORMANCE_DATABASE_URL;
  const databaseName = assertPerformanceDatabaseUrl(databaseUrl);
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const [row] = await admin`select 1 from pg_database where datname = ${databaseName}`;
    if (!row) await admin.unsafe(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const client = postgres(databaseUrl!, { max: 1 });
  const started = performance.now();
  try {
    await migrate(drizzle(client), { migrationsFolder: path.join(process.cwd(), "drizzle") });
    await client.begin(async (tx) => {
      const [existing] = await tx`select email from users where id = ${ownerId} for update`;
      if (existing && existing.email !== ownerEmail) throw new Error("PERFORMANCE_OWNER_COLLISION");
      const [resources] = await tx`
        select (select count(*) from assets where owner_id = ${ownerId})
          + (select count(*) from upload_sessions where owner_id = ${ownerId})
          + (select count(*) from folders where owner_id = ${ownerId})
          + (select count(*) from pattern_tags where owner_id = ${ownerId}) as count
      `;
      if (Number(resources!.count) !== 0) throw new Error("PERFORMANCE_OWNER_HAS_NON_FIXTURE_DATA");
      await tx`insert into users (id, email, display_name, password_hash)
        values (${ownerId}, ${ownerEmail}, 'Performance fixture (no login)', 'no-login')
        on conflict (id) do nothing`;
      await tx`delete from authorizations where owner_id = ${ownerId}`;
      await tx`delete from patterns where owner_id = ${ownerId}`;
      for (const field of SYSTEM_AUTHORIZATION_FIELD_SEED) {
        await tx`insert into authorization_fields (id, scope, name, normalized_name)
          values (${field.id}, 'system', ${field.name}, ${field.normalizedName}) on conflict do nothing`;
      }
      await tx`
        insert into patterns (id, owner_id, name, original_filename, extension, size_bytes, status, preview_status)
        select md5('performance:pattern:' || i)::uuid, ${ownerId}::uuid,
          'Performance ' || lpad(i::text, 5, '0'), 'fixture.png', 'png', 0, 'ready', 'unsupported'
        from generate_series(1, 10000) i
      `;
      await tx`
        insert into authorizations (id, owner_id, pattern_id, operation_id, kind,
          field_id, field_name_snapshot, licensee_name, price_fen, authorized_on, status)
        select md5('performance:authorization:' || i)::uuid, ${ownerId}::uuid,
          md5('performance:pattern:' || ((i - 1) % 10000 + 1))::uuid,
          md5('performance:operation:' || i)::uuid, 'standard',
          f.id, f.name, 'Synthetic customer', (i % 10000 + 1)::bigint * 100,
          date '2016-10-09' + ((i * 37) % 3652),
          (case when i % 10 = 0 then 'void' else 'active' end)::authorization_status
        from generate_series(1, 100000) i
        join authorization_fields f on f.id =
          ('00000000-0000-4000-8000-' || lpad(((i - 1) % 12 + 1)::text, 12, '0'))::uuid
      `;
    });
    await client`analyze patterns`;
    await client`analyze authorizations`;
    const [counts] = await client`select
      (select count(*)::int from patterns where owner_id = ${ownerId}) as patterns,
      (select count(*)::int from authorizations where owner_id = ${ownerId}) as authorizations`;
    if (counts?.patterns !== 10000 || counts.authorizations !== 100000) throw new Error("PERFORMANCE_SEED_COUNT_MISMATCH");
    console.log(JSON.stringify({ databaseName, ownerId, ...counts, seedMs: Math.round(performance.now() - started) }));

    // Capture the real repository SQL, including its bound values. No copied
    // benchmark queries and no enable_seqscan overrides can hide regressions.
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      AUTH_SECRET: "performance-only-secret-at-least-32-characters",
      APP_ORIGIN: "http://localhost:3000",
      ALIYUN_OSS_REGION: "oss-cn-hangzhou",
      ALIYUN_OSS_BUCKET: "performance-no-assets",
      ALIYUN_OSS_ENDPOINT: "https://assets.example.test",
      ALIYUN_OSS_CNAME: "true",
      ALIYUN_STS_ROLE_ARN: "acs:ram::123456789012:role/test-only",
    });
    const { db, closeDatabase } = await import("../src/lib/db/client");
    try {
      // Resolve postgres.js type metadata before recording application queries.
      await db.$client`select 1`;
      const { getAuthorizationDashboard } = await import("../src/features/analytics/dashboard-service");
      for (const query of [
        { range: "current_year" as const },
        { range: "current_year" as const, fieldId: SYSTEM_AUTHORIZATION_FIELD_SEED[0]!.id },
        { range: "current_year" as const, kind: "standard" as const },
        { range: "all_time" as const },
      ]) {
        const captured: Array<{ query: string; parameters: postgres.ParameterOrJSON<never>[] }> = [];
        db.$client.options.debug = (_connection, sql, parameters) => {
          if (/^\s*(select|with)\b/i.test(sql)) captured.push({ query: sql, parameters });
        };
        await getAuthorizationDashboard({ ownerId, today: "2026-10-08", query });
        db.$client.options.debug = false;
        const names = query.range === "all_time"
          ? ["period", "trend", "current_state", "field_ranking", "top_patterns"]
          : ["period", "comparison", "trend", "current_state", "field_ranking", "top_patterns"];
        if (captured.length !== names.length) throw new Error(`PERFORMANCE_QUERY_CAPTURE_MISMATCH:${captured.length}/${names.length}`);
        for (const [index, statement] of captured.entries()) {
          const [row] = await client.unsafe(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`,
            statement.parameters,
          );
          const plan = row!["QUERY PLAN"][0] as ExplainDocument;
          console.log(JSON.stringify({ query, metric: names[index], ...assertDashboardPlan(plan, { ...query, metric: names[index]! }) }));
        }
      }
    } finally {
      await closeDatabase();
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Performance verification failed");
  process.exitCode = 1;
});
