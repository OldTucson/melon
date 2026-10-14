import "server-only";

import { and, desc, eq, lt, ne, or, sql, type SQL } from "drizzle-orm";

import { db, type DbTransaction } from "@/lib/db/client";
import {
  authorizationFields,
  authorizations,
  patterns,
} from "@/lib/db/schema";

export type AuthorizationRow = typeof authorizations.$inferSelect;
export type CommercialPatternRow = typeof patterns.$inferSelect;

export async function getAuthorizationReference(
  ownerId: string,
  tx: DbTransaction,
  authorizationId: string,
) {
  const [row] = await tx
    .select({
      id: authorizations.id,
      patternId: authorizations.patternId,
    })
    .from(authorizations)
    .where(
      and(
        eq(authorizations.ownerId, ownerId),
        eq(authorizations.id, authorizationId),
      ),
    )
    .limit(1);
  return row;
}

export async function lockCommercialPattern(
  ownerId: string,
  tx: DbTransaction,
  patternId: string,
) {
  const [row] = await tx
    .select()
    .from(patterns)
    .where(and(eq(patterns.ownerId, ownerId), eq(patterns.id, patternId)))
    .limit(1)
    .for("update");
  return row;
}

export async function lockAuthorizationRow(
  ownerId: string,
  tx: DbTransaction,
  authorizationId: string,
) {
  const [row] = await tx
    .select()
    .from(authorizations)
    .where(
      and(
        eq(authorizations.ownerId, ownerId),
        eq(authorizations.id, authorizationId),
      ),
    )
    .limit(1)
    .for("update");
  return row;
}

export function listActiveAuthorizationRows(
  ownerId: string,
  tx: DbTransaction,
  patternId: string,
) {
  return tx
    .select()
    .from(authorizations)
    .where(
      and(
        eq(authorizations.ownerId, ownerId),
        eq(authorizations.patternId, patternId),
        eq(authorizations.status, "active"),
      ),
    )
    .orderBy(
      desc(authorizations.authorizedOn),
      desc(authorizations.createdAt),
      desc(authorizations.id),
    );
}

export async function getVisibleAuthorizationFieldRow(
  ownerId: string,
  tx: DbTransaction,
  fieldId: string,
) {
  const [row] = await tx
    .select()
    .from(authorizationFields)
    .where(
      and(
        eq(authorizationFields.id, fieldId),
        or(
          eq(authorizationFields.scope, "system"),
          and(
            eq(authorizationFields.scope, "custom"),
            eq(authorizationFields.ownerId, ownerId),
          ),
        ),
      ),
    )
    .limit(1);
  return row;
}

