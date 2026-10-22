import "server-only";

import { z, ZodError } from "zod";

import { db } from "@/lib/db/client";
import { nextChangeSeq } from "@/lib/db/change-seq";
import {
  changeLog,
  patternStatuses,
  previewStatuses,
} from "@/lib/db/schema";
import {
  claimOperation,
  createOperationKey,
  storeOperationResult,
} from "@/lib/db/operation";
import { AppError, validationError } from "@/lib/http/app-error";
import { publicOperationIdSchema } from "@/lib/validation/operation-id";
import { normalizedUuidSchema } from "@/features/storage/identifiers";
import { getActiveVisualSearchIndexVersion } from "@/features/image-search/index-service";

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
  type PatternRowWithAssets,
  type PatternRowWithAssetsAndCommercial,
} from "./pattern-repository";
import {
  loadPatternPaletteStates,
  withPalette,
} from "./pattern-palette-repository";

const mutationIdentitySchema = z.object({
  patternId: normalizedUuidSchema,
  operationId: publicOperationIdSchema,
});
const editablePatternStatuses = new Set(["ready", "failed"] as const);

const optionalNullableUuidSchema = normalizedUuidSchema
  .nullish()
  .transform((value) => value ?? null);
const patternStatusSchema = z.enum(patternStatuses);
const replayPatternDtoSchema = z.object({
  id: normalizedUuidSchema,
  ownerId: normalizedUuidSchema,
  name: z.string(),
  originalFilename: z.string(),
  extension: z.string(),
  detectedMimeType: z.string().nullable(),
  sizeBytes: z.string().regex(/^(0|[1-9]\d*)$/),
  contentHash: z.string().nullable(),
  status: patternStatusSchema,
  folderId: optionalNullableUuidSchema,
  trashBatchId: optionalNullableUuidSchema,
  preTrashStatus: patternStatusSchema.nullish().transform((value) => value ?? null),
  previewStatus: z.enum(previewStatuses),
  previewAssetId: normalizedUuidSchema.nullable(),
  thumbnailAssetId: normalizedUuidSchema.nullable(),
  sourceAssetId: normalizedUuidSchema.nullable(),
  isFavorite: z.boolean(),
  version: z.number().int().nonnegative(),
  commercialVersion: z.number().int().nonnegative(),
  paletteStatus: z.enum(["pending", "ready", "failed"]),
  palette: z
    .array(
      z
        .object({
          hex: z.string().regex(/^#[0-9A-F]{6}$/),
          coverage: z.number().finite().positive().max(1),
        })
        .strict(),
    )
    .max(5),
  lastErrorCode: z.string().nullable(),
  trashedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
  changeSeq: z.string().regex(/^(0|[1-9]\d*)$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type PatternDto = ReturnType<typeof toPatternDto>;

function normalizePatternReplayResult(
  result: unknown,
  identity: { ownerId: string; patternId: string },
): PatternDto {
  const parsed = replayPatternDtoSchema.safeParse(result);
  if (
    !parsed.success ||
    parsed.data.ownerId !== identity.ownerId ||
    parsed.data.id !== identity.patternId
  ) {
    throw new AppError(
      "INTERNAL_ERROR",
      500,
      "Stored pattern operation result is invalid",
    );
  }
  return parsed.data;
}

export function toPatternDto(row: PatternRow | PatternRowWithAssets) {
  return withPalette({
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    originalFilename: row.originalFilename,
    extension: row.extension,
    detectedMimeType: row.detectedMimeType,
    sizeBytes: row.sizeBytes.toString(),
    contentHash: row.contentHash,
    status: row.status,
    folderId: row.folderId,
    trashBatchId: row.trashBatchId,
    preTrashStatus: row.preTrashStatus,
    previewStatus: row.previewStatus,
    previewAssetId: "previewAssetId" in row ? row.previewAssetId : null,
    thumbnailAssetId: "thumbnailAssetId" in row ? row.thumbnailAssetId : null,
    sourceAssetId: "sourceAssetId" in row ? row.sourceAssetId : null,
    isFavorite: row.isFavorite,
    version: row.version,
    commercialVersion: row.commercialVersion,
    lastErrorCode: row.lastErrorCode,
    trashedAt: row.trashedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    changeSeq: row.changeSeq.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toPatternListItemDto(row: PatternRowWithAssetsAndCommercial) {
  return {
    ...toPatternDto(row),
    commercialSummary: {
      state: row.hasActiveBuyout
        ? ("global_buyout" as const)
        : row.hasActiveExclusive
          ? ("field_exclusive" as const)
          : row.authorizationCount > 0
            ? ("standard" as const)
            : ("unlicensed" as const),
      activeCount: row.authorizationCount,
      revenueFen: row.authorizationRevenueFen,
    },
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
  const paletteStates = await loadPatternPaletteStates({
    ownerId: input.ownerId,
    patternIds: page.map((row) => row.id),
    indexVersion: getActiveVisualSearchIndexVersion(),
  });

  return {
    items: page.map((row) =>
      withPalette(toPatternListItemDto(row), paletteStates.get(row.id)),
    ),
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
  const paletteStates = await loadPatternPaletteStates({
    ownerId: input.ownerId,
    patternIds: [row.id],
    indexVersion: getActiveVisualSearchIndexVersion(),
  });
  return withPalette(toPatternDto(row), paletteStates.get(row.id));
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
    if (operation.state === "replay") {
      return normalizePatternReplayResult(operation.result, {
        ownerId: input.ownerId,
        patternId: identity.patternId,
      });
    }

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
    if (
      existing.version !== patch.version ||
      !editablePatternStatuses.has(existing.status as "ready" | "failed")
    ) {
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

    const paletteStates = await loadPatternPaletteStates({
      ownerId: input.ownerId,
      patternIds: [updated.id],
      indexVersion: getActiveVisualSearchIndexVersion(),
      executor: tx,
    });
    const result = withPalette(
      toPatternDto(updated),
      paletteStates.get(updated.id),
    );
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
