import "server-only";

import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";

import { db } from "@/lib/db/client";
import { nextChangeSeq } from "@/lib/db/change-seq";
import { changeLog } from "@/lib/db/schema";
import { claimOperation, storeOperationResult } from "@/lib/db/operation";
import { AppError, validationError } from "@/lib/http/app-error";

import {
  tagCreateSchema,
  tagPatchSchema,
  type TagColorToken,
  type TagPatch,
} from "./contracts";
import {
  activatePatternTagRow,
  countActivePatternTags,
  deactivatePatternTagRow,
  deactivateTagRelations,
  insertTagRow,
  listTagRows,
  lockPatternTagRow,
  lockTaggablePattern,
  lockTagRow,
  softDeleteTagRow,
  updateTagRow,
} from "./tag-repository";

const operationIdSchema = z.string().uuid();
const relationIdentitySchema = z.object({
  operationId: operationIdSchema,
  patternId: z.string().uuid(),
  tagId: z.string().uuid(),
});
const tagIdentitySchema = z.object({
  operationId: operationIdSchema,
  tagId: z.string().uuid(),
});

type TagRow = Awaited<ReturnType<typeof listTagRows>>[number];
type PatternTagRow = NonNullable<
  Awaited<ReturnType<typeof lockPatternTagRow>>
>;

