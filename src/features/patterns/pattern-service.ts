import "server-only";

import { z, ZodError } from "zod";

import { db } from "@/lib/db/client";
import { nextChangeSeq } from "@/lib/db/change-seq";
import { changeLog } from "@/lib/db/schema";
import {
  claimOperation,
  createOperationKey,
  storeOperationResult,
} from "@/lib/db/operation";
import { AppError, validationError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";

import {
  patternPatchSchema,
  patternQuerySchema,
  type PatternPatch,
  type PatternQueryInput,
} from "./contracts";
import {
  decodePatternCursor,
  encodePatternCursor,
} from "./pattern-cursor";
import {
  getPatternRow,
  listPatternRows,
  lockPatternRow,
  updatePatternRow,
  type PatternRow,
} from "./pattern-repository";

const mutationIdentitySchema = z.object({
  patternId: z.string().uuid(),
  operationId: publicOperationIdSchema,
});

export type PatternDto = ReturnType<typeof toPatternDto>;

function toPatternDto(row: PatternRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    originalFilename: row.originalFilename,
    extension: row.extension,
    detectedMimeType: row.detectedMimeType,
    sizeBytes: row.sizeBytes.toString(),
    contentHash: row.contentHash,
    status: row.status,
    previewStatus: row.previewStatus,
    isFavorite: row.isFavorite,
    version: row.version,
    commercialVersion: row.commercialVersion,
    lastErrorCode: row.lastErrorCode,
    trashedAt: row.trashedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    changeSeq: row.changeSeq.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseOrValidationError<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) throw validationError();
    throw error;
  }
}

export async function listPatterns(input: {
  ownerId: string;
  input: PatternQueryInput;
}) {
  const parsedQuery = parseOrValidationError(() =>
    patternQuerySchema.parse(input.input),
  );
  const query = {
    ...parsedQuery,
    formats: [...new Set(parsedQuery.formats)],
    tagIds: [...new Set(parsedQuery.tagIds)],
  };
  const cursor = query.cursor
    ? decodePatternCursor(query.cursor, query.sort)
    : undefined;
  const rows = await listPatternRows(input.ownerId, query, cursor);
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);

  return {
    items: page.map(toPatternDto),
    nextCursor:
      hasMore && last ? encodePatternCursor(last, query.sort) : null,
  };
}

export async function getPattern(input: {
  ownerId: string;
  patternId: string;
}) {
  const patternId = parseOrValidationError(() =>
    z.string().uuid().parse(input.patternId),
  );
  const row = await getPatternRow(input.ownerId, patternId);
  if (!row) throw new AppError("NOT_FOUND", 404, "Pattern not found");
  return toPatternDto(row);
}

export async function updatePattern(input: {
  ownerId: string;
  patternId: string;
  operationId: string;
  patch: PatternPatch;
}) {
  const identity = parseOrValidationError(() =>
    mutationIdentitySchema.parse({
      patternId: input.patternId,
      operationId: input.operationId,
    }),
  );
  const patch = parseOrValidationError(() =>
    patternPatchSchema.parse(input.patch),
  );
  const operationKey = createOperationKey("pattern.update", {
    patternId: identity.patternId,
    patch,
  });

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      identity.operationId,
      operationKey,
    );
    if (operation.state === "replay") return operation.result as PatternDto;

    const existing = await lockPatternRow(
      input.ownerId,
      tx,
      identity.patternId,
    );
    if (!existing) {
      throw new AppError("NOT_FOUND", 404, "Pattern not found");
    }
    if (operation.state === "mismatch") {
      throw new AppError(
        "OPERATION_ID_REUSED",
        409,
        "Operation ID was already used",
      );
    }
    if (existing.version !== patch.version) {
      throw new AppError(
        "PATTERN_STATE_CHANGED",
        409,
        "Pattern state changed",
      );
    }

    const seq = await nextChangeSeq(tx, input.ownerId);
    const updated = await updatePatternRow(input.ownerId, tx, {
      patternId: identity.patternId,
      patch,
      changeSeq: seq,
      updatedAt: new Date(),
    });
    if (!updated) {
      throw new AppError(
        "PATTERN_STATE_CHANGED",
        409,
        "Pattern state changed",
      );
    }

    const result = toPatternDto(updated);
    await tx.insert(changeLog).values({
      ownerId: input.ownerId,
      seq,
      operationId: identity.operationId,
      entityType: "pattern",
      entityId: updated.id,
      operation: "pattern.updated",
      payload: { pattern: result },
    });
    await storeOperationResult(
      input.ownerId,
      tx,
      identity.operationId,
      result,
    );
    return result;
  });
}
