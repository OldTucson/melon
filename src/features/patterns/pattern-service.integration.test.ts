import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  getPattern,
  listPatterns,
  updatePattern,
} from "@/features/patterns/pattern-service";
import { closeDatabase, db } from "@/lib/db/client";
import {
  changeLog,
  operations,
  patterns,
  patternTags,
  tags,
  users,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

type SeedPattern = {
  id?: string;
  ownerId: string;
  name: string;
  originalFilename?: string;
  extension?: "psd" | "ai" | "jpg" | "jpeg" | "png" | "procreate";
  sizeBytes?: bigint;
  status?: "draft" | "ready" | "trashed" | "deleted";
  previewStatus?: "pending" | "ready" | "unsupported" | "failed" | "manual";
  isFavorite?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

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

const seedPattern = async (input: SeedPattern) => {
  const id = input.id ?? randomUUID();
  const extension = input.extension ?? "psd";
  await db.insert(patterns).values({
    id,
    ownerId: input.ownerId,
    name: input.name,
    originalFilename: input.originalFilename ?? `${input.name}.${extension}`,
    extension,
    sizeBytes: input.sizeBytes ?? 1024n,
    status: input.status ?? "ready",
    previewStatus: input.previewStatus ?? "ready",
    isFavorite: input.isFavorite ?? false,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  return id;
};

const seedTag = async (ownerId: string, name: string) => {
  const id = randomUUID();
  await db.insert(tags).values({
    id,
    ownerId,
    name,
    normalizedName: name.toLowerCase(),
    colorToken: "green",
  });
  return id;
};

describe("pattern service", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = await seedUser("patterns-a@example.test");
    ownerB = await seedUser("patterns-b@example.test");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("scopes list and detail reads to the authenticated owner", async () => {
    const first = await seedPattern({ ownerId: ownerA, name: "First" });
    const second = await seedPattern({ ownerId: ownerA, name: "Second" });
    const foreign = await seedPattern({ ownerId: ownerB, name: "Foreign" });

    const listed = await listPatterns({ ownerId: ownerA, input: {} });
    expect(listed.items.map((item) => item.id).sort()).toEqual(
      [first, second].sort(),
    );
    expect(listed.items).toHaveLength(2);
    await expect(
      getPattern({ ownerId: ownerA, patternId: foreign }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      getPattern({ ownerId: ownerA, patternId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it.each([
    ["updated_desc", "updatedAt", false],
    ["created_desc", "createdAt", false],
    ["name_asc", "name", true],
    ["size_desc", "sizeBytes", false],
  ] as const)(
    "uses a deterministic UUID tie-breaker for %s",
    async (sort, field, ascending) => {
      const lowId = "00000000-0000-4000-8000-000000000001";
      const highId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
      const sameTime = new Date("2026-04-05T06:07:08.000Z");
      const common = {
        ownerId: ownerA,
        name: field === "name" ? "Same" : "Pattern",
        sizeBytes: 4096n,
        createdAt: sameTime,
        updatedAt: sameTime,
      };
      await seedPattern({ ...common, id: lowId });
      await seedPattern({ ...common, id: highId });

      const firstPage = await listPatterns({
        ownerId: ownerA,
        input: { sort, limit: 1 },
      });
      const secondPage = await listPatterns({
        ownerId: ownerA,
        input: { sort, limit: 1, cursor: firstPage.nextCursor! },
      });

      expect(firstPage.items[0]?.id).toBe(ascending ? lowId : highId);
      expect(secondPage.items[0]?.id).toBe(ascending ? highId : lowId);
      expect(secondPage.nextCursor).toBeNull();
    },
  );

  it("pages 31 equal-timestamp rows as 20 plus 11 without duplicates or omissions", async () => {
    const sameTime = new Date("2026-05-06T07:08:09.000Z");
    const ids = Array.from({ length: 31 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    await db.insert(patterns).values(
      ids.map((id, index) => ({
        id,
        ownerId: ownerA,
        name: `Equal ${index}`,
        originalFilename: `equal-${index}.psd`,
        extension: "psd",
        sizeBytes: 1n,
        status: "ready" as const,
        previewStatus: "ready" as const,
        createdAt: sameTime,
        updatedAt: sameTime,
      })),
    );
    await db.execute(sql`
      update patterns
      set updated_at = '2026-05-06T07:08:09.123456Z'::timestamptz
      where owner_id = ${ownerA}
    `);

    const first = await listPatterns({
      ownerId: ownerA,
      input: { sort: "updated_desc", limit: 20 },
    });
    const second = await listPatterns({
      ownerId: ownerA,
      input: {
        sort: "updated_desc",
        limit: 20,
        cursor: first.nextCursor!,
      },
    });
    const seen = [...first.items, ...second.items].map((item) => item.id);

    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(11);
    expect(second.nextCursor).toBeNull();
    expect(new Set(seen).size).toBe(31);
    expect(seen.sort()).toEqual(ids.sort());
  });

  it("preserves microsecond timestamp order instead of collapsing it into the UUID tie-breaker", async () => {
    const newerLowId = "00000000-0000-4000-8000-000000000001";
    const olderHighId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    await seedPattern({
      id: newerLowId,
      ownerId: ownerA,
      name: "Newer",
    });
    await seedPattern({
      id: olderHighId,
      ownerId: ownerA,
      name: "Older",
    });
    await db.execute(sql`
      update patterns
      set updated_at = case id
        when ${newerLowId}::uuid then '2026-05-06T07:08:09.123456Z'::timestamptz
        else '2026-05-06T07:08:09.123123Z'::timestamptz
      end
      where owner_id = ${ownerA}
    `);

    const first = await listPatterns({
      ownerId: ownerA,
      input: { sort: "updated_desc", limit: 1 },
    });
    const second = await listPatterns({
      ownerId: ownerA,
      input: {
        sort: "updated_desc",
        limit: 1,
        cursor: first.nextCursor!,
      },
    });

    expect(first.items[0]?.id).toBe(newerLowId);
    expect(second.items[0]?.id).toBe(olderHighId);
  });

  it("rejects malformed, mistyped, and cross-sort cursors deterministically", async () => {
    await seedPattern({ ownerId: ownerA, name: "Cursor" });
    await seedPattern({ ownerId: ownerA, name: "Cursor second" });
    const first = await listPatterns({
      ownerId: ownerA,
      input: { sort: "updated_desc", limit: 1 },
    });
    const wrongValue = Buffer.from(
      JSON.stringify({
        sort: "updated_desc",
        value: 123,
        id: randomUUID(),
      }),
    ).toString("base64url");
    const wrongId = Buffer.from(
      JSON.stringify({ sort: "name_asc", value: "Cursor", id: "not-a-uuid" }),
    ).toString("base64url");
    const wrongDate = Buffer.from(
      JSON.stringify({
        sort: "updated_desc",
        value: "2026-02-31T07:08:09.123456Z",
        id: randomUUID(),
      }),
    ).toString("base64url");
    const outOfRangeSize = Buffer.from(
      JSON.stringify({
        sort: "size_desc",
        value: "9223372036854775808",
        id: randomUUID(),
      }),
    ).toString("base64url");

    for (const input of [
      { sort: "updated_desc" as const, cursor: "not-json" },
      { sort: "updated_desc" as const, cursor: wrongValue },
      { sort: "updated_desc" as const, cursor: wrongDate },
      { sort: "size_desc" as const, cursor: outOfRangeSize },
      { sort: "name_asc" as const, cursor: wrongId },
      { sort: "name_asc" as const, cursor: first.nextCursor! },
    ]) {
      await expect(
        listPatterns({ ownerId: ownerA, input }),
      ).rejects.toMatchObject({ code: "INVALID_CURSOR", status: 400 });
    }
  });

  it("treats percent, underscore, and backslash as literal ILIKE search text", async () => {
    await Promise.all(
      [
        "100% silk",
        "100X silk",
        "under_score",
        "underXscore",
        "back\\slash",
        "backXslash",
      ].map((name) => seedPattern({ ownerId: ownerA, name })),
    );

    await expect(
      listPatterns({ ownerId: ownerA, input: { q: "%" } }),
    ).resolves.toMatchObject({ items: [{ name: "100% silk" }] });
    await expect(
      listPatterns({ ownerId: ownerA, input: { q: "_" } }),
    ).resolves.toMatchObject({ items: [{ name: "under_score" }] });
    await expect(
      listPatterns({ ownerId: ownerA, input: { q: "\\" } }),
    ).resolves.toMatchObject({ items: [{ name: "back\\slash" }] });

    await seedPattern({
      ownerId: ownerA,
      name: "Filename hit",
      originalFilename: "source_name.psd",
    });
    await seedPattern({
      ownerId: ownerA,
      name: "Filename decoy",
      originalFilename: "sourceXname.psd",
    });
    await expect(
      listPatterns({ ownerId: ownerA, input: { q: "source_name" } }),
    ).resolves.toMatchObject({ items: [{ name: "Filename hit" }] });
  });

  it("combines format, all/any tags, favorite, preview, deleted exclusion, sort, and limit safely", async () => {
    const summer = await seedTag(ownerA, "Summer");
    const floral = await seedTag(ownerA, "Floral");
    const foreignTag = await seedTag(ownerB, "Foreign");
    const matchesBoth = await seedPattern({
      ownerId: ownerA,
      name: "B match",
      extension: "png",
      isFavorite: true,
      previewStatus: "manual",
    });
    const matchesOne = await seedPattern({
      ownerId: ownerA,
      name: "A match",
      extension: "png",
      isFavorite: true,
      previewStatus: "manual",
    });
    await seedPattern({
      ownerId: ownerA,
      name: "Deleted",
      extension: "png",
      isFavorite: true,
      previewStatus: "manual",
      status: "deleted",
    });
    await db.insert(patternTags).values([
      { ownerId: ownerA, patternId: matchesBoth, tagId: summer },
      { ownerId: ownerA, patternId: matchesBoth, tagId: floral },
      { ownerId: ownerA, patternId: matchesOne, tagId: summer },
      {
        ownerId: ownerA,
        patternId: matchesOne,
        tagId: floral,
        isActive: false,
      },
    ]);

    const all = await listPatterns({
      ownerId: ownerA,
      input: {
        formats: ["png"],
        tagIds: [summer, floral],
        tagMode: "all",
        favorite: true,
        previewStatus: "manual",
        sort: "name_asc",
        limit: 10,
      },
    });
    expect(all.items.map((item) => item.id)).toEqual([matchesBoth]);

    const any = await listPatterns({
      ownerId: ownerA,
      input: {
        tagIds: [foreignTag, summer],
        tagMode: "any",
        sort: "name_asc",
        limit: 1,
      },
    });
    expect(any.items).toHaveLength(1);
    expect(any.items[0]?.id).toBe(matchesOne);
    expect(any.nextCursor).not.toBeNull();

    const duplicateAll = await listPatterns({
      ownerId: ownerA,
      input: { tagIds: [summer, summer], tagMode: "all" },
    });
    expect(duplicateAll.items.map((item) => item.id).sort()).toEqual(
      [matchesBoth, matchesOne].sort(),
    );
  });

  it("patches only owned active rows with optimistic concurrency and one idempotent change", async () => {
    const owned = await seedPattern({ ownerId: ownerA, name: "Before" });
    const foreign = await seedPattern({ ownerId: ownerB, name: "Foreign" });
    const operationId = randomUUID();

    const mutate = () =>
      updatePattern({
        ownerId: ownerA,
        patternId: owned,
        operationId,
        patch: { version: 0, name: "After", isFavorite: true },
      });
    const [first, concurrentReplay] = await Promise.all([mutate(), mutate()]);
    const replay = await updatePattern({
      ownerId: ownerA,
      patternId: owned,
      operationId,
      patch: { version: 0, name: "Ignored replay" },
    });

    expect(concurrentReplay).toEqual(first);
    expect(first).toMatchObject({
      id: owned,
      name: "After",
      isFavorite: true,
      version: 1,
      commercialVersion: 0,
    });
    expect(replay).toEqual(first);
    expect(
      await db
        .select()
        .from(changeLog)
        .where(eq(changeLog.ownerId, ownerA)),
    ).toHaveLength(1);
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

    await expect(
      updatePattern({
        ownerId: ownerA,
        patternId: owned,
        operationId: randomUUID(),
        patch: { version: 0, name: "Stale" },
      }),
    ).rejects.toMatchObject({ code: "PATTERN_STATE_CHANGED", status: 409 });
    await expect(
      updatePattern({
        ownerId: ownerA,
        patternId: foreign,
        operationId: randomUUID(),
        patch: { version: 0, name: "Stolen" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      updatePattern({
        ownerId: ownerA,
        patternId: randomUUID(),
        operationId: randomUUID(),
        patch: { version: 0, name: "Unknown" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    const [foreignRow] = await db
      .select({ name: patterns.name, version: patterns.version })
      .from(patterns)
      .where(and(eq(patterns.ownerId, ownerB), eq(patterns.id, foreign)));
    expect(foreignRow).toEqual({ name: "Foreign", version: 0 });
  });

  it("rejects patches to deleted patterns as not found without allocating a sequence", async () => {
    const deleted = await seedPattern({
      ownerId: ownerA,
      name: "Deleted",
      status: "deleted",
    });

    await expect(
      updatePattern({
        ownerId: ownerA,
        patternId: deleted,
        operationId: randomUUID(),
        patch: { version: 0, isFavorite: true },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    const [owner] = await db
      .select({ syncSeq: users.syncSeq })
      .from(users)
      .where(eq(users.id, ownerA));
    expect(owner?.syncSeq).toBe(0n);
    const rows = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from change_log where owner_id = ${ownerA}
    `);
    expect(rows[0]?.count).toBe("0");
  });
});
