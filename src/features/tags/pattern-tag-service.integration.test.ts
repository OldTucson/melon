import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  addTagToPattern,
  createTag,
  listPatternTags,
  removeTagFromPattern,
} from "@/features/tags/tag-service";
import { closeDatabase, db } from "@/lib/db/client";
import { patterns, users } from "@/lib/db/schema";
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

const seedPattern = async (ownerId: string, name: string) => {
  const id = randomUUID();
  await db.insert(patterns).values({
    id,
    ownerId,
    name,
    originalFilename: `${name}.psd`,
    extension: "psd",
    sizeBytes: 1024n,
    status: "ready",
  });
  return id;
};

describe("pattern tag read service", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = await seedUser("pattern-tags-a@example.test");
    ownerB = await seedUser("pattern-tags-b@example.test");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("lists only active relations for an owned non-deleted pattern", async () => {
    const patternId = await seedPattern(ownerA, "Owned");
    const activeTag = await createTag({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Active",
      colorToken: "green",
    });
    const inactiveTag = await createTag({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Inactive",
      colorToken: "blue",
    });
    const active = await addTagToPattern({
      ownerId: ownerA,
      patternId,
      tagId: activeTag.id,
      operationId: randomUUID(),
    });
    await addTagToPattern({
      ownerId: ownerA,
      patternId,
      tagId: inactiveTag.id,
      operationId: randomUUID(),
    });
    await removeTagFromPattern({
      ownerId: ownerA,
      patternId,
      tagId: inactiveTag.id,
      operationId: randomUUID(),
    });

    await expect(
      listPatternTags({ ownerId: ownerA, patternId }),
    ).resolves.toEqual({ items: [active] });
  });

  it("returns the same 404 for a foreign, unknown, or deleted pattern", async () => {
    const foreignPattern = await seedPattern(ownerB, "Foreign");
    const deletedPattern = await seedPattern(ownerA, "Deleted");
    await db
      .update(patterns)
      .set({ status: "deleted", deletedAt: new Date() })
      .where(eq(patterns.id, deletedPattern));

    for (const patternId of [foreignPattern, randomUUID(), deletedPattern]) {
      await expect(
        listPatternTags({ ownerId: ownerA, patternId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
  });
});
