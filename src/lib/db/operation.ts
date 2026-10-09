import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { DbTransaction } from "./client";
import { operations } from "./schema";

type ReplayResult = Record<string, unknown>;

export type OperationClaim =
  | { state: "claimed" }
  | { state: "replay"; result: ReplayResult }
  | { state: "mismatch" };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function createOperationKey(action: string, payload: unknown) {
  const canonicalPayload = JSON.stringify(canonicalize(payload)) ?? "null";
  const fingerprint = createHash("sha256")
    .update(canonicalPayload)
    .digest("hex");
  return `${action}:${fingerprint}`;
}

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

  if (claimed) return { state: "claimed" };

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

  if (!existing || existing.kind !== kind) return { state: "mismatch" };

  return { state: "replay", result: existing.result };
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
