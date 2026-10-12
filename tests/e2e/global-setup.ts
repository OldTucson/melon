import path from "node:path";

import { config as loadDotEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import OSS from "ali-oss";
import postgres from "postgres";

import {
  createAlibabaCredential,
} from "../../src/features/storage/alibaba-credential";
import { hashPassword } from "../../src/features/auth/password";
import {
  E2E_DATABASE_URL,
  E2E_PASSWORD,
  E2E_USERS,
} from "./environment";

type AssetKeyRow = { object_key: string };

function e2eDatabaseName() {
  const name = decodeURIComponent(new URL(E2E_DATABASE_URL).pathname.slice(1));
  if (!/^[a-z0-9_]+_e2e$/.test(name)) {
    throw new Error("E2E_DATABASE_NAME_UNSAFE");
  }
  return name;
}

async function ensureDatabaseExists() {
  const databaseName = e2eDatabaseName();
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

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`E2E_ENV_MISSING:${name}`);
  return value;
}

async function cleanupOssObjects(objectKeys: string[]) {
  const keys = [...new Set(objectKeys)];
  if (keys.length === 0) return;

  const credential = createAlibabaCredential();
  const resolved = await credential.getCredential();
  if (
    typeof resolved.accessKeyId !== "string" ||
    typeof resolved.accessKeySecret !== "string"
  ) {
    throw new Error("E2E_OSS_CREDENTIALS_INVALID");
  }

  const endpoint = requiredEnv("ALIYUN_OSS_ENDPOINT");
  const client = new OSS({
    accessKeyId: resolved.accessKeyId,
    accessKeySecret: resolved.accessKeySecret,
    ...(typeof resolved.securityToken === "string"
      ? { stsToken: resolved.securityToken }
      : {}),
    region: requiredEnv("ALIYUN_OSS_REGION"),
    bucket: requiredEnv("ALIYUN_OSS_BUCKET"),
    endpoint,
    cname: process.env.ALIYUN_OSS_CNAME === "true",
    secure: new URL(endpoint).protocol === "https:",
    authorizationV4: true,
  });

  for (let start = 0; start < keys.length; start += 1000) {
    await client.deleteMulti(keys.slice(start, start + 1000), { quiet: true });
  }
}

async function assetKeys(client: postgres.Sql) {
  const rows = await client<AssetKeyRow[]>`
    select object_key from assets order by object_key
  `;
  return rows.map((row) => row.object_key);
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

export async function resetAndSeed() {
  await ensureDatabaseExists();
  const client = postgres(E2E_DATABASE_URL, { max: 1 });

  try {
    const database = drizzle(client);
    await migrate(database, {
      migrationsFolder: path.join(process.cwd(), "drizzle"),
    });
    await cleanupOssObjects(await assetKeys(client));
    await truncateE2eData(client);
    await seedUsers(client);
  } finally {
    await client.end();
  }
}

async function cleanup() {
  const client = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    await cleanupOssObjects(await assetKeys(client));
    await truncateE2eData(client);
  } finally {
    await client.end();
  }
}

export default async function globalSetup() {
  loadDotEnv({ path: path.join(process.cwd(), ".env.local") });
  return cleanup;
}
