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
  assets,
  changeLog,
  folders,
  operations,
  patternStatuses,
  patterns,
  patternTags,
  tags,
  users,
} from "@/lib/db/schema";
import { createOperationKey } from "@/lib/db/operation";
import { resetDatabase } from "@/test/database";

type SeedPattern = {
  id?: string;
  ownerId: string;
  name: string;
  originalFilename?: string;
  extension?: "psd" | "ai" | "pdf" | "jpg" | "jpeg" | "png" | "procreate";
  sizeBytes?: bigint;
  folderId?: string | null;
  status?: (typeof patternStatuses)[number];
  trashBatchId?: string | null;
  preTrashStatus?: (typeof patternStatuses)[number] | null;
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
    folderId: input.folderId,
    name: input.name,
    originalFilename: input.originalFilename ?? `${input.name}.${extension}`,
    extension,
    sizeBytes: input.sizeBytes ?? 1024n,
    status: input.status ?? "ready",
    previewStatus: input.previewStatus ?? "ready",
    isFavorite: input.isFavorite ?? false,
    trashBatchId: input.trashBatchId,
    preTrashStatus: input.preTrashStatus,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  return id;
};

const seedFolder = async (input: {
  ownerId: string;
  name: string;
  parentId?: string | null;
  status?: (typeof folders.$inferInsert)["status"];
}) => {
  const id = randomUUID();
  await db.insert(folders).values({
    id,
    ownerId: input.ownerId,
    parentId: input.parentId,
    name: input.name,
    normalizedName: input.name.toLowerCase(),
    status: input.status,
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

  it("returns the owned source, preview, and thumbnail asset ids", async () => {
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Ready with assets",
      extension: "png",
    });
    const sourceAssetId = randomUUID();
    const previewAssetId = randomUUID();
    const thumbnailAssetId = randomUUID();
    await db.insert(assets).values([
      {
        id: sourceAssetId,
        ownerId: ownerA,
        patternId,
        role: "source",
        objectKey: `users/${ownerA}/patterns/${patternId}/source/${sourceAssetId}.png`,
        originalFilename: "ready.png",
        detectedMimeType: "image/png",
        sizeBytes: 1024n,
      },
      {
        id: previewAssetId,
        ownerId: ownerA,
        patternId,
        role: "preview",
        objectKey: `users/${ownerA}/patterns/${patternId}/derived/${previewAssetId}.png`,
        originalFilename: "preview.png",
        detectedMimeType: "image/png",
        sizeBytes: 512n,
        width: 64,
        height: 64,
      },
      {
        id: thumbnailAssetId,
        ownerId: ownerA,
        patternId,
        role: "thumbnail",
        objectKey: `users/${ownerA}/patterns/${patternId}/derived/${thumbnailAssetId}.png`,
        originalFilename: "thumbnail.png",
        detectedMimeType: "image/png",
        sizeBytes: 256n,
        width: 32,
        height: 32,
      },
    ]);

    const expected = { sourceAssetId, previewAssetId, thumbnailAssetId };
    await expect(
      listPatterns({ ownerId: ownerA, input: {} }),
    ).resolves.toMatchObject({ items: [expected] });
    await expect(
      getPattern({ ownerId: ownerA, patternId }),
    ).resolves.toMatchObject(expected);
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
    const yearZero = Buffer.from(
      JSON.stringify({
        sort: "updated_desc",
        value: "0000-01-01T00:00:00.000000Z",
        id: randomUUID(),
      }),
    ).toString("base64url");
    const nulName = Buffer.from(
      JSON.stringify({ sort: "name_asc", value: "bad\0name", id: randomUUID() }),
    ).toString("base64url");
    const oversizedName = Buffer.from(
      JSON.stringify({
        sort: "name_asc",
        value: "x".repeat(161),
        id: randomUUID(),
      }),
    ).toString("base64url");

    for (const input of [
      { sort: "updated_desc" as const, cursor: "not-json" },
      { sort: "updated_desc" as const, cursor: wrongValue },
      { sort: "updated_desc" as const, cursor: wrongDate },
      { sort: "updated_desc" as const, cursor: yearZero },
      { sort: "size_desc" as const, cursor: outOfRangeSize },
      { sort: "name_asc" as const, cursor: wrongId },
      { sort: "name_asc" as const, cursor: nulName },
      { sort: "name_asc" as const, cursor: oversizedName },
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

  it("rejects NUL in search and pattern names before reaching PostgreSQL", async () => {
    const patternId = await seedPattern({ ownerId: ownerA, name: "Safe" });

    await expect(
      listPatterns({ ownerId: ownerA, input: { q: "bad\0query" } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(
      updatePattern({
        ownerId: ownerA,
        patternId,
        operationId: randomUUID(),
        patch: { version: 0, name: "bad\0name" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  });

  it("uses exact library and trash status allowlists while keeping trashed detail readable", async () => {
    const idsByStatus = new Map<(typeof patternStatuses)[number], string>();
    const trashBatchId = randomUUID();
    for (const status of patternStatuses) {
      idsByStatus.set(
        status,
        await seedPattern({
          ownerId: ownerA,
          name: status,
          status,
          trashBatchId:
            status === "trashed" || status === "deleting"
              ? trashBatchId
              : null,
          preTrashStatus:
            status === "trashed" || status === "deleting" ? "ready" : null,
        }),
      );
    }

    const library = await listPatterns({
      ownerId: ownerA,
      input: { sort: "name_asc" },
    });
    expect(library.items.map((item) => item.status).sort()).toEqual(
      ["draft", "failed", "hashing", "processing", "ready", "uploading"],
    );
    const trash = await listPatterns({
      ownerId: ownerA,
      input: { scope: "trash", sort: "name_asc" },
    });
    expect(trash.items.map((item) => item.status)).toEqual([
      "deleting",
      "trashed",
    ]);
    expect(trash.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          folderId: null,
          trashBatchId,
          preTrashStatus: "ready",
        }),
      ]),
    );
    const trashed = idsByStatus.get("trashed")!;
    await expect(
      getPattern({ ownerId: ownerA, patternId: trashed }),
    ).resolves.toMatchObject({
      id: trashed,
      status: "trashed",
      folderId: null,
      trashBatchId,
      preTrashStatus: "ready",
    });
  });

  it("filters direct, descendant, unfiled, and foreign folder scopes exactly", async () => {
    const parent = await seedFolder({ ownerId: ownerA, name: "Parent" });
    const child = await seedFolder({
      ownerId: ownerA,
      name: "Child",
      parentId: parent,
    });
    const grandchild = await seedFolder({
      ownerId: ownerA,
      name: "Grandchild",
      parentId: child,
    });
    const unrelated = await seedFolder({
      ownerId: ownerA,
      name: "Unrelated",
    });
    const foreign = await seedFolder({ ownerId: ownerB, name: "Foreign" });
    const parentPattern = await seedPattern({
      ownerId: ownerA,
      folderId: parent,
      name: "Parent pattern",
    });
    const childPattern = await seedPattern({
      ownerId: ownerA,
      folderId: child,
      name: "Child pattern",
    });
    const grandchildPattern = await seedPattern({
      ownerId: ownerA,
      folderId: grandchild,
      name: "Grandchild pattern",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: unrelated,
      name: "Unrelated pattern",
    });
    const unfiledPattern = await seedPattern({
      ownerId: ownerA,
      folderId: null,
      name: "Unfiled pattern",
    });
    await seedPattern({
      ownerId: ownerB,
      folderId: foreign,
      name: "Foreign pattern",
    });

    const ids = async (input: Parameters<typeof listPatterns>[0]["input"]) =>
      (await listPatterns({ ownerId: ownerA, input })).items
        .map((item) => item.id)
        .sort();
    await expect(
      ids({ folderId: parent, includeDescendants: true }),
    ).resolves.toEqual(
      [parentPattern, childPattern, grandchildPattern].sort(),
    );
    await expect(
      ids({ folderId: parent, includeDescendants: false }),
    ).resolves.toEqual([parentPattern]);
    await expect(ids({ unfiled: true })).resolves.toEqual([unfiledPattern]);
    await expect(ids({ folderId: foreign })).resolves.toEqual([]);
  });

  it("enforces folder lifecycle boundaries for scoped and unscoped reads", async () => {
    const activeRoot = await seedFolder({ ownerId: ownerA, name: "Active root" });
    const activeChild = await seedFolder({
      ownerId: ownerA,
      name: "Active child",
      parentId: activeRoot,
    });
    const activeSibling = await seedFolder({
      ownerId: ownerA,
      name: "Active sibling",
      parentId: activeRoot,
    });
    const deletedBoundary = await seedFolder({
      ownerId: ownerA,
      name: "Deleted boundary",
      parentId: activeRoot,
      status: "deleted",
    });
    const activeBelowDeleted = await seedFolder({
      ownerId: ownerA,
      name: "Active below deleted",
      parentId: deletedBoundary,
    });
    const trashedRoot = await seedFolder({
      ownerId: ownerA,
      name: "Trashed root",
      status: "trashed",
    });
    const deletingRoot = await seedFolder({
      ownerId: ownerA,
      name: "Deleting root",
      status: "deleting",
    });
    const deletedRoot = await seedFolder({
      ownerId: ownerA,
      name: "Deleted root",
      status: "deleted",
    });
    const foreignRoot = await seedFolder({
      ownerId: ownerB,
      name: "Foreign lifecycle root",
    });

    const activeRootPattern = await seedPattern({
      ownerId: ownerA,
      folderId: activeRoot,
      name: "Active root pattern",
    });
    const activeChildPattern = await seedPattern({
      ownerId: ownerA,
      folderId: activeChild,
      name: "Active child pattern",
    });
    const activeSiblingPattern = await seedPattern({
      ownerId: ownerA,
      folderId: activeSibling,
      name: "Active sibling pattern",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: deletedBoundary,
      name: "Deleted boundary pattern",
    });
    const activeBelowDeletedPattern = await seedPattern({
      ownerId: ownerA,
      folderId: activeBelowDeleted,
      name: "Hidden active descendant",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: trashedRoot,
      name: "Library status in trashed folder",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: deletingRoot,
      name: "Library status in deleting folder",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: deletedRoot,
      name: "Library status in deleted folder",
    });
    const unfiledPattern = await seedPattern({
      ownerId: ownerA,
      folderId: null,
      name: "Lifecycle unfiled",
    });
    await seedPattern({
      ownerId: ownerB,
      folderId: foreignRoot,
      name: "Foreign lifecycle pattern",
    });

    const trashedInActive = await seedPattern({
      ownerId: ownerA,
      folderId: activeRoot,
      name: "Trashed in active",
      status: "trashed",
    });
    const trashedInActiveChild = await seedPattern({
      ownerId: ownerA,
      folderId: activeChild,
      name: "Trashed in active child",
      status: "trashed",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: deletedBoundary,
      name: "Trashed at deleted boundary",
      status: "trashed",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: activeBelowDeleted,
      name: "Trashed below deleted boundary",
      status: "trashed",
    });
    const trashedInTrashed = await seedPattern({
      ownerId: ownerA,
      folderId: trashedRoot,
      name: "Trashed in trashed",
      status: "trashed",
    });
    const deletingInDeleting = await seedPattern({
      ownerId: ownerA,
      folderId: deletingRoot,
      name: "Deleting in deleting",
      status: "deleting",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: deletedRoot,
      name: "Trashed in deleted",
      status: "trashed",
    });

    const ids = async (input: Parameters<typeof listPatterns>[0]["input"]) =>
      (await listPatterns({ ownerId: ownerA, input })).items
        .map((item) => item.id)
        .sort();
    await expect(ids({})).resolves.toEqual(
      [
        activeRootPattern,
        activeChildPattern,
        activeSiblingPattern,
        activeBelowDeletedPattern,
        unfiledPattern,
      ].sort(),
    );
    await expect(ids({ unfiled: true })).resolves.toEqual([unfiledPattern]);
    await expect(
      ids({ folderId: activeRoot, includeDescendants: true }),
    ).resolves.toEqual(
      [activeRootPattern, activeChildPattern, activeSiblingPattern].sort(),
    );
    await expect(
      ids({ folderId: activeRoot, includeDescendants: false }),
    ).resolves.toEqual([activeRootPattern]);
    for (const folderId of [trashedRoot, deletingRoot, deletedRoot, foreignRoot]) {
      await expect(
        ids({ folderId, includeDescendants: false }),
      ).resolves.toEqual([]);
      await expect(ids({ folderId })).resolves.toEqual([]);
    }

    await expect(
      ids({
        folderId: activeRoot,
        includeDescendants: false,
        scope: "trash",
      }),
    ).resolves.toEqual([trashedInActive]);
    await expect(
      ids({
        folderId: activeRoot,
        includeDescendants: true,
        scope: "trash",
      }),
    ).resolves.toEqual([trashedInActive, trashedInActiveChild].sort());
    await expect(
      ids({ folderId: trashedRoot, scope: "trash" }),
    ).resolves.toEqual([trashedInTrashed]);
    await expect(
      ids({ folderId: deletingRoot, scope: "trash" }),
    ).resolves.toEqual([deletingInDeleting]);
    await expect(
      ids({ folderId: deletedRoot, scope: "trash" }),
    ).resolves.toEqual([]);
  });

  it("terminates descendant traversal for an anomalous folder cycle", async () => {
    const first = await seedFolder({ ownerId: ownerA, name: "Cycle first" });
    const second = await seedFolder({
      ownerId: ownerA,
      name: "Cycle second",
      parentId: first,
    });
    await db
      .update(folders)
      .set({ parentId: second })
      .where(and(eq(folders.ownerId, ownerA), eq(folders.id, first)));
    const unrelated = await seedFolder({
      ownerId: ownerA,
      name: "Outside cycle",
    });
    await seedPattern({
      ownerId: ownerA,
      folderId: unrelated,
      name: "Outside cycle pattern",
    });

    await db.execute(sql.raw("set statement_timeout = '250ms'"));
    try {
      const result = await listPatterns({
        ownerId: ownerA,
        input: { folderId: first, includeDescendants: true },
      });
      expect(result.items).toEqual([]);
    } finally {
      await db.execute(sql.raw("set statement_timeout = default"));
    }
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

  it("returns only patterns without active tags for the untagged view", async () => {
    const tagId = await seedTag(ownerA, "Assigned");
    const inactiveOnly = await seedPattern({
      ownerId: ownerA,
      name: "Inactive relation",
    });
    const noRelation = await seedPattern({
      ownerId: ownerA,
      name: "No relation",
    });
    const tagged = await seedPattern({ ownerId: ownerA, name: "Tagged" });
    await db.insert(patternTags).values([
      {
        ownerId: ownerA,
        patternId: inactiveOnly,
        tagId,
        isActive: false,
      },
      { ownerId: ownerA, patternId: tagged, tagId },
    ]);

    const result = await listPatterns({
      ownerId: ownerA,
      input: { untagged: true, sort: "name_asc" },
    });

    expect(result.items.map((item) => item.id)).toEqual([
      inactiveOnly,
      noRelation,
    ]);
  });

  it("patches only owned active rows with optimistic concurrency and one idempotent change", async () => {
    const owned = await seedPattern({ ownerId: ownerA, name: "Before" });
    const otherOwned = await seedPattern({ ownerId: ownerA, name: "Other" });
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
      patch: { version: 0, name: "After", isFavorite: true },
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

    for (const mismatch of [
      {
        patternId: owned,
        patch: { version: 0, name: "Different payload" },
        code: "OPERATION_ID_REUSED",
        status: 409,
      },
      {
        patternId: owned,
        patch: { version: 1, name: "Different version" },
        code: "OPERATION_ID_REUSED",
        status: 409,
      },
      {
        patternId: otherOwned,
        patch: { version: 0, name: "Different target" },
        code: "OPERATION_ID_REUSED",
        status: 409,
      },
      {
        patternId: foreign,
        patch: { version: 0, name: "Foreign target" },
        code: "NOT_FOUND",
        status: 404,
      },
      {
        patternId: randomUUID(),
        patch: { version: 0, name: "Unknown target" },
        code: "NOT_FOUND",
        status: 404,
      },
    ]) {
      await expect(
        updatePattern({
          ownerId: ownerA,
          patternId: mismatch.patternId,
          operationId,
          patch: mismatch.patch,
        }),
      ).rejects.toMatchObject({ code: mismatch.code, status: mismatch.status });
    }
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

    const [otherOwnedRow] = await db
      .select({ name: patterns.name, version: patterns.version })
      .from(patterns)
      .where(
        and(eq(patterns.ownerId, ownerA), eq(patterns.id, otherOwned)),
      );
    expect(otherOwnedRow).toEqual({ name: "Other", version: 0 });

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

  it("rejects metadata mutations while an upload is still transient", async () => {
    const patternId = await seedPattern({ ownerId: ownerA, name: "Uploading" });
    await db
      .update(patterns)
      .set({ status: "processing" })
      .where(and(eq(patterns.ownerId, ownerA), eq(patterns.id, patternId)));

    await expect(
      updatePattern({
        ownerId: ownerA,
        patternId,
        operationId: randomUUID(),
        patch: { version: 0, name: "Too soon" },
      }),
    ).rejects.toMatchObject({ code: "PATTERN_STATE_CHANGED", status: 409 });

    const [stored] = await db
      .select({ name: patterns.name, version: patterns.version })
      .from(patterns)
      .where(and(eq(patterns.ownerId, ownerA), eq(patterns.id, patternId)));
    expect(stored).toEqual({ name: "Uploading", version: 0 });
  });

  it("normalizes uppercase pattern identities before idempotent replay", async () => {
    const patternId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await seedPattern({ id: patternId, ownerId: ownerA, name: "Before" });
    const operationId = randomUUID();
    const patch = { version: 0, name: "After" };
    const uppercasePatternId = patternId.toUpperCase();

    const first = await updatePattern({
      ownerId: ownerA,
      patternId: uppercasePatternId,
      operationId,
      patch,
    });
    expect(first).toMatchObject({ id: patternId, name: "After", version: 1 });

    const readMutationState = async () => {
      const [pattern] = await db
        .select({
          name: patterns.name,
          version: patterns.version,
          changeSeq: patterns.changeSeq,
          updatedAt: patterns.updatedAt,
        })
        .from(patterns)
        .where(and(eq(patterns.ownerId, ownerA), eq(patterns.id, patternId)));
      const [owner] = await db
        .select({ syncSeq: users.syncSeq })
        .from(users)
        .where(eq(users.id, ownerA));
      const logRows = await db
        .select()
        .from(changeLog)
        .where(eq(changeLog.ownerId, ownerA));
      const operationRows = await db
        .select()
        .from(operations)
        .where(eq(operations.ownerId, ownerA));
      return { pattern, owner, logRows, operationRows };
    };
    const afterFirst = await readMutationState();

    await expect(
      updatePattern({
        ownerId: ownerA,
        patternId: uppercasePatternId,
        operationId,
        patch,
      }),
    ).resolves.toEqual(first);
    const afterReplay = await readMutationState();

    expect(afterReplay).toEqual(afterFirst);
    expect(afterReplay.pattern).toMatchObject({
      name: "After",
      version: 1,
      changeSeq: 1n,
    });
    expect(afterReplay.owner?.syncSeq).toBe(1n);
    expect(afterReplay.logRows).toHaveLength(1);
    expect(afterReplay.operationRows).toHaveLength(1);
  });

  it("normalizes legacy pattern update replays without writing again", async () => {
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Legacy replay",
    });
    const patch = { version: 0, name: "Legacy replay" };
    const operationId = randomUUID();
    const current = await getPattern({ ownerId: ownerA, patternId });
    const legacyResult = { ...current };
    Reflect.deleteProperty(legacyResult, "folderId");
    Reflect.deleteProperty(legacyResult, "trashBatchId");
    Reflect.deleteProperty(legacyResult, "preTrashStatus");
    await db.insert(operations).values({
      ownerId: ownerA,
      operationId,
      kind: createOperationKey("pattern.update", { patternId, patch }),
      result: legacyResult,
    });

    await expect(
      updatePattern({ ownerId: ownerA, patternId, operationId, patch }),
    ).resolves.toEqual({
      ...legacyResult,
      folderId: null,
      trashBatchId: null,
      preTrashStatus: null,
    });
    const [owner] = await db
      .select({ syncSeq: users.syncSeq })
      .from(users)
      .where(eq(users.id, ownerA));
    expect(owner?.syncSeq).toBe(0n);
    expect(
      await db
        .select()
        .from(changeLog)
        .where(eq(changeLog.ownerId, ownerA)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(operations)
        .where(eq(operations.ownerId, ownerA)),
    ).toHaveLength(1);
  });

  it("preserves modern replay location metadata and rejects corrupt results", async () => {
    const folderId = await seedFolder({ ownerId: ownerA, name: "Replay folder" });
    const trashBatchId = randomUUID();
    const patternId = await seedPattern({
      ownerId: ownerA,
      folderId,
      name: "Modern replay",
      status: "trashed",
      trashBatchId,
      preTrashStatus: "ready",
    });
    const patch = { version: 0, isFavorite: true };
    const operationId = randomUUID();
    const modernResult = await getPattern({ ownerId: ownerA, patternId });
    await db.insert(operations).values({
      ownerId: ownerA,
      operationId,
      kind: createOperationKey("pattern.update", { patternId, patch }),
      result: modernResult,
    });

    await expect(
      updatePattern({ ownerId: ownerA, patternId, operationId, patch }),
    ).resolves.toMatchObject({
      folderId,
      trashBatchId,
      preTrashStatus: "ready",
    });

    const corruptOperationId = randomUUID();
    await db.execute(sql`
      insert into operations (owner_id, operation_id, kind, result)
      values (
        ${ownerA},
        ${corruptOperationId},
        ${createOperationKey("pattern.update", { patternId, patch })},
        '"corrupt"'::jsonb
      )
    `);
    await expect(
      updatePattern({
        ownerId: ownerA,
        patternId,
        operationId: corruptOperationId,
        patch,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
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

  it("rejects rename and favorite patches while permanent deletion is in progress", async () => {
    const deleting = await seedPattern({
      ownerId: ownerA,
      name: "Deleting",
      status: "deleting",
      trashBatchId: randomUUID(),
      preTrashStatus: "ready",
    });

    for (const patch of [
      { version: 0, name: "Renamed" },
      { version: 0, isFavorite: true },
    ]) {
      await expect(
        updatePattern({
          ownerId: ownerA,
          patternId: deleting,
          operationId: randomUUID(),
          patch,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }

    const [stored] = await db
      .select({ name: patterns.name, isFavorite: patterns.isFavorite })
      .from(patterns)
      .where(eq(patterns.id, deleting));
    expect(stored).toEqual({ name: "Deleting", isFavorite: false });
  });

  it("reports a state conflict when deletion starts after the patch row is locked", async () => {
    const patternId = await seedPattern({
      ownerId: ownerA,
      name: "Race target",
    });
    const identifierSuffix = randomUUID().replaceAll("-", "");
    const functionName = `melon_test_mark_pattern_deleting_${identifierSuffix}`;
    const triggerName = `melon_test_mark_pattern_deleting_${identifierSuffix}`;
    await db.execute(sql.raw(`
      create function "${functionName}"()
      returns trigger
      language plpgsql
      as $$
      begin
        update patterns
        set status = 'deleting'::pattern_status
        where owner_id = new.id and name = 'Race target';
        return new;
      end
      $$
    `));
    await db.execute(sql.raw(`
      create trigger "${triggerName}"
      after update of sync_seq on users
      for each row execute function "${functionName}"()
    `));

    try {
      await expect(
        updatePattern({
          ownerId: ownerA,
          patternId,
          operationId: randomUUID(),
          patch: { version: 0, name: "Should not persist" },
        }),
      ).rejects.toMatchObject({
        code: "PATTERN_STATE_CHANGED",
        status: 409,
      });
    } finally {
      await db.execute(
        sql.raw(`drop trigger "${triggerName}" on users`),
      );
      await db.execute(
        sql.raw(`drop function "${functionName}"()`),
      );
    }

    await expect(
      getPattern({ ownerId: ownerA, patternId }),
    ).resolves.toMatchObject({
      name: "Race target",
      status: "ready",
      version: 0,
    });
  });
});
