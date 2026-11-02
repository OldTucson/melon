import "server-only";

import { z } from "zod";
import { inspirationAnalysisResultSchema } from "@/features/inspiration/contracts";
import {
  inspirationBusy,
  inspirationNotFound,
  parseInspirationInput,
  parseInspirationStored,
  requireOwnedInspiration,
} from "@/features/inspiration/analysis-service";
import { findLatestCompletedResearchJob } from "@/features/inspiration-visuals/visual-repository";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { readOperation } from "@/lib/db/operation";
import { getServerEnv } from "@/lib/env/server";
import { AppError } from "@/lib/http/app-error";
import { buildInspirationConceptBrief } from "./brief";
import {
  conceptRetryMutationSchema,
  conceptSetCreateMutationSchema,
  conceptSetDtoSchema,
  type ConceptSetDto,
} from "./contracts";
import * as repository from "./repository";

const identitySchema = z
  .object({ ownerId: normalizedUuidSchema, analysisId: normalizedUuidSchema })
  .strict();
const setIdentitySchema = identitySchema
  .extend({ setId: normalizedUuidSchema })
  .strict();
const createSchema = conceptSetCreateMutationSchema
  .safeExtend(identitySchema.shape)
  .strict();
const regenerateSchema = conceptRetryMutationSchema
  .extend(setIdentitySchema.shape)
  .strict();
const retrySchema = regenerateSchema
  .extend({ outputKind: z.enum(["effect", "flat"]) })
  .strict();
const operationReused = () =>
  new AppError("OPERATION_ID_REUSED", 409, "Operation ID was already used");

function requireEnabled() {
  if (!getServerEnv().INSPIRATION_CONCEPT_IMAGES_ENABLED) {
    throw new AppError(
      "INSPIRATION_CONCEPT_DISABLED",
      503,
      "Inspiration concepts are disabled",
    );
  }
}

async function mutation<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof repository.ConceptRepositoryError) {
      if (error.code === "INSPIRATION_NOT_FOUND") throw inspirationNotFound();
      if (error.code === "INSPIRATION_BUSY") throw inspirationBusy();
      if (error.code === "OPERATION_ID_REUSED") throw operationReused();
      const status =
        error.code === "INSPIRATION_CONCEPT_REFERENCE_INVALID" ||
        error.code === "INSPIRATION_CONCEPT_REJECTED"
          ? 400
          : error.code === "INSPIRATION_CONCEPT_UNAVAILABLE"
            ? 503
            : 409;
      throw new AppError(
        error.code,
        status,
        "Inspiration concept operation failed",
      );
    }
    throw new AppError(
      "INTERNAL_ERROR",
      500,
      "Inspiration concept operation failed",
    );
  }
}

/** Explicit projection is the only server-row to browser boundary. */
export function toConceptSetDto({
  set,
  tasks,
  outputs,
}: repository.ConceptSetDetails): ConceptSetDto {
  const slots = (["sketch", "effect", "flat"] as const).map((kind) => {
    const asset = outputs.find((row) => row.outputKind === kind);
    const latest = tasks
      .filter((row) => row.outputKind === kind)
      .sort((a, b) => b.attempt - a.attempt)[0];
    const task =
      latest &&
      (latest.status === "queued" ||
        latest.status === "submitting" ||
        latest.status === "submitted")
        ? {
            status:
              latest.status === "queued"
                ? ("queued" as const)
                : ("generating" as const),
            errorCode: null,
          }
        : latest?.status === "failed" &&
            (!asset || asset.sourceTaskId !== latest.id)
          ? { status: "failed" as const, errorCode: latest.errorCode }
          : null;
    return {
      kind,
      asset: asset
        ? {
            id: asset.id,
            kind,
            title: asset.title,
            altText: asset.altText,
            imageUrl: `/api/inspiration-concept-assets/${asset.id}`,
            width: asset.width,
            height: asset.height,
            createdAt: asset.createdAt.toISOString(),
          }
        : null,
      task,
    };
  });
  const active = slots.filter(
    ({ task }) => task?.status === "queued" || task?.status === "generating",
  );
  const count = slots.filter(({ asset }) => asset).length;
  const status = active.length
    ? active.some(({ task }) => task?.status === "generating")
      ? "generating"
      : "queued"
    : count === 3
      ? "completed"
      : count
        ? "partial"
        : "failed";
  return parseInspirationStored(conceptSetDtoSchema, {
    id: set.id,
    directionIndex: set.directionIndex,
    version: set.version,
    status,
    slots,
    createdAt: set.createdAt.toISOString(),
    completedAt: active.length
      ? null
      : (set.completedAt?.toISOString() ?? null),
  });
}

