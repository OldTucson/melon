import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServerEnv } from "@/lib/env/server";

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
          "change_log",
          "operations",
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
  } finally {
    await queryClient.end();
  }
};
