import "server-only";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import type {
  ConceptErrorCode,
  ConceptOutputKind,
  InspirationConceptBrief,
} from "./contracts";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import {
  inspirationVisualAssets,
  inspirationVisualJobs,
} from "@/lib/db/schema/inspiration-visuals";
import { db, type DbTransaction } from "@/lib/db/client";
import {
  claimOperation,
  createOperationKey,
  storeOperationResult,
} from "@/lib/db/operation";
import { inspirationAnalyses } from "@/lib/db/schema/inspiration-analyses";
import {
  inspirationConceptSets as sets,
  inspirationConceptReferences as references,
  inspirationConceptTasks as tasks,
  inspirationConceptOutputs as outputs,
  inspirationConceptWorkerHeartbeats as heartbeats,
  type InspirationConceptSetRow,
  type InspirationConceptTaskRow,
  type InspirationConceptOutputRow,
} from "@/lib/db/schema/inspiration-concepts";

export class ConceptRepositoryError extends Error {
  constructor(
    public readonly code:
      | ConceptErrorCode
      | "OPERATION_ID_REUSED"
      | "INSPIRATION_NOT_FOUND"
      | "INSPIRATION_BUSY",
  ) {
    super(code);
    this.name = "ConceptRepositoryError";
  }
}
const busy = () => new ConceptRepositoryError("INSPIRATION_CONCEPT_BUSY");
/** Shared with research-visual completion: acquire before reading/retiring evidence. */
export async function lockConceptAnalysis(
  tx: DbTransaction,
  analysisId: string,
) {
  const id = normalizedUuidSchema.parse(analysisId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`melon:inspiration-analysis:${id}`}, 0))`,
  );
}
export interface CreateSetInput {
  ownerId: string;
  analysisId: string;
  operationId: string;
  directionIndex: number;
  briefSnapshot: InspirationConceptBrief;
  referenceAssetIds: readonly string[];
  visualJobId: string | null;
  now: Date;
  regeneratedFromSetId?: string;
}
export function conceptCreateOperationKey(
  input: Omit<CreateSetInput, "briefSnapshot" | "now">,
) {
  return input.regeneratedFromSetId
    ? conceptRegenerateOperationKey({
        analysisId: input.analysisId,
        setId: input.regeneratedFromSetId,
      })
    : createOperationKey("inspiration-concept.create", {
        analysisId: input.analysisId,
        directionIndex: input.directionIndex,
        visualJobId: input.visualJobId,
        referenceAssetIds: input.referenceAssetIds,
      });
}
export function conceptRegenerateOperationKey(input: {
  analysisId: string;
  setId: string;
}) {
  return createOperationKey("inspiration-concept.regenerate", {
    analysisId: input.analysisId,
    setId: input.setId,
  });
}
export function conceptRetryOperationKey(input: {
  analysisId: string;
  setId: string;
  outputKind: Exclude<ConceptOutputKind, "sketch">;
}) {
  return createOperationKey("inspiration-concept.retry", {
    analysisId: input.analysisId,
    setId: input.setId,
    outputKind: input.outputKind,
  });
}
export interface ClaimInput {
  workerId: string;
  now: Date;
  leaseUntil: Date;
}
/** leaseUntil is the claim token as well as the expiry; stale claims cannot mutate state. */
export interface TaskLeaseInput extends ClaimInput {
  taskId: string;
}
export type PublishOutputInput = TaskLeaseInput & {
  output: Pick<
    typeof outputs.$inferInsert,
    | "id"
    | "title"
    | "altText"
    | "objectKey"
    | "contentType"
    | "width"
    | "height"
  >;
};
function validClaim(input: ClaimInput) {
  if (
    !input.workerId.trim() ||
    input.workerId.length > 200 ||
    !Number.isFinite(input.now.getTime()) ||
    !Number.isFinite(input.leaseUntil.getTime()) ||
    input.leaseUntil <= input.now
  )
    throw new Error("Invalid concept lease");
}
function leasePredicate(input: TaskLeaseInput) {
  return and(
    eq(tasks.id, input.taskId),
    eq(tasks.leaseOwner, input.workerId),
    eq(tasks.leaseUntil, input.leaseUntil),
    gt(tasks.leaseUntil, input.now),
  );
}
const activeTaskStatuses = ["queued", "submitting", "submitted"] as const;
const clearLease = { leaseOwner: null, leaseUntil: null };
function uniqueConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return;
  if ("code" in error && error.code === "23505" && "constraint_name" in error)
    return String(error.constraint_name);
  return "cause" in error ? uniqueConstraint(error.cause) : undefined;
}

export async function listSetsForAnalysis(input: {
  ownerId: string;
  analysisId: string;
}) {
  return db
    .select()
    .from(sets)
    .where(
      and(
        eq(sets.ownerId, input.ownerId),
        eq(sets.analysisId, input.analysisId),
        isNull(sets.deletedAt),
      ),
    )
    .orderBy(asc(sets.directionIndex), desc(sets.version));
}
export async function findSetByOperation(input: {
  ownerId: string;
  operationId: string;
}) {
  const [row] = await db
    .select()
    .from(sets)
    .where(
      and(
        eq(sets.ownerId, input.ownerId),
        eq(sets.operationId, input.operationId),
      ),
    )
    .limit(1);
  return row;
}
export interface ConceptSetDetails {
  set: InspirationConceptSetRow;
  tasks: InspirationConceptTaskRow[];
  outputs: InspirationConceptOutputRow[];
}
/** A consistent read prevents worker publication from mixing old tasks/new assets. */
export async function listSetDetailsForAnalysis(input: {
  ownerId: string;
  analysisId: string;
  setId?: string;
  includeDeleted?: boolean;
}): Promise<ConceptSetDetails[]> {
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(sets)
        .where(
          and(
            eq(sets.ownerId, input.ownerId),
            eq(sets.analysisId, input.analysisId),
            input.setId ? eq(sets.id, input.setId) : undefined,
            input.includeDeleted ? undefined : isNull(sets.deletedAt),
          ),
        )
        .orderBy(asc(sets.directionIndex), desc(sets.version));
      if (!rows.length) return [];
      const ids = rows.map(({ id }) => id);
      const taskRows = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerId, input.ownerId), inArray(tasks.setId, ids)))
        .orderBy(desc(tasks.attempt));
      const outputRows = await tx
        .select()
        .from(outputs)
        .where(
          and(eq(outputs.ownerId, input.ownerId), inArray(outputs.setId, ids)),
        );
      return rows.map((set) => ({
        set,
        tasks: taskRows.filter(({ setId }) => setId === set.id),
        outputs: outputRows.filter(({ setId }) => setId === set.id),
      }));
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function listReferenceIdentities(input: {
  ownerId: string;
  analysisId: string;
  setId: string;
}) {
  return db
    .select({
      id: references.visualAssetId,
      jobId: inspirationVisualAssets.jobId,
    })
    .from(references)
    .innerJoin(
      inspirationVisualAssets,
      and(
        eq(inspirationVisualAssets.id, references.visualAssetId),
        eq(inspirationVisualAssets.ownerId, references.ownerId),
        eq(inspirationVisualAssets.analysisId, references.analysisId),
      ),
    )
    .where(
      and(
        eq(references.ownerId, input.ownerId),
        eq(references.analysisId, input.analysisId),
        eq(references.setId, input.setId),
      ),
    )
    .orderBy(asc(references.ordinal));
}
async function requireCompletedAnalysis(
  tx: DbTransaction,
  input: { ownerId: string; analysisId: string },
) {
  const [analysis] = await tx
    .select({ status: inspirationAnalyses.status })
    .from(inspirationAnalyses)
    .where(
      and(
        eq(inspirationAnalyses.id, input.analysisId),
        eq(inspirationAnalyses.ownerId, input.ownerId),
      ),
    )
    .for("share");
  if (!analysis) throw new ConceptRepositoryError("INSPIRATION_NOT_FOUND");
  if (analysis.status !== "completed")
    throw new ConceptRepositoryError("INSPIRATION_BUSY");
}
async function replaySet(tx: DbTransaction, input: CreateSetInput) {
  const operation = await claimOperation(
    input.ownerId,
    tx,
    input.operationId,
    conceptCreateOperationKey(input),
  );
  if (operation.state === "mismatch")
    throw new ConceptRepositoryError("OPERATION_ID_REUSED");
  if (operation.state === "claimed") return;
  const [set] = await tx
    .select()
    .from(sets)
    .where(
      and(
        eq(sets.ownerId, input.ownerId),
        eq(sets.operationId, input.operationId),
        eq(sets.analysisId, input.analysisId),
        eq(sets.id, String(operation.result.setId)),
        isNull(sets.deletedAt),
      ),
    )
    .limit(1);
  if (!set) throw new ConceptRepositoryError("INSPIRATION_NOT_FOUND");
  const [task] = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.setId, set.id),
        eq(tasks.outputKind, "sketch"),
        eq(tasks.attempt, 1),
      ),
    )
    .limit(1);
  if (!task) throw new Error("Concept set has no sketch task");
  return { set, task };
}
/** Check current evidence after acquiring the same lock used by visual refresh completion. */
async function validateReferences(tx: DbTransaction, input: CreateSetInput) {
  if (!input.referenceAssetIds.length) return;
  if (
    input.referenceAssetIds.length > 3 ||
    new Set(input.referenceAssetIds).size !== input.referenceAssetIds.length
  )
    throw new ConceptRepositoryError("INSPIRATION_CONCEPT_REFERENCE_INVALID");
  const [current] = await tx
    .select({ id: inspirationVisualJobs.id })
    .from(inspirationVisualJobs)
    .where(
      and(
        eq(inspirationVisualJobs.ownerId, input.ownerId),
        eq(inspirationVisualJobs.analysisId, input.analysisId),
        eq(inspirationVisualJobs.kind, "research_visuals"),
        eq(inspirationVisualJobs.status, "completed"),
      ),
    )
    .orderBy(
      desc(inspirationVisualJobs.createdAt),
      desc(inspirationVisualJobs.id),
    )
    .limit(1);
  if (!current || current.id !== input.visualJobId)
    throw new ConceptRepositoryError("INSPIRATION_CONCEPT_REFERENCES_STALE");
  const owned = await tx
    .select({ id: inspirationVisualAssets.id })
    .from(inspirationVisualAssets)
    .where(
      and(
        eq(inspirationVisualAssets.ownerId, input.ownerId),
        eq(inspirationVisualAssets.analysisId, input.analysisId),
        eq(inspirationVisualAssets.jobId, current.id),
        eq(inspirationVisualAssets.kind, "web_evidence"),
        inArray(inspirationVisualAssets.id, [...input.referenceAssetIds]),
      ),
    );
  if (owned.length !== input.referenceAssetIds.length)
    throw new ConceptRepositoryError("INSPIRATION_CONCEPT_REFERENCE_INVALID");
}
export async function createSetAndSketchTask(
  input: CreateSetInput,
): Promise<{ set: InspirationConceptSetRow; task: InspirationConceptTaskRow }> {
  try {
    return await db.transaction(async (tx) => {
      await lockConceptAnalysis(tx, input.analysisId);
      await requireCompletedAnalysis(tx, input);
      const replay = await replaySet(tx, input);
      if (replay) return replay;
      if (input.regeneratedFromSetId) {
        const [source] = await tx
          .select({ id: sets.id })
          .from(sets)
          .where(
            and(
              eq(sets.ownerId, input.ownerId),
              eq(sets.analysisId, input.analysisId),
              eq(sets.id, input.regeneratedFromSetId),
              isNull(sets.deletedAt),
            ),
          );
        if (!source) throw new ConceptRepositoryError("INSPIRATION_NOT_FOUND");
      }
      await validateReferences(tx, input);
      const retained = await tx
        .select()
        .from(sets)
        .where(
          and(
            eq(sets.analysisId, input.analysisId),
            eq(sets.directionIndex, input.directionIndex),
            isNull(sets.deletedAt),
          ),
        );
      if (retained.length >= 3)
        throw new ConceptRepositoryError("INSPIRATION_CONCEPT_LIMIT_REACHED");
      if (
        retained.some(
          (row) => row.status === "queued" || row.status === "generating",
        )
      )
        throw busy();
      const [latest] = await tx
        .select({ version: max(sets.version) })
        .from(sets)
        .where(
          and(
            eq(sets.analysisId, input.analysisId),
            eq(sets.directionIndex, input.directionIndex),
          ),
        );
      const [set] = await tx
        .insert(sets)
        .values({
          id: randomUUID(),
          ownerId: input.ownerId,
          analysisId: input.analysisId,
          operationId: input.operationId,
          directionIndex: input.directionIndex,
          version: (latest?.version ?? 0) + 1,
          status: "queued",
          briefSnapshot: input.briefSnapshot,
          promptTemplateVersion: input.briefSnapshot.promptTemplateVersion,
          model: input.briefSnapshot.model,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (input.referenceAssetIds.length)
        await tx.insert(references).values(
          input.referenceAssetIds.map((visualAssetId, ordinal) => ({
            ownerId: input.ownerId,
            analysisId: input.analysisId,
            setId: set!.id,
            visualAssetId,
            ordinal,
          })),
        );
      const [task] = await tx
        .insert(tasks)
        .values({
          id: randomUUID(),
          ownerId: input.ownerId,
          setId: set!.id,
          operationId: randomUUID(),
          outputKind: "sketch",
          attempt: 1,
          status: "queued",
          availableAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      await storeOperationResult(input.ownerId, tx, input.operationId, {
        setId: set!.id,
      });
      return { set: set!, task: task! };
    });
  } catch (error) {
    const name = uniqueConstraint(error);
    if (name === "inspiration_concept_sets_owner_operation_unique") {
      const replay = await db.transaction((tx) => replaySet(tx, input));
      if (replay) return replay;
    }
    if (
      name === "inspiration_concept_sets_active_direction_unique" ||
      name === "inspiration_concept_sets_analysis_direction_version_unique"
    ) {
      const winning = await listSetsForAnalysis(input);
      const retained = winning.filter(
        (row) => row.directionIndex === input.directionIndex,
      );
      if (retained.length >= 3)
        throw new ConceptRepositoryError("INSPIRATION_CONCEPT_LIMIT_REACHED");
      throw busy();
    }
    throw error;
  }
}

export async function createDerivativeRetry(input: {
  ownerId: string;
  analysisId?: string;
  setId: string;
  operationId: string;
  outputKind: Exclude<ConceptOutputKind, "sketch">;
  now: Date;
}) {
  if (input.outputKind !== "effect" && input.outputKind !== "flat")
    throw new ConceptRepositoryError("INSPIRATION_CONCEPT_REJECTED");
  try {
    return await db.transaction(async (tx) => {
      const [identity] = await tx
        .select({ analysisId: sets.analysisId })
        .from(sets)
        .where(and(eq(sets.id, input.setId), eq(sets.ownerId, input.ownerId)));
      if (!identity) throw new ConceptRepositoryError("INSPIRATION_NOT_FOUND");
      if (input.analysisId && identity.analysisId !== input.analysisId)
        throw new ConceptRepositoryError("INSPIRATION_NOT_FOUND");
      await lockConceptAnalysis(tx, identity.analysisId);
      await requireCompletedAnalysis(tx, {
        ownerId: input.ownerId,
        analysisId: identity.analysisId,
      });
      const [set] = await tx
        .select()
        .from(sets)
        .where(
          and(
            eq(sets.id, input.setId),
            eq(sets.ownerId, input.ownerId),
            isNull(sets.deletedAt),
          ),
        )
        .for("update");
      if (!set) throw new ConceptRepositoryError("INSPIRATION_NOT_FOUND");
      const operation = await claimOperation(
        input.ownerId,
        tx,
        input.operationId,
        conceptRetryOperationKey({ ...input, analysisId: set.analysisId }),
      );
      if (operation.state === "mismatch")
        throw new ConceptRepositoryError("OPERATION_ID_REUSED");
      const [replay] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.ownerId, input.ownerId),
            eq(tasks.operationId, input.operationId),
          ),
        );
      if (replay) {
        if (
          replay.setId !== input.setId ||
          replay.outputKind !== input.outputKind
        )
          throw new ConceptRepositoryError("OPERATION_ID_REUSED");
        return replay;
      }
      if (operation.state === "replay")
        throw new ConceptRepositoryError("INSPIRATION_NOT_FOUND");
      const [sketch] = await tx
        .select({ id: outputs.id })
        .from(outputs)
        .where(
          and(eq(outputs.setId, set.id), eq(outputs.outputKind, "sketch")),
        );
      if (!sketch)
        throw new ConceptRepositoryError("INSPIRATION_CONCEPT_REJECTED");
      const slotTasks = await tx
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.setId, set.id), eq(tasks.outputKind, input.outputKind)),
        );
      if (
        slotTasks.some((row) =>
          activeTaskStatuses.some((status) => row.status === status),
        )
      )
        throw busy();
      const [task] = await tx
        .insert(tasks)
        .values({
          id: randomUUID(),
          ownerId: input.ownerId,
          setId: set.id,
          operationId: input.operationId,
          outputKind: input.outputKind,
          attempt: Math.max(0, ...slotTasks.map((row) => row.attempt)) + 1,
          status: "queued",
          availableAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      await deriveSet(tx, set.id, input.now);
      await storeOperationResult(input.ownerId, tx, input.operationId, {
        taskId: task!.id,
        setId: set.id,
      });
      return task!;
    });
  } catch (error) {
    if (uniqueConstraint(error)) throw busy();
    throw error;
  }
}

/** Tombstone first; submitted/claimed work and all external cleanup belong to workers. */
export async function softDeleteSet(input: {
  ownerId: string;
  analysisId: string;
  setId: string;
  now: Date;
}) {
  return db.transaction(async (tx) => {
    await lockConceptAnalysis(tx, input.analysisId);
    const [set] = await tx
      .select()
      .from(sets)
      .where(
        and(
          eq(sets.ownerId, input.ownerId),
          eq(sets.analysisId, input.analysisId),
          eq(sets.id, input.setId),
        ),
      )
      .for("update");
    if (!set) throw new ConceptRepositoryError("INSPIRATION_NOT_FOUND");
    if (set.deletedAt) return set;
    const [deleted] = await tx
      .update(sets)
      .set({ status: "deleting", deletedAt: input.now, updatedAt: input.now })
      .where(eq(sets.id, set.id))
      .returning();
    await tx
      .update(tasks)
      .set({
        status: "failed",
        errorCode: "INSPIRATION_CONCEPT_UNAVAILABLE",
        completedAt: input.now,
        updatedAt: input.now,
        ...clearLease,
      })
      .where(
        and(
          eq(tasks.setId, set.id),
          eq(tasks.ownerId, input.ownerId),
          eq(tasks.status, "queued"),
          isNull(tasks.leaseOwner),
          isNull(tasks.leaseUntil),
        ),
      );
    return deleted!;
  });
}

export async function claimNextTask(input: ClaimInput) {
  validClaim(input);
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, ["queued", "submitted"]),
          lte(tasks.availableAt, input.now),
          or(isNull(tasks.leaseUntil), lt(tasks.leaseUntil, input.now)),
          sql`exists (select 1 from ${sets} where ${sets.id} = ${tasks.setId} and ${sets.deletedAt} is null and ${sets.status} <> 'deleting')`,
        ),
      )
      .orderBy(asc(tasks.availableAt), asc(tasks.createdAt), asc(tasks.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return;
    const [claimed] = await tx
      .update(tasks)
      .set({
        leaseOwner: input.workerId,
        leaseUntil: input.leaseUntil,
        updatedAt: input.now,
      })
      .where(eq(tasks.id, candidate.id))
      .returning();
    return claimed;
  });
}
/** Always lock set before task, including publication, failure, and retries. */
async function withLeasedTask<T>(
  input: TaskLeaseInput,
  action: (
    tx: DbTransaction,
    task: InspirationConceptTaskRow,
    set: InspirationConceptSetRow,
  ) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select({ setId: tasks.setId })
      .from(tasks)
      .where(eq(tasks.id, input.taskId));
    if (!identity) return;
    const [set] = await tx
      .select()
      .from(sets)
      .where(and(eq(sets.id, identity.setId), isNull(sets.deletedAt)))
      .for("update");
    if (!set) return;
    const [task] = await tx
      .select()
      .from(tasks)
      .where(
        and(leasePredicate(input), inArray(tasks.status, activeTaskStatuses)),
      )
      .for("update");
    if (!task) return;
    return action(tx, task, set);
  });
}
export async function markTaskSubmitting(input: TaskLeaseInput) {
  return withLeasedTask(input, async (tx, task) => {
    if (task.status !== "queued") return;
    const [updated] = await tx
      .update(tasks)
      .set({
        status: "submitting",
        submitStartedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(leasePredicate(input), eq(tasks.status, "queued")))
      .returning();
    await deriveSet(tx, task.setId, input.now);
    return updated;
  });
}
export async function markTaskSubmitted(
  input: TaskLeaseInput & {
    providerTaskId: string;
    providerRequestId?: string | null;
    availableAt?: Date;
  },
) {
  return withLeasedTask(input, async (tx, task) => {
    if (task.status !== "submitting") return;
    const [updated] = await tx
      .update(tasks)
      .set({
        status: "submitted",
        providerTaskId: input.providerTaskId,
        providerRequestId: input.providerRequestId ?? null,
        availableAt: input.availableAt ?? input.now,
        updatedAt: input.now,
        ...clearLease,
      })
      .where(and(leasePredicate(input), eq(tasks.status, "submitting")))
      .returning();
    return updated;
  });
}
export async function rescheduleTask(
  input: TaskLeaseInput & { availableAt: Date },
) {
  return withLeasedTask(input, async (tx, task) => {
    if (task.status !== "queued" && task.status !== "submitted") return;
    const [updated] = await tx
      .update(tasks)
      .set({
        availableAt: input.availableAt,
        updatedAt: input.now,
        ...clearLease,
      })
      .where(and(leasePredicate(input), eq(tasks.status, task.status)))
      .returning();
    return updated;
  });
}
async function deriveSet(tx: DbTransaction, setId: string, now: Date) {
  const outstanding = await tx
    .select({ status: tasks.status })
    .from(tasks)
    .where(
      and(eq(tasks.setId, setId), inArray(tasks.status, activeTaskStatuses)),
    );
  const current = await tx
    .select({ kind: outputs.outputKind })
    .from(outputs)
    .where(eq(outputs.setId, setId));
  const status = outstanding.length
    ? "generating"
    : current.length === 3
      ? "completed"
      : current.length
        ? "partial"
        : "failed";
  const [set] = await tx
    .update(sets)
    .set({
      status,
      completedAt: outstanding.length ? null : now,
      updatedAt: now,
    })
    .where(and(eq(sets.id, setId), isNull(sets.deletedAt)))
    .returning();
  return set!;
}
export async function publishTaskOutput(input: PublishOutputInput) {
  return withLeasedTask(input, async (tx, task, set) => {
    if (task.status !== "submitted") return;
    const [previous] = await tx
      .select()
      .from(outputs)
      .where(
        and(eq(outputs.setId, set.id), eq(outputs.outputKind, task.outputKind)),
      );
    const values = {
      ...input.output,
      ownerId: task.ownerId,
      analysisId: set.analysisId,
      setId: set.id,
      sourceTaskId: task.id,
      outputKind: task.outputKind,
      createdAt: input.now,
    };
    const [output] = await tx
      .insert(outputs)
      .values(values)
      .onConflictDoUpdate({
        target: [outputs.setId, outputs.outputKind],
        set: values,
      })
      .returning();
    await tx
      .update(tasks)
      .set({
        status: "completed",
        completedAt: input.now,
        updatedAt: input.now,
        ...clearLease,
      })
      .where(and(leasePredicate(input), eq(tasks.status, "submitted")));
    if (task.outputKind === "sketch") {
      for (const outputKind of ["effect", "flat"] as const) {
        const [existing] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.setId, set.id), eq(tasks.outputKind, outputKind)))
          .limit(1);
        const [current] = await tx
          .select({ id: outputs.id })
          .from(outputs)
          .where(
            and(eq(outputs.setId, set.id), eq(outputs.outputKind, outputKind)),
          )
          .limit(1);
        if (!existing && !current)
          await tx
            .insert(tasks)
            .values({
              id: randomUUID(),
              ownerId: task.ownerId,
              setId: set.id,
              operationId: randomUUID(),
              outputKind,
              attempt: 1,
              status: "queued",
              availableAt: input.now,
              createdAt: input.now,
              updatedAt: input.now,
            });
      }
    }
    return {
      output: output!,
      supersededObjectKey:
        previous && previous.objectKey !== output!.objectKey
          ? previous.objectKey
          : null,
      set: await deriveSet(tx, set.id, input.now),
    };
  });
}
export async function failTask(
  input: TaskLeaseInput & { errorCode: ConceptErrorCode },
) {
  return withLeasedTask(input, async (tx, task) => {
    const [updated] = await tx
      .update(tasks)
      .set({
        status: "failed",
        errorCode: input.errorCode,
        completedAt: input.now,
        updatedAt: input.now,
        ...clearLease,
      })
      .where(and(leasePredicate(input), eq(tasks.status, task.status)))
      .returning();
    await deriveSet(tx, task.setId, input.now);
    return updated;
  });
}
export async function claimDeletingSet(
  workerId: string,
  now: Date,
  leaseUntil: Date,
) {
  validClaim({ workerId, now, leaseUntil });
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(sets)
      .where(
        and(
          eq(sets.status, "deleting"),
          or(isNull(sets.deletionLeaseUntil), lt(sets.deletionLeaseUntil, now)),
          sql`not exists (select 1 from ${tasks} where ${tasks.setId} = ${sets.id} and ${tasks.leaseUntil} > ${now.toISOString()}::timestamptz)`,
        ),
      )
      .orderBy(asc(sets.deletedAt), asc(sets.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return;
    const [claimed] = await tx
      .update(sets)
      .set({
        deletionLeaseOwner: workerId,
        deletionLeaseUntil: leaseUntil,
        updatedAt: now,
      })
      .where(eq(sets.id, candidate.id))
      .returning();
    return claimed;
  });
}
export async function recordWorkerHeartbeat(input: {
  workerId: string;
  startedAt: Date;
  now: Date;
}) {
  const [row] = await db
    .insert(heartbeats)
    .values({
      workerId: input.workerId,
      startedAt: input.startedAt,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: heartbeats.workerId,
      set: { updatedAt: input.now },
    })
    .returning();
  return row!;
}

/** Recover a bounded batch without ever reissuing an uncertain paid submission. */
export async function failExpiredSubmittingTasks(now: Date) {
  const candidates = await db
    .select({ id: tasks.id, setId: tasks.setId })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "submitting"),
        isNull(tasks.providerTaskId),
        or(isNull(tasks.leaseUntil), lte(tasks.leaseUntil, now)),
      ),
    )
    .orderBy(asc(tasks.updatedAt), asc(tasks.id))
    .limit(25);
  let recovered = 0;
  for (const candidate of candidates) {
    recovered += await db.transaction(async (tx) => {
      const [set] = await tx
        .select()
        .from(sets)
        .where(eq(sets.id, candidate.setId))
        .for("update", { skipLocked: true });
      if (!set) return 0;
      const changed = await tx
        .update(tasks)
        .set({
          status: "failed",
          errorCode: "INSPIRATION_CONCEPT_SUBMISSION_UNCERTAIN",
          completedAt: now,
          updatedAt: now,
          ...clearLease,
        })
        .where(
          and(
            eq(tasks.id, candidate.id),
            eq(tasks.status, "submitting"),
            isNull(tasks.providerTaskId),
            or(isNull(tasks.leaseUntil), lte(tasks.leaseUntil, now)),
          ),
        )
        .returning({ id: tasks.id });
      if (changed.length && !set.deletedAt) await deriveSet(tx, set.id, now);
      return changed.length;
    });
  }
  return recovered;
}

/** Resolve private inputs only through an unexpired, owned task and its frozen references. */
export async function loadWorkerTaskContext(input: TaskLeaseInput) {
  return withLeasedTask(input, async (tx, task, set) => {
    const selected = await tx
      .select({ asset: inspirationVisualAssets, ordinal: references.ordinal })
      .from(references)
      .innerJoin(
        inspirationVisualAssets,
        and(
          eq(inspirationVisualAssets.id, references.visualAssetId),
          eq(inspirationVisualAssets.ownerId, references.ownerId),
          eq(inspirationVisualAssets.analysisId, references.analysisId),
        ),
      )
      .where(
        and(
          eq(references.setId, set.id),
          eq(references.ownerId, task.ownerId),
          eq(references.analysisId, set.analysisId),
        ),
      )
      .orderBy(asc(references.ordinal));
    const [sketch] = await tx
      .select()
      .from(outputs)
      .where(
        and(
          eq(outputs.setId, set.id),
          eq(outputs.ownerId, task.ownerId),
          eq(outputs.analysisId, set.analysisId),
          eq(outputs.outputKind, "sketch"),
        ),
      );
    return { set, references: selected.map(({ asset }) => asset), sketch };
  });
}

/** Called only after prefix deletion succeeds; preserve tombstone on any lost lease. */
export async function finishDeletingSet(input: ClaimInput & { setId: string }) {
  return db.transaction(async (tx) => {
    const [set] = await tx
      .select()
      .from(sets)
      .where(
        and(
          eq(sets.id, input.setId),
          eq(sets.status, "deleting"),
          eq(sets.deletionLeaseOwner, input.workerId),
          eq(sets.deletionLeaseUntil, input.leaseUntil),
          gt(sets.deletionLeaseUntil, input.now),
        ),
      )
      .for("update");
    if (!set) return false;
    const [live] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.setId, set.id), gt(tasks.leaseUntil, input.now)))
      .limit(1);
    if (live) return false;
    await tx.delete(sets).where(eq(sets.id, set.id));
    return true;
  });
}