async function ownedSet(
  input: z.infer<typeof setIdentitySchema>,
  includeDeleted = false,
) {
  const [details] = await repository.listSetDetailsForAnalysis({
    ...input,
    includeDeleted,
  });
  if (!details) throw inspirationNotFound();
  return details;
}
async function setDto(input: z.infer<typeof setIdentitySchema>) {
  return toConceptSetDto(await ownedSet(input));
}
async function replay(
  input: { ownerId: string; analysisId: string; operationId: string },
  key: string,
) {
  const operation = await readOperation(input.ownerId, input.operationId);
  if (!operation) return;
  if (operation.kind !== key) throw operationReused();
  const setId = normalizedUuidSchema.safeParse(operation.result.setId);
  if (!setId.success)
    throw new AppError(
      "INTERNAL_ERROR",
      500,
      "Inspiration concept operation failed",
    );
  return setDto({ ...input, setId: setId.data });
}

async function create(
  input: z.infer<typeof createSchema>,
  regeneratedFromSetId?: string,
) {
  const analysis = await requireOwnedInspiration(
    input.ownerId,
    input.analysisId,
  );
  if (analysis.status !== "completed") throw inspirationBusy();
  const target = { ...input, regeneratedFromSetId };
  const existing = await replay(
    input,
    repository.conceptCreateOperationKey(target),
  );
  if (existing) return existing;
  const result = parseInspirationStored(
    inspirationAnalysisResultSchema,
    analysis.result,
  );
  if (input.directionIndex >= result.inspirationPrompts.length) {
    throw new AppError(
      "INSPIRATION_INVALID_INPUT",
      400,
      "Invalid inspiration input",
    );
  }
  if (input.referenceAssetIds.length) {
    const active = await findLatestCompletedResearchJob(
      input.ownerId,
      input.analysisId,
    );
    if (!active || active.id !== input.visualJobId) {
      throw new AppError(
        "INSPIRATION_CONCEPT_REFERENCES_STALE",
        409,
        "Inspiration concept references changed",
      );
    }
  }
  const { set } = await repository.createSetAndSketchTask({
    ...target,
    briefSnapshot: buildInspirationConceptBrief({
      result,
      directionIndex: input.directionIndex,
      referenceAssetIds: input.referenceAssetIds,
    }),
    now: new Date(),
  });
  return setDto({ ...input, setId: set.id });
}

export async function createConceptSet(
  input: z.input<typeof createSchema>,
): Promise<ConceptSetDto> {
  const parsed = parseInspirationInput(createSchema, input);
  return mutation(async () => {
    requireEnabled();
    return create(parsed);
  });
}
export async function listConceptSets(
  input: z.input<typeof identitySchema>,
): Promise<ConceptSetDto[]> {
  const parsed = parseInspirationInput(identitySchema, input);
  return mutation(async () => {
    await requireOwnedInspiration(parsed.ownerId, parsed.analysisId);
    return (await repository.listSetDetailsForAnalysis(parsed)).map(
      toConceptSetDto,
    );
  });
}
export async function retryConceptDerivative(
  input: z.input<typeof retrySchema>,
): Promise<ConceptSetDto> {
  const parsed = parseInspirationInput(retrySchema, input);
  return mutation(async () => {
    requireEnabled();
    const analysis = await requireOwnedInspiration(
      parsed.ownerId,
      parsed.analysisId,
    );
    if (analysis.status !== "completed") throw inspirationBusy();
    const existing = await replay(
      parsed,
      repository.conceptRetryOperationKey(parsed),
    );
    if (existing) return existing;
    await ownedSet(parsed);
    await repository.createDerivativeRetry({ ...parsed, now: new Date() });
    return setDto(parsed);
  });
}
export async function regenerateConceptSet(
  input: z.input<typeof regenerateSchema>,
): Promise<ConceptSetDto> {
  const parsed = parseInspirationInput(regenerateSchema, input);
  return mutation(async () => {
    requireEnabled();
    await requireOwnedInspiration(parsed.ownerId, parsed.analysisId);
    const existing = await replay(
      parsed,
      repository.conceptRegenerateOperationKey(parsed),
    );
    if (existing) return existing;
    const source = await ownedSet(parsed);
    const references = await repository.listReferenceIdentities(parsed);
    return create(
      {
        ...parsed,
        directionIndex: source.set.directionIndex,
        visualJobId: references[0]?.jobId ?? null,
        referenceAssetIds: references.map(({ id }) => id),
      },
      parsed.setId,
    );
  });
}
export async function deleteConceptSet(
  input: z.input<typeof setIdentitySchema>,
): Promise<{ id: string; deleted: true }> {
  const parsed = parseInspirationInput(setIdentitySchema, input);
  return mutation(async () => {
    await requireOwnedInspiration(parsed.ownerId, parsed.analysisId);
    await repository.softDeleteSet({ ...parsed, now: new Date() });
    return { id: parsed.setId, deleted: true };
  });
}