export async function insertAuthorizationRow(
  ownerId: string,
  tx: DbTransaction,
  input: {
    id: string;
    patternId: string;
    operationId: string;
    kind: AuthorizationRow["kind"];
    fieldId: string | null;
    fieldNameSnapshot: string | null;
    licenseeName: string;
    priceFen: bigint;
    authorizedOn: string;
    note: string | null;
    now: Date;
  },
) {
  const [row] = await tx
    .insert(authorizations)
    .values({
      id: input.id,
      ownerId,
      patternId: input.patternId,
      operationId: input.operationId,
      kind: input.kind,
      fieldId: input.fieldId,
      fieldNameSnapshot: input.fieldNameSnapshot,
      licenseeName: input.licenseeName,
      priceFen: input.priceFen,
      authorizedOn: input.authorizedOn,
      note: input.note,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return row;
}

export async function editAuthorizationRow(
  ownerId: string,
  tx: DbTransaction,
  input: {
    authorizationId: string;
    version: number;
    kind: AuthorizationRow["kind"];
    fieldId: string | null;
    fieldNameSnapshot: string | null;
    licenseeName: string;
    priceFen: bigint;
    authorizedOn: string;
    note: string | null;
    now: Date;
  },
) {
  const [row] = await tx
    .update(authorizations)
    .set({
      kind: input.kind,
      fieldId: input.fieldId,
      fieldNameSnapshot: input.fieldNameSnapshot,
      licenseeName: input.licenseeName,
      priceFen: input.priceFen,
      authorizedOn: input.authorizedOn,
      note: input.note,
      version: sql`${authorizations.version} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(authorizations.ownerId, ownerId),
        eq(authorizations.id, input.authorizationId),
        eq(authorizations.version, input.version),
        eq(authorizations.status, "active"),
      ),
    )
    .returning();
  return row;
}

export async function setAuthorizationStatus(
  ownerId: string,
  tx: DbTransaction,
  input: {
    authorizationId: string;
    version: number;
    from: AuthorizationRow["status"];
    to: AuthorizationRow["status"];
    now: Date;
  },
) {
  const [row] = await tx
    .update(authorizations)
    .set({
      status: input.to,
      voidedAt: input.to === "void" ? input.now : null,
      version: sql`${authorizations.version} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(authorizations.ownerId, ownerId),
        eq(authorizations.id, input.authorizationId),
        eq(authorizations.version, input.version),
        eq(authorizations.status, input.from),
      ),
    )
    .returning();
  return row;
}

export async function advancePatternCommercialVersion(
  ownerId: string,
  tx: DbTransaction,
  input: {
    patternId: string;
    commercialVersion: number;
    changeSeq: bigint;
    now: Date;
  },
) {
  const [row] = await tx
    .update(patterns)
    .set({
      commercialVersion: sql`${patterns.commercialVersion} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.id, input.patternId),
        eq(patterns.commercialVersion, input.commercialVersion),
      ),
    )
    .returning({ commercialVersion: patterns.commercialVersion });
  return row;
}

export async function getAuthorizationRow(
  ownerId: string,
  authorizationId: string,
) {
  const [row] = await db
    .select()
    .from(authorizations)
    .where(
      and(
        eq(authorizations.ownerId, ownerId),
        eq(authorizations.id, authorizationId),
      ),
    )
    .limit(1);
  return row;
}

export async function getCommercialPatternReadRow(
  ownerId: string,
  patternId: string,
) {
  const [row] = await db
    .select({
      id: patterns.id,
      status: patterns.status,
      commercialVersion: patterns.commercialVersion,
    })
    .from(patterns)
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.id, patternId),
        ne(patterns.status, "deleted"),
      ),
    )
    .limit(1);
  return row;
}

export type AuthorizationHistoryCursor = {
  authorizedOn: string;
  createdAt: Date;
  id: string;
};

export function listAuthorizationHistoryRows(input: {
  ownerId: string;
  patternId: string;
  includeVoid: boolean;
  limit: number;
  cursor?: AuthorizationHistoryCursor;
}) {
  const predicates: SQL[] = [
    eq(authorizations.ownerId, input.ownerId),
    eq(authorizations.patternId, input.patternId),
  ];
  if (!input.includeVoid) predicates.push(eq(authorizations.status, "active"));
  if (input.cursor) {
    predicates.push(
      or(
        lt(authorizations.authorizedOn, input.cursor.authorizedOn),
        and(
          eq(authorizations.authorizedOn, input.cursor.authorizedOn),
          lt(authorizations.createdAt, input.cursor.createdAt),
        ),
        and(
          eq(authorizations.authorizedOn, input.cursor.authorizedOn),
          eq(authorizations.createdAt, input.cursor.createdAt),
          lt(authorizations.id, input.cursor.id),
        ),
      )!,
    );
  }

  return db
    .select()
    .from(authorizations)
    .where(and(...predicates))
    .orderBy(
      desc(authorizations.authorizedOn),
      desc(authorizations.createdAt),
      desc(authorizations.id),
    )
    .limit(input.limit + 1);
}

type AuthorizationSummaryRow = {
  activeCount: number;
  revenueFen: string;
  hasStandard: boolean;
  hasExclusive: boolean;
  hasBuyout: boolean;
};

export async function getAuthorizationSummaryRow(
  ownerId: string,
  patternId: string,
) {
  const [row] = await db.execute<AuthorizationSummaryRow>(sql`
    select
      count(*)::int as "activeCount",
      coalesce(sum(price_fen), 0)::text as "revenueFen",
      coalesce(bool_or(kind = 'standard'::authorization_kind), false) as "hasStandard",
      coalesce(bool_or(kind = 'field_exclusive'::authorization_kind), false) as "hasExclusive",
      coalesce(bool_or(kind = 'global_buyout'::authorization_kind), false) as "hasBuyout"
    from authorizations
    where owner_id = ${ownerId}
      and pattern_id = ${patternId}
      and status = 'active'::authorization_status
  `);
  return row;
}
