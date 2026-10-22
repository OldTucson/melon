import path from "node:path";

import { config as loadDotEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { hashPassword } from "../../src/features/auth/password";
import { SYSTEM_AUTHORIZATION_FIELD_SEED } from "../../src/features/authorizations/system-fields";
import {
  E2E_DATABASE_URL,
  E2E_IMAGE_SEARCH,
  E2E_PASSWORD,
  E2E_USERS,
  E2E_METADATA_ONLY,
  assertMetadataOnlyRows,
  e2eDatabaseName,
} from "./environment";
import { assertImageSearchFixtureRows } from "./image-search-fixtures";
import { createE2eOssClient } from "./oss-client";
import {
  assertE2eAssetRows,
  type E2eAssetRow,
  listE2eOssObjectKeys,
} from "./oss-safety";

async function ensureDatabaseExists() {
  const databaseName = e2eDatabaseName(E2E_DATABASE_URL);
  const adminUrl = new URL(E2E_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });

  try {
    const rows = await admin<{ exists: boolean }[]>`
      select exists(
        select 1 from pg_database where datname = ${databaseName}
      ) as exists
    `;
    if (!rows[0]?.exists) {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await admin.end();
  }
}

async function cleanupOssObjects(rows: E2eAssetRow[]) {
  if (E2E_METADATA_ONLY) {
    if (E2E_IMAGE_SEARCH) {
      assertImageSearchFixtureRows(rows);
    } else {
      assertMetadataOnlyRows(rows);
    }
    return;
  }
  assertE2eAssetRows(rows);
  const client = await createE2eOssClient();
  const keys = await listE2eOssObjectKeys(client);

  for (let start = 0; start < keys.length; start += 1000) {
    await client.deleteMulti(keys.slice(start, start + 1000), { quiet: true });
  }
}

async function assetRows(client: postgres.Sql) {
  return client<E2eAssetRow[]>`
    select
      id as "assetId",
      owner_id as "ownerId",
      pattern_id as "patternId",
      role::text,
      object_key as "objectKey"
    from assets
    order by object_key
  `;
}

async function assertMetadataOnlyDatabase(client: postgres.Sql) {
  if (!E2E_METADATA_ONLY) return;
  const uploads = await client`select source_object_key from upload_sessions`;
  const rows = await assetRows(client);
  if (E2E_IMAGE_SEARCH) {
    assertImageSearchFixtureRows(rows, uploads);
  } else {
    assertMetadataOnlyRows(rows, uploads);
  }
}

async function truncateE2eData(client: postgres.Sql) {
  await client.unsafe(`
    TRUNCATE TABLE
      "change_log",
      "operations",
      "upload_sessions",
      "pattern_tags",
      "assets",
      "tags",
      "patterns",
      "users"
    RESTART IDENTITY CASCADE
  `);
}

async function seedUsers(client: postgres.Sql) {
  const passwordHash = await hashPassword(E2E_PASSWORD);
  for (const user of Object.values(E2E_USERS)) {
    await client`
      insert into users (
        id,
        email,
        display_name,
        password_hash,
        must_change_password
      ) values (
        ${user.id},
        ${user.email},
        ${user.displayName},
        ${passwordHash},
        false
      )
    `;
  }
}

async function seedSystemAuthorizationFields(client: postgres.Sql) {
  for (const field of SYSTEM_AUTHORIZATION_FIELD_SEED) {
    await client`
      insert into authorization_fields (
        id, owner_id, scope, name, normalized_name, status
      ) values (
        ${field.id}, null, ${field.scope}, ${field.name},
        ${field.normalizedName}, ${field.status}
      )
      on conflict do nothing
    `;
  }
}

export async function resetAndSeed() {
  await ensureDatabaseExists();
  const client = postgres(E2E_DATABASE_URL, { max: 1 });

  try {
    const database = drizzle(client);
    await migrate(database, {
      migrationsFolder: path.join(process.cwd(), "drizzle"),
    });
    await assertMetadataOnlyDatabase(client);
    await cleanupOssObjects(await assetRows(client));
    await truncateE2eData(client);
    await seedUsers(client);
    await seedSystemAuthorizationFields(client);
    await assertMetadataOnlyDatabase(client);
  } finally {
    await client.end();
  }
}

export async function cleanupE2eResources(
  databaseUrl: string = E2E_DATABASE_URL,
) {
  e2eDatabaseName(databaseUrl);
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await assertMetadataOnlyDatabase(client);
    await cleanupOssObjects(await assetRows(client));
    await truncateE2eData(client);
    await assertMetadataOnlyDatabase(client);
  } finally {
    await client.end();
  }
}

export default async function globalSetup() {
  loadDotEnv({ path: path.join(process.cwd(), ".env.local") });
  return () => cleanupE2eResources();
}
