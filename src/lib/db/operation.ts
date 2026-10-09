import "server-only";

import { and, eq } from "drizzle-orm";

import { AppError } from "@/lib/http/app-error";

import type { DbTransaction } from "./client";
import { operations } from "./schema";

type ReplayResult = Record<string, unknown>;

export type OperationClaim =
  | { claimed: true }
  | { claimed: false; result: ReplayResult };

export async function claimOperation(
  ownerId: string,
  tx: DbTransaction,
  operationId: string,
  kind: string,
): Promise<OperationClaim> {
  const [claimed] = await tx
    .insert(operations)
    .values({ ownerId, operationId, kind, result: {} })
    .onConflictDoNothing({
      target: [operations.ownerId, operations.operationId],
    })
    .returning({ operationId: operations.operationId });

  if (claimed) return { claimed: true };

  const [existing] = await tx
    .select({ kind: operations.kind, result: operations.result })
    .from(operations)
    .where(
      and(
        eq(operations.ownerId, ownerId),
        eq(operations.operationId, operationId),
      ),
    )
    .limit(1);

  if (!existing || existing.kind !== kind) {
    throw new AppError(
      "OPERATION_ID_REUSED",
      409,
      "Operation ID was already used",
    );
  }

  return { claimed: false, result: existing.result };
}

export async function storeOperationResult(
  ownerId: string,
  tx: DbTransaction,
  operationId: string,
  result: ReplayResult,
) {
  await tx
    .update(operations)
    .set({ result, updatedAt: new Date() })
    .where(
      and(
        eq(operations.ownerId, ownerId),
        eq(operations.operationId, operationId),
      ),
    );
}
