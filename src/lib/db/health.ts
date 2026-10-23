import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";

export async function checkDatabaseReadiness(): Promise<void> {
  await db.execute(sql`select 1`);
}
