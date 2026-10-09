import "server-only";

import { and, asc, count, eq, ne, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/lib/db/client";
import { patterns, patternTags, tags } from "@/lib/db/schema";

import type { TagColorToken, TagPatch } from "./contracts";

export async function listTagRows(ownerId: string) {
  return db
    .select()
    .from(tags)
    .where(and(eq(tags.ownerId, ownerId), sql`${tags.deletedAt} is null`))
    .orderBy(asc(tags.normalizedName), asc(tags.id));
}

export async function lockTagRow(
  ownerId: string,
  tx: DbTransaction,
  tagId: string,
) {
  const [row] = await tx
    .select()
    .from(tags)
    .where(
      and(
        eq(tags.ownerId, ownerId),
        eq(tags.id, tagId),
        sql`${tags.deletedAt} is null`,
      ),
    )
    .limit(1)
    .for("update");
  return row;
}

export async function insertTagRow(
  ownerId: string,
  tx: DbTransaction,
  input: {
    id: string;
    name: string;
    normalizedName: string;
    colorToken: TagColorToken;
    changeSeq: bigint;
    now: Date;
  },
) {
  const [created] = await tx
    .insert(tags)
    .values({
      id: input.id,
      ownerId,
      name: input.name,
      normalizedName: input.normalizedName,
      colorToken: input.colorToken,
      changeSeq: input.changeSeq,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return created;
}

export async function updateTagRow(
  ownerId: string,
  tx: DbTransaction,
  input: {
    tagId: string;
    patch: TagPatch;
    normalizedName?: string;
    changeSeq: bigint;
    now: Date;
  },
) {
  const [updated] = await tx
    .update(tags)
    .set({
      ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
      ...(input.normalizedName === undefined
        ? {}
        : { normalizedName: input.normalizedName }),
      ...(input.patch.colorToken === undefined
        ? {}
        : { colorToken: input.patch.colorToken }),
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(tags.ownerId, ownerId),
        eq(tags.id, input.tagId),
        sql`${tags.deletedAt} is null`,
      ),
    )
    .returning();
  return updated;
}

export async function softDeleteTagRow(
  ownerId: string,
  tx: DbTransaction,
  input: { tagId: string; changeSeq: bigint; now: Date },
) {
  const [deleted] = await tx
    .update(tags)
    .set({
      deletedAt: input.now,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(tags.ownerId, ownerId),
        eq(tags.id, input.tagId),
        sql`${tags.deletedAt} is null`,
      ),
    )
    .returning({ id: tags.id });
  return deleted;
}

export async function deactivateTagRelations(
  ownerId: string,
  tx: DbTransaction,
  input: { tagId: string; changeSeq: bigint; now: Date },
) {
  return tx
    .update(patternTags)
    .set({
      isActive: false,
      version: sql`${patternTags.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(patternTags.ownerId, ownerId),
        eq(patternTags.tagId, input.tagId),
        eq(patternTags.isActive, true),
      ),
    );
}

export async function lockTaggablePattern(
  ownerId: string,
  tx: DbTransaction,
  patternId: string,
) {
  const [row] = await tx
    .select({ id: patterns.id })
    .from(patterns)
    .where(
      and(
        eq(patterns.ownerId, ownerId),
        eq(patterns.id, patternId),
        ne(patterns.status, "deleted"),
      ),
    )
    .limit(1)
    .for("update");
  return row;
}

export async function lockPatternTagRow(
  ownerId: string,
  tx: DbTransaction,
  patternId: string,
  tagId: string,
) {
  const [row] = await tx
    .select()
    .from(patternTags)
    .where(
      and(
        eq(patternTags.ownerId, ownerId),
        eq(patternTags.patternId, patternId),
        eq(patternTags.tagId, tagId),
      ),
    )
    .limit(1)
    .for("update");
  return row;
}

export async function countActivePatternTags(
  ownerId: string,
  tx: DbTransaction,
  patternId: string,
) {
  const [row] = await tx
    .select({ value: count() })
    .from(patternTags)
    .where(
      and(
        eq(patternTags.ownerId, ownerId),
        eq(patternTags.patternId, patternId),
        eq(patternTags.isActive, true),
      ),
    );
  return row?.value ?? 0;
}

export async function activatePatternTagRow(
  ownerId: string,
  tx: DbTransaction,
  input: {
    patternId: string;
    tagId: string;
    changeSeq: bigint;
    now: Date;
  },
) {
  const [row] = await tx
    .insert(patternTags)
    .values({
      ownerId,
      patternId: input.patternId,
      tagId: input.tagId,
      isActive: true,
      changeSeq: input.changeSeq,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        patternTags.ownerId,
        patternTags.patternId,
        patternTags.tagId,
      ],
      set: {
        isActive: true,
        version: sql`${patternTags.version} + 1`,
        changeSeq: input.changeSeq,
        updatedAt: input.now,
      },
    })
    .returning();
  return row;
}

export async function deactivatePatternTagRow(
  ownerId: string,
  tx: DbTransaction,
  input: {
    patternId: string;
    tagId: string;
    changeSeq: bigint;
    now: Date;
  },
) {
  const [row] = await tx
    .update(patternTags)
    .set({
      isActive: false,
      version: sql`${patternTags.version} + 1`,
      changeSeq: input.changeSeq,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(patternTags.ownerId, ownerId),
        eq(patternTags.patternId, input.patternId),
        eq(patternTags.tagId, input.tagId),
      ),
    )
    .returning();
  return row;
}
