import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { SYSTEM_AUTHORIZATION_FIELD_SEED } from "@/features/authorizations/system-fields";
import { getServerEnv } from "@/lib/env/server";
import { authorizationFields } from "@/lib/db/schema/authorizations";

export const assertTestDatabaseUrl = (databaseUrl: string) => {
  const { pathname } = new URL(databaseUrl);

  if (!pathname.endsWith("_test")) {
    throw new Error(
      `Refusing to reset database because its pathname does not end in _test: ${pathname}`,
    );
  }
};

export const resetDatabase = async (
  databaseUrl = getServerEnv().DATABASE_URL,
) => {
  assertTestDatabaseUrl(databaseUrl);

  const queryClient = postgres(databaseUrl, { max: 1 });

  try {
    const database = drizzle(queryClient);
    await database.execute(
      sql.raw(`
        TRUNCATE TABLE
          "visual_search_embeddings",
          "visual_search_documents",
          "visual_search_jobs",
          "visual_search_workers",
          "change_log",
          "operations",
          "authorizations",
          "authorization_fields",
          "upload_sessions",
          "pattern_tags",
          "assets",
          "tags",
          "patterns",
          "folders",
          "users"
        RESTART IDENTITY CASCADE
      `),
    );
    await database
      .insert(authorizationFields)
      .values(SYSTEM_AUTHORIZATION_FIELD_SEED)
      .onConflictDoNothing();
  } finally {
    await queryClient.end();
  }
};
