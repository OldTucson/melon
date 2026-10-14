import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ZodError } from "zod";

import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { db, type DbTransaction } from "@/lib/db/client";
import { patterns } from "@/lib/db/schema";
import { AppError, validationError } from "@/lib/http/app-error";

import { patternDeletionImpactRequestSchema } from "./deletion-impact-contracts";
import { estimateTrashPurgeOn } from "./retention";

export type CommercialDeletionImpact = {
  activeAuthorizationCount: number;
  activeRevenueFen: string;
  totalAuthorizationCount: number;
  assetCount: number;
};

export type PatternCommercialDeletionImpact = CommercialDeletionImpact & {
  patternId: string;
};

const emptyImpact = (): CommercialDeletionImpact => ({
  activeAuthorizationCount: 0,
  activeRevenueFen: "0",
  totalAuthorizationCount: 0,
  assetCount: 0,
});

function requirePatternIds(patternIds: readonly string[]) {
  let previous: string | undefined;
  for (const patternId of patternIds) {
    const parsed = normalizedUuidSchema.safeParse(patternId);
    if (
      !parsed.success ||
      parsed.data !== patternId ||
      (previous !== undefined && previous >= patternId)
    ) {
      throw new Error("PATTERN_IDS_MUST_BE_SORTED_UNIQUE_NORMALIZED");
    }
    previous = patternId;
  }
}

type RawImpactRow = {
  patternId: string;
  activeAuthorizationCount: number | string;
  activeRevenueFen: string;
  totalAuthorizationCount: number | string;
  assetCount: number | string;
};

export async function listPatternCommercialDeletionImpacts(
  ownerId: string,
  patternIds: readonly string[],
  executor: Pick<DbTransaction, "execute"> = db,
): Promise<PatternCommercialDeletionImpact[]> {
  requirePatternIds(patternIds);
  if (patternIds.length === 0) return [];

  const ids = sql.join(
    patternIds.map((patternId) => sql`${patternId}::uuid`),
    sql`, `,
  );
  const rows = await executor.execute<RawImpactRow>(sql`
    select
      target.id as "patternId",
      coalesce(commercial."activeAuthorizationCount", 0)::int
        as "activeAuthorizationCount",
      coalesce(commercial."activeRevenueFen", '0')::text
        as "activeRevenueFen",
      coalesce(commercial."totalAuthorizationCount", 0)::int
        as "totalAuthorizationCount",
      coalesce(stored."assetCount", 0)::int as "assetCount"
    from patterns target
    left join lateral (
      select
        count(*) filter (
          where auth.status = 'active'::authorization_status
        ) as "activeAuthorizationCount",
        coalesce(
          sum(auth.price_fen) filter (
            where auth.status = 'active'::authorization_status
          ),
          0
        )::text as "activeRevenueFen",
        count(*) as "totalAuthorizationCount"
      from authorizations auth
      where auth.owner_id = ${ownerId}
        and auth.pattern_id = target.id
    ) commercial on true
    left join lateral (
      select count(*) as "assetCount"
      from assets asset
      where asset.owner_id = ${ownerId}
        and asset.pattern_id = target.id
    ) stored on true
    where target.owner_id = ${ownerId}
      and target.id in (${ids})
    order by target.id asc
  `);

  return rows.map((row) => ({
    patternId: row.patternId,
    activeAuthorizationCount: Number(row.activeAuthorizationCount),
    activeRevenueFen: row.activeRevenueFen,
    totalAuthorizationCount: Number(row.totalAuthorizationCount),
    assetCount: Number(row.assetCount),
  }));
}

export function sumCommercialDeletionImpacts(
  impacts: readonly CommercialDeletionImpact[],
): CommercialDeletionImpact {
  return impacts.reduce<CommercialDeletionImpact>(
    (total, impact) => ({
      activeAuthorizationCount:
        total.activeAuthorizationCount + impact.activeAuthorizationCount,
      activeRevenueFen: (
        BigInt(total.activeRevenueFen) + BigInt(impact.activeRevenueFen)
      ).toString(),
      totalAuthorizationCount:
        total.totalAuthorizationCount + impact.totalAuthorizationCount,
      assetCount: total.assetCount + impact.assetCount,
    }),
    emptyImpact(),
  );
}

const editablePatternStatuses = new Set(["ready", "failed"] as const);

function patternNotFound(): never {
  throw new AppError("NOT_FOUND", 404, "Pattern not found");
}

function patternStateChanged(): never {
  throw new AppError("PATTERN_STATE_CHANGED", 409, "Pattern state changed");
}

export async function getPatternDeletionImpact(input: {
  ownerId: string;
  patternIds: readonly string[];
}) {
  let patternIds: string[];
  try {
    patternIds = patternDeletionImpactRequestSchema.parse({
      patternIds: input.patternIds,
    }).patternIds;
  } catch (error) {
    if (error instanceof ZodError) throw validationError();
    throw error;
  }
  const sortedPatternIds = [...patternIds].sort();

  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select({ id: patterns.id, status: patterns.status })
        .from(patterns)
        .where(
          and(
            eq(patterns.ownerId, input.ownerId),
            inArray(patterns.id, sortedPatternIds),
          ),
        )
        .orderBy(asc(patterns.id));
      if (
        rows.length !== sortedPatternIds.length ||
        rows.some((row, index) => row.id !== sortedPatternIds[index])
      ) {
        patternNotFound();
      }
      if (
        rows.some(
          (row) =>
            !editablePatternStatuses.has(row.status as "ready" | "failed"),
        )
      ) {
        patternStateChanged();
      }

      const impacts = await listPatternCommercialDeletionImpacts(
        input.ownerId,
        sortedPatternIds,
        tx,
      );
      if (impacts.length !== sortedPatternIds.length) {
        throw new Error("PATTERN_DELETION_IMPACT_INCOMPLETE");
      }
      return {
        ...sumCommercialDeletionImpacts(impacts),
        purgeOn: estimateTrashPurgeOn(),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