function toTagDto(row: TagRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    normalizedName: row.normalizedName,
    colorToken: row.colorToken as TagColorToken,
    changeSeq: row.changeSeq.toString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPatternTagDto(row: PatternTagRow) {
  return {
    ownerId: row.ownerId,
    patternId: row.patternId,
    tagId: row.tagId,
    isActive: row.isActive,
    version: row.version,
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

function normalizeName(name: string) {
  return name.toLowerCase();
}

function isTagNameConflict(error: unknown) {
  const candidate =
    typeof error === "object" && error !== null && "cause" in error
      ? error.cause
      : error;

  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "code" in candidate &&
    candidate.code === "23505" &&
    (!("constraint_name" in candidate) ||
      candidate.constraint_name ===
        "tags_owner_normalized_name_active_unique")
  );
}

function tagNotFound(): never {
  throw new AppError("NOT_FOUND", 404, "Tag not found");
}

async function writeChange(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    ownerId: string;
    seq: bigint;
    operationId: string;
    entityType: "tag" | "pattern_tag";
    entityId: string;
    operation: string;
    payload: Record<string, unknown>;
  },
) {
  await tx.insert(changeLog).values(input);
}

export async function listTags(input: { ownerId: string }) {
  return (await listTagRows(input.ownerId)).map(toTagDto);
}

export async function createTag(input: {
  ownerId: string;
  operationId: string;
  name: string;
  colorToken: string;
}) {
  const operationId = parseOrValidationError(() =>
    operationIdSchema.parse(input.operationId),
  );
  const create = parseOrValidationError(() =>
    tagCreateSchema.parse({ name: input.name, colorToken: input.colorToken }),
  );

  try {
    return await db.transaction(async (tx) => {
      const operation = await claimOperation(
        input.ownerId,
        tx,
        operationId,
        "tag.create",
      );
      if (!operation.claimed) return operation.result as ReturnType<typeof toTagDto>;

      const seq = await nextChangeSeq(tx, input.ownerId);
      const created = await insertTagRow(input.ownerId, tx, {
        id: randomUUID(),
        name: create.name,
        normalizedName: normalizeName(create.name),
        colorToken: create.colorToken,
        changeSeq: seq,
        now: new Date(),
      });
      if (!created) throw new Error("TAG_CREATE_FAILED");

      const result = toTagDto(created);
      await writeChange(tx, {
        ownerId: input.ownerId,
        seq,
        operationId,
        entityType: "tag",
        entityId: created.id,
        operation: "tag.created",
        payload: { tag: result },
      });
      await storeOperationResult(input.ownerId, tx, operationId, result);
      return result;
    });
  } catch (error) {
    if (isTagNameConflict(error)) {
      throw new AppError("TAG_NAME_CONFLICT", 409, "Tag name already exists");
    }
    throw error;
  }
}

export async function updateTag(input: {
  ownerId: string;
  tagId: string;
  operationId: string;
  patch: TagPatch;
}) {
  const identity = parseOrValidationError(() =>
    tagIdentitySchema.parse({
      tagId: input.tagId,
      operationId: input.operationId,
    }),
  );
  const patch = parseOrValidationError(() => tagPatchSchema.parse(input.patch));

  try {
    return await db.transaction(async (tx) => {
      const operation = await claimOperation(
        input.ownerId,
        tx,
        identity.operationId,
        "tag.update",
      );
      if (!operation.claimed) return operation.result as ReturnType<typeof toTagDto>;

      const existing = await lockTagRow(input.ownerId, tx, identity.tagId);
      if (!existing) return tagNotFound();

      const seq = await nextChangeSeq(tx, input.ownerId);
      const updated = await updateTagRow(input.ownerId, tx, {
        tagId: identity.tagId,
        patch,
        normalizedName:
          patch.name === undefined ? undefined : normalizeName(patch.name),
        changeSeq: seq,
        now: new Date(),
      });
      if (!updated) return tagNotFound();

      const result = toTagDto(updated);
      await writeChange(tx, {
        ownerId: input.ownerId,
        seq,
        operationId: identity.operationId,
        entityType: "tag",
        entityId: updated.id,
        operation: "tag.updated",
        payload: { tag: result },
      });
      await storeOperationResult(
        input.ownerId,
        tx,
        identity.operationId,
        result,
      );
      return result;
    });
  } catch (error) {
    if (isTagNameConflict(error)) {
      throw new AppError("TAG_NAME_CONFLICT", 409, "Tag name already exists");
    }
    throw error;
  }
}

export async function deleteTag(input: {
  ownerId: string;
  tagId: string;
  operationId: string;
}) {
  const identity = parseOrValidationError(() =>
    tagIdentitySchema.parse({
      tagId: input.tagId,
      operationId: input.operationId,
    }),
  );

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      identity.operationId,
      "tag.delete",
    );
    if (!operation.claimed) {
      return operation.result as { id: string; deleted: true };
    }

    const existing = await lockTagRow(input.ownerId, tx, identity.tagId);
    if (!existing) return tagNotFound();

    const seq = await nextChangeSeq(tx, input.ownerId);
    const now = new Date();
    const deleted = await softDeleteTagRow(input.ownerId, tx, {
      tagId: identity.tagId,
      changeSeq: seq,
      now,
    });
    if (!deleted) return tagNotFound();
    await deactivateTagRelations(input.ownerId, tx, {
      tagId: identity.tagId,
      changeSeq: seq,
      now,
    });

    const result = { id: deleted.id, deleted: true as const };
    await writeChange(tx, {
      ownerId: input.ownerId,
      seq,
      operationId: identity.operationId,
      entityType: "tag",
      entityId: deleted.id,
      operation: "tag.deleted",
      payload: result,
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

async function assertOwnedRelationTargets(
  ownerId: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  patternId: string,
  tagId: string,
) {
  const pattern = await lockTaggablePattern(ownerId, tx, patternId);
  if (!pattern) {
    throw new AppError("NOT_FOUND", 404, "Pattern or tag not found");
  }
  const tag = await lockTagRow(ownerId, tx, tagId);
  if (!tag) {
    throw new AppError("NOT_FOUND", 404, "Pattern or tag not found");
  }
}

export async function addTagToPattern(input: {
  ownerId: string;
  patternId: string;
  tagId: string;
  operationId: string;
}) {
  const identity = parseOrValidationError(() =>
    relationIdentitySchema.parse(input),
  );

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      identity.operationId,
      "pattern_tag.add",
    );
    if (!operation.claimed) {
      return operation.result as ReturnType<typeof toPatternTagDto>;
    }

    await assertOwnedRelationTargets(
      input.ownerId,
      tx,
      identity.patternId,
      identity.tagId,
    );
    const existing = await lockPatternTagRow(
      input.ownerId,
      tx,
      identity.patternId,
      identity.tagId,
    );
    if (!existing?.isActive) {
      const count = await countActivePatternTags(
        input.ownerId,
        tx,
        identity.patternId,
      );
      if (count >= 20) {
        throw new AppError(
          "TAG_LIMIT_EXCEEDED",
          409,
          "A pattern can have at most 20 tags",
        );
      }
    }

    const seq = await nextChangeSeq(tx, input.ownerId);
    const relation = await activatePatternTagRow(input.ownerId, tx, {
      patternId: identity.patternId,
      tagId: identity.tagId,
      changeSeq: seq,
      now: new Date(),
    });
    if (!relation) throw new Error("PATTERN_TAG_ADD_FAILED");

    const result = toPatternTagDto(relation);
    await writeChange(tx, {
      ownerId: input.ownerId,
      seq,
      operationId: identity.operationId,
      entityType: "pattern_tag",
      entityId: identity.patternId,
      operation: "pattern_tag.added",
      payload: result,
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

export async function removeTagFromPattern(input: {
  ownerId: string;
  patternId: string;
  tagId: string;
  operationId: string;
}) {
  const identity = parseOrValidationError(() =>
    relationIdentitySchema.parse(input),
  );

  return db.transaction(async (tx) => {
    const operation = await claimOperation(
      input.ownerId,
      tx,
      identity.operationId,
      "pattern_tag.remove",
    );
    if (!operation.claimed) {
      return operation.result as ReturnType<typeof toPatternTagDto>;
    }

    await assertOwnedRelationTargets(
      input.ownerId,
      tx,
      identity.patternId,
      identity.tagId,
    );
    const existing = await lockPatternTagRow(
      input.ownerId,
      tx,
      identity.patternId,
      identity.tagId,
    );
    if (!existing) {
      throw new AppError("NOT_FOUND", 404, "Pattern tag not found");
    }

    const seq = await nextChangeSeq(tx, input.ownerId);
    const relation = await deactivatePatternTagRow(input.ownerId, tx, {
      patternId: identity.patternId,
      tagId: identity.tagId,
      changeSeq: seq,
      now: new Date(),
    });
    if (!relation) {
      throw new AppError("NOT_FOUND", 404, "Pattern tag not found");
    }

    const result = toPatternTagDto(relation);
    await writeChange(tx, {
      ownerId: input.ownerId,
      seq,
      operationId: identity.operationId,
      entityType: "pattern_tag",
      entityId: identity.patternId,
      operation: "pattern_tag.removed",
      payload: result,
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
