import "server-only";

import { and, asc, eq, or, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/lib/db/client";
import { authorizationFields } from "@/lib/db/schema";

export type AuthorizationFieldRow = typeof authorizationFields.$inferSelect;

const visibleToOwner = (ownerId: string) =>
  or(
    eq(authorizationFields.scope, "system"),
    and(
      eq(authorizationFields.scope, "custom"),
      eq(authorizationFields.ownerId, ownerId),
    ),
  )!;

export function listAuthorizationFieldRows(
  ownerId: string,
  options: { includeArchived?: boolean } = {},
) {
  return db
    .select()
    .from(authorizationFields)
    .where(
      and(
        visibleToOwner(ownerId),
        options.includeArchived
          ? undefined
          : eq(authorizationFields.status, "active"),
      ),
    )
    .orderBy(
      sql`case when ${authorizationFields.scope} = 'system' then 0 else 1 end`,
      asc(authorizationFields.id),
      asc(authorizationFields.normalizedName),
    );
}

export async function findAuthorizationFieldByNormalizedName(
  ownerId: string,
  tx: DbTransaction,
  normalizedName: string,
) {
  const [row] = await tx
    .select()
    .from(authorizationFields)
    .where(
      and(
        eq(authorizationFields.normalizedName, normalizedName),
        visibleToOwner(ownerId),
      ),
    )
    .limit(1);
  return row;
}

export async function insertAuthorizationFieldRow(
  ownerId: string,
  tx: DbTransaction,
  input: {
    id: string;
    name: string;
    normalizedName: string;
    now: Date;
  },
) {
  const [row] = await tx
    .insert(authorizationFields)
    .values({
      id: input.id,
      ownerId,
      scope: "custom",
      name: input.name,
      normalizedName: input.normalizedName,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return row;
}

export async function lockOwnedCustomAuthorizationField(
  ownerId: string,
  tx: DbTransaction,
  fieldId: string,
) {
  const [row] = await tx
    .select()
    .from(authorizationFields)
    .where(
      and(
        eq(authorizationFields.ownerId, ownerId),
        eq(authorizationFields.id, fieldId),
        eq(authorizationFields.scope, "custom"),
      ),
    )
    .limit(1)
    .for("update");
  return row;
}

export async function archiveAuthorizationFieldRow(
  ownerId: string,
  tx: DbTransaction,
  input: { fieldId: string; now: Date },
) {
  const [row] = await tx
    .update(authorizationFields)
    .set({
      status: "archived",
      archivedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(authorizationFields.ownerId, ownerId),
        eq(authorizationFields.id, input.fieldId),
        eq(authorizationFields.scope, "custom"),
        eq(authorizationFields.status, "active"),
      ),
    )
    .returning();
  return row;
}

