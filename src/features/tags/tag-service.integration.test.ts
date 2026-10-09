import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  addTagToPattern,
  createTag,
  deleteTag,
  listTags,
  removeTagFromPattern,
  updateTag,
} from "@/features/tags/tag-service";
import { closeDatabase, db } from "@/lib/db/client";
import {
  changeLog,
  operations,
  patterns,
  patternTags,
  users,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const seedUser = async (email: string) => {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email,
    displayName: email,
    passwordHash: "test-password-hash",
    mustChangePassword: false,
  });
  return id;
};

const seedPattern = async (ownerId: string) => {
  const id = randomUUID();
  await db.insert(patterns).values({
    id,
    ownerId,
    name: "Pattern",
    originalFilename: "pattern.psd",
    extension: "psd",
    sizeBytes: 1024n,
    status: "ready",
  });
  return id;
};

const countOwnerChanges = async (ownerId: string) =>
  db
    .select()
    .from(changeLog)
    .where(eq(changeLog.ownerId, ownerId));

describe("tag service", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = await seedUser("tags-a@example.test");
    ownerB = await seedUser("tags-b@example.test");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("trims display names, normalizes lowercase names, and replays create operations exactly", async () => {
    const operationId = randomUUID();
    const created = await createTag({
      ownerId: ownerA,
      operationId,
      name: "  Summer  ",
      colorToken: "green",
    });
    const replay = await createTag({
      ownerId: ownerA,
      operationId,
      name: "Different request body",
      colorToken: "red",
    });

    expect(created).toMatchObject({
      ownerId: ownerA,
      name: "Summer",
      normalizedName: "summer",
      colorToken: "green",
    });
    expect(replay).toEqual(created);
    expect(await countOwnerChanges(ownerA)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(operations)
        .where(eq(operations.ownerId, ownerA)),
    ).toHaveLength(1);
    const [owner] = await db
      .select({ syncSeq: users.syncSeq })
      .from(users)
      .where(eq(users.id, ownerA));
    expect(owner?.syncSeq).toBe(1n);
  });

  it("enforces active case-insensitive uniqueness per owner with stable conflicts", async () => {
    const summer = await createTag({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Summer",
      colorToken: "green",
    });
    const autumn = await createTag({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Autumn",
      colorToken: "yellow",
    });

    await expect(
      createTag({
        ownerId: ownerA,
        operationId: randomUUID(),
        name: " SUMMER ",
        colorToken: "blue",
      }),
    ).rejects.toMatchObject({ code: "TAG_NAME_CONFLICT", status: 409 });
    await expect(
      updateTag({
        ownerId: ownerA,
        tagId: autumn.id,
        operationId: randomUUID(),
        patch: { name: " SUMMER " },
      }),
    ).rejects.toMatchObject({ code: "TAG_NAME_CONFLICT", status: 409 });
    await expect(
      createTag({
        ownerId: ownerB,
        operationId: randomUUID(),
        name: "SUMMER",
        colorToken: "blue",
      }),
    ).resolves.toMatchObject({ ownerId: ownerB, normalizedName: "summer" });

    await deleteTag({
      ownerId: ownerA,
      tagId: summer.id,
      operationId: randomUUID(),
    });
    await expect(
      createTag({
        ownerId: ownerA,
        operationId: randomUUID(),
        name: "summer",
        colorToken: "blue",
      }),
    ).resolves.toMatchObject({ ownerId: ownerA, normalizedName: "summer" });
  });

  it("rejects reuse of one operation ID for a different mutation kind", async () => {
    const operationId = randomUUID();
    const tag = await createTag({
      ownerId: ownerA,
      operationId,
      name: "One operation",
      colorToken: "gray",
    });

    await expect(
      updateTag({
        ownerId: ownerA,
        tagId: tag.id,
        operationId,
        patch: { name: "Should not change" },
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    await expect(listTags({ ownerId: ownerA })).resolves.toMatchObject([
      { id: tag.id, name: "One operation" },
    ]);
  });

  it("validates the fixed color palette and 1-32 character trimmed tag names", async () => {
    for (const input of [
      { name: "", colorToken: "green" },
      { name: "x".repeat(33), colorToken: "green" },
      { name: "Valid", colorToken: "chartreuse" },
    ]) {
      await expect(
        createTag({
          ownerId: ownerA,
          operationId: randomUUID(),
          ...input,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    }
  });

  it("lists, renames, recolors, and soft-deletes only owned active tags", async () => {
    const owned = await createTag({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "First",
      colorToken: "green",
    });
    await createTag({
      ownerId: ownerB,
      operationId: randomUUID(),
      name: "Foreign",
      colorToken: "red",
    });

    const updated = await updateTag({
      ownerId: ownerA,
      tagId: owned.id,
      operationId: randomUUID(),
      patch: { name: "  Renamed ", colorToken: "purple" },
    });
    expect(updated).toMatchObject({
      id: owned.id,
      name: "Renamed",
      normalizedName: "renamed",
      colorToken: "purple",
    });
    expect(await listTags({ ownerId: ownerA })).toHaveLength(1);

    const removed = await deleteTag({
      ownerId: ownerA,
      tagId: owned.id,
      operationId: randomUUID(),
    });
    expect(removed).toEqual({ id: owned.id, deleted: true });
    expect(await listTags({ ownerId: ownerA })).toEqual([]);

    await expect(
      updateTag({
        ownerId: ownerA,
        tagId: owned.id,
        operationId: randomUUID(),
        patch: { name: "Again" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      deleteTag({
        ownerId: ownerB,
        tagId: owned.id,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("deactivates owned relations when deleting a tag", async () => {
    const patternId = await seedPattern(ownerA);
    const tag = await createTag({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Attached",
      colorToken: "blue",
    });
    await addTagToPattern({
      ownerId: ownerA,
      patternId,
      tagId: tag.id,
      operationId: randomUUID(),
    });

    await deleteTag({
      ownerId: ownerA,
      tagId: tag.id,
      operationId: randomUUID(),
    });

    const [relation] = await db
      .select({ isActive: patternTags.isActive })
      .from(patternTags)
      .where(
        and(
          eq(patternTags.ownerId, ownerA),
          eq(patternTags.patternId, patternId),
          eq(patternTags.tagId, tag.id),
        ),
      );
    expect(relation?.isActive).toBe(false);
  });

  it("accepts the twentieth active tag and rejects the twenty-first", async () => {
    const patternId = await seedPattern(ownerA);
    const created = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        createTag({
          ownerId: ownerA,
          operationId: randomUUID(),
          name: `Tag ${index + 1}`,
          colorToken: "green",
        }),
      ),
    );

    for (const tag of created.slice(0, 20)) {
      await expect(
        addTagToPattern({
          ownerId: ownerA,
          patternId,
          tagId: tag.id,
          operationId: randomUUID(),
        }),
      ).resolves.toMatchObject({ patternId, tagId: tag.id, isActive: true });
    }
    await expect(
      addTagToPattern({
        ownerId: ownerA,
        patternId,
        tagId: created[20]!.id,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "TAG_LIMIT_EXCEEDED", status: 409 });
    await expect(
      addTagToPattern({
        ownerId: ownerA,
        patternId,
        tagId: created[0]!.id,
        operationId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      patternId,
      tagId: created[0]!.id,
      isActive: true,
    });

    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::text as count
      from pattern_tags
      where owner_id = ${ownerA}
        and pattern_id = ${patternId}
        and is_active = true
    `);
    expect(rows[0]?.count).toBe("20");
  });

  it("serializes concurrent additions so the active count never exceeds twenty", async () => {
    const patternId = await seedPattern(ownerA);
    const existing = await Promise.all(
      Array.from({ length: 19 }, (_, index) =>
        createTag({
          ownerId: ownerA,
          operationId: randomUUID(),
          name: `Existing ${index}`,
          colorToken: "gray",
        }),
      ),
    );
    for (const tag of existing) {
      await addTagToPattern({
        ownerId: ownerA,
        patternId,
        tagId: tag.id,
        operationId: randomUUID(),
      });
    }
    const contenders = await Promise.all(
      ["Contender A", "Contender B"].map((name) =>
        createTag({
          ownerId: ownerA,
          operationId: randomUUID(),
          name,
          colorToken: "blue",
        }),
      ),
    );

    const outcomes = await Promise.allSettled(
      contenders.map((tag) =>
        addTagToPattern({
          ownerId: ownerA,
          patternId,
          tagId: tag.id,
          operationId: randomUUID(),
        }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejection = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejection?.reason).toMatchObject({
      code: "TAG_LIMIT_EXCEEDED",
      status: 409,
    });
    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::text as count
      from pattern_tags
      where owner_id = ${ownerA}
        and pattern_id = ${patternId}
        and is_active = true
    `);
    expect(rows[0]?.count).toBe("20");
  });

  it("keeps relation mutations tenant-safe, replayable, and independently reversible", async () => {
    const ownedPattern = await seedPattern(ownerA);
    const foreignPattern = await seedPattern(ownerB);
    const ownedTag = await createTag({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Owned",
      colorToken: "blue",
    });
    const foreignTag = await createTag({
      ownerId: ownerB,
      operationId: randomUUID(),
      name: "Foreign",
      colorToken: "red",
    });
    const addOperationId = randomUUID();

    const added = await addTagToPattern({
      ownerId: ownerA,
      patternId: ownedPattern,
      tagId: ownedTag.id,
      operationId: addOperationId,
    });
    const replay = await addTagToPattern({
      ownerId: ownerA,
      patternId: ownedPattern,
      tagId: ownedTag.id,
      operationId: addOperationId,
    });
    expect(replay).toEqual(added);

    const removed = await removeTagFromPattern({
      ownerId: ownerA,
      patternId: ownedPattern,
      tagId: ownedTag.id,
      operationId: randomUUID(),
    });
    expect(removed).toMatchObject({ isActive: false, version: 1 });

    for (const input of [
      { patternId: foreignPattern, tagId: ownedTag.id },
      { patternId: ownedPattern, tagId: foreignTag.id },
      { patternId: randomUUID(), tagId: ownedTag.id },
      { patternId: ownedPattern, tagId: randomUUID() },
    ]) {
      await expect(
        addTagToPattern({
          ownerId: ownerA,
          operationId: randomUUID(),
          ...input,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
  });
});
