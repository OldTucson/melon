import "server-only";

import { eq, sql } from "drizzle-orm";

import type { DbTransaction } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

export async function nextChangeSeq(
  tx: DbTransaction,
  ownerId: string,
): Promise<bigint> {
  const [row] = await tx
    .update(users)
    .set({ syncSeq: sql`${users.syncSeq} + 1` })
    .where(eq(users.id, ownerId))
    .returning({ syncSeq: users.syncSeq });

  if (!row) throw new Error("OWNER_NOT_FOUND");

  return row.syncSeq;
}
