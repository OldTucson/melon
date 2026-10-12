import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFolder,
  listFolders,
  renameFolder,
} from "@/features/folders/folder-service";
import { closeDatabase, db } from "@/lib/db/client";
import {
  changeLog,
  folders,
  operations,
  patterns,
  users,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

type FolderStatus = (typeof folders.$inferInsert)["status"];
type PatternStatus = (typeof patterns.$inferInsert)["status"];

const libraryPatternStatuses = [
  "draft",
  "hashing",
  "uploading",
  "processing",
  "ready",
  "failed",
] as const satisfies readonly PatternStatus[];

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

const seedFolder = async (input: {
  ownerId: string;
  parentId?: string | null;
  id?: string;
  name?: string;
  normalizedName?: string;
  status?: FolderStatus;
  version?: number;
  changeSeq?: bigint;
  createdAt?: Date;
  updatedAt?: Date;
}) => {
  const id = input.id ?? randomUUID();
  const name = input.name ?? `Folder ${id}`;
  await db.insert(folders).values({
    id,
    ownerId: input.ownerId,
    parentId: input.parentId ?? null,
    name,
    normalizedName: input.normalizedName ?? name.toLowerCase(),
    status: input.status ?? "active",
    version: input.version ?? 0,
    changeSeq: input.changeSeq ?? 0n,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  return id;
};

let patternSeed = 0;
const seedPattern = async (input: {
  ownerId: string;
  folderId: string;
  status?: PatternStatus;
}) => {
  patternSeed += 1;
  const id = randomUUID();
  const name = `Pattern ${patternSeed}`;
  await db.insert(patterns).values({
    id,
    ownerId: input.ownerId,
    folderId: input.folderId,
    name,
    originalFilename: `${name}.psd`,
    extension: "psd",
    sizeBytes: 1024n,
    status: input.status ?? "ready",
  });
  return id;
};

const ownerChanges = (ownerId: string) =>
  db
    .select()
    .from(changeLog)
    .where(eq(changeLog.ownerId, ownerId))
    .orderBy(asc(changeLog.seq));

const ownerSyncSeq = async (ownerId: string) => {
  const [owner] = await db
    .select({ syncSeq: users.syncSeq })
    .from(users)
    .where(eq(users.id, ownerId));
  return owner?.syncSeq;
};

const postgresConstraintName = (error: unknown) => {
  let candidate = error;
  const seen = new Set<unknown>();

  while (
    typeof candidate === "object" &&
    candidate !== null &&
    !seen.has(candidate)
  ) {
    seen.add(candidate);
    if (
      "code" in candidate &&
      candidate.code === "23505" &&
      "constraint_name" in candidate &&
      typeof candidate.constraint_name === "string"
    ) {
      return candidate.constraint_name;
    }
    candidate = "cause" in candidate ? candidate.cause : undefined;
  }

  return undefined;
};

describe("folder service", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    patternSeed = 0;
    ownerA = await seedUser("folders-service-a@example.test");
    ownerB = await seedUser("folders-service-b@example.test");
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("creates a canonical root folder with serialized metadata and one change", async () => {
    const operationId = randomUUID();
    const created = await createFolder({
      ownerId: ownerA,
      operationId,
      name: "  Cafe\u0301  ",
      parentId: null,
    });

    expect(created).toEqual({
      id: expect.any(String),
      ownerId: ownerA,
      parentId: null,
      name: "Caf\u00e9",
      normalizedName: "caf\u00e9",
      status: "active",
      version: 0,
      trashBatchId: null,
      trashedAt: null,
      deletedAt: null,
      changeSeq: "1",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      directPatternCount: 0,
      recursivePatternCount: 0,
    });
    expect(created.updatedAt).toBe(created.createdAt);
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
    await expect(listFolders({ ownerId: ownerA })).resolves.toEqual([created]);

    const changes = await ownerChanges(ownerA);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      ownerId: ownerA,
      seq: 1n,
      operationId,
      entityType: "folder",
      entityId: created.id,
      operation: "folder.created",
      payload: { folder: created },
    });
    expect(await ownerSyncSeq(ownerA)).toBe(1n);
  });

  it("creates children and returns a deterministic flat name-then-id list", async () => {
    const parent = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Zulu",
      parentId: null,
    });
    const child = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "alpha",
      parentId: parent.id,
    });
    const secondParent = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Middle",
      parentId: null,
    });
    const sameNameA = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Same",
      parentId: parent.id,
    });
    const sameNameB = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "same",
      parentId: secondParent.id,
    });

    const listed = await listFolders({ ownerId: ownerA });
    expect(listed.find((folder) => folder.id === child.id)?.parentId).toBe(
      parent.id,
    );
    expect(listed).toHaveLength(5);
    expect(listed.map(({ normalizedName, id }) => ({ normalizedName, id }))).toEqual(
      [...listed]
        .sort(
          (left, right) =>
            left.normalizedName.localeCompare(right.normalizedName, "en") ||
            left.id.localeCompare(right.id, "en"),
        )
        .map(({ normalizedName, id }) => ({ normalizedName, id })),
    );
    expect(
      listed.filter((folder) => folder.normalizedName === "same").map((folder) => folder.id),
    ).toEqual([sameNameA.id, sameNameB.id].sort());
  });

  it("computes owner-scoped direct and recursive counts for only library-visible rows", async () => {
    const parent = await seedFolder({ ownerId: ownerA, name: "Parent" });
    const child = await seedFolder({
      ownerId: ownerA,
      parentId: parent,
      name: "Child",
    });
    const visibleStatuses = await seedFolder({
      ownerId: ownerA,
      name: "Visible statuses",
    });
    const unrelated = await seedFolder({ ownerId: ownerA, name: "Unrelated" });
    const trashedChild = await seedFolder({
      ownerId: ownerA,
      parentId: parent,
      name: "Trashed child",
      status: "trashed",
    });
    const deletingChild = await seedFolder({
      ownerId: ownerA,
      parentId: parent,
      name: "Deleting child",
      status: "deleting",
    });
    const deletedChild = await seedFolder({
      ownerId: ownerA,
      parentId: parent,
      name: "Deleted child",
      status: "deleted",
    });
    const activeBelowTrashed = await seedFolder({
      ownerId: ownerA,
      parentId: trashedChild,
      name: "Active below trashed",
    });
    const foreignFolder = await seedFolder({
      ownerId: ownerB,
      name: "Foreign",
    });

    await seedPattern({ ownerId: ownerA, folderId: parent, status: "ready" });
    await seedPattern({ ownerId: ownerA, folderId: child, status: "draft" });
    await seedPattern({ ownerId: ownerA, folderId: child, status: "failed" });
    for (const status of ["trashed", "deleting", "deleted"] as const) {
      await seedPattern({ ownerId: ownerA, folderId: parent, status });
      await seedPattern({ ownerId: ownerA, folderId: child, status });
    }
    for (const status of libraryPatternStatuses) {
      await seedPattern({ ownerId: ownerA, folderId: visibleStatuses, status });
    }
    await seedPattern({ ownerId: ownerA, folderId: unrelated });
    await seedPattern({ ownerId: ownerA, folderId: trashedChild });
    await seedPattern({ ownerId: ownerA, folderId: deletingChild });
    await seedPattern({ ownerId: ownerA, folderId: deletedChild });
    await seedPattern({ ownerId: ownerA, folderId: activeBelowTrashed });
    await seedPattern({ ownerId: ownerB, folderId: foreignFolder });

    const byId = new Map(
      (await listFolders({ ownerId: ownerA })).map((folder) => [folder.id, folder]),
    );
    expect(byId.get(parent)).toMatchObject({
      directPatternCount: 1,
      recursivePatternCount: 3,
    });
    expect(byId.get(child)).toMatchObject({
      directPatternCount: 2,
      recursivePatternCount: 2,
    });
    expect(byId.get(visibleStatuses)).toMatchObject({
      directPatternCount: 6,
      recursivePatternCount: 6,
    });
    expect(byId.get(unrelated)).toMatchObject({
      directPatternCount: 1,
      recursivePatternCount: 1,
    });
    expect(byId.get(activeBelowTrashed)).toMatchObject({
      directPatternCount: 1,
      recursivePatternCount: 1,
    });
    expect(byId.has(trashedChild)).toBe(false);
    expect(byId.has(deletingChild)).toBe(false);
    expect(byId.has(deletedChild)).toBe(false);
    expect(byId.has(foreignFolder)).toBe(false);
  });

  it("enforces root and sibling names while allowing duplicates under different parents", async () => {
    const parentA = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Parent A",
      parentId: null,
    });
    const parentB = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Parent B",
      parentId: null,
    });
    await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Root name",
      parentId: null,
    });
    await expect(
      createFolder({
        ownerId: ownerA,
        operationId: randomUUID(),
        name: " ROOT NAME ",
        parentId: null,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_NAME_CONFLICT", status: 409 });

    const childA = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Child",
      parentId: parentA.id,
    });
    await expect(
      createFolder({
        ownerId: ownerA,
        operationId: randomUUID(),
        name: "child",
        parentId: parentA.id,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_NAME_CONFLICT", status: 409 });
    const childB = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "CHILD",
      parentId: parentB.id,
    });
    expect(childB.normalizedName).toBe(childA.normalizedName);

    const sibling = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Sibling",
      parentId: parentA.id,
    });
    await expect(
      renameFolder({
        ownerId: ownerA,
        folderId: sibling.id,
        operationId: randomUUID(),
        name: " CHILD ",
        version: sibling.version,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_NAME_CONFLICT", status: 409 });
  });

  it("does not translate unrelated PostgreSQL unique violations as name conflicts", async () => {
    await db.insert(changeLog).values({
      ownerId: ownerA,
      seq: 1n,
      operationId: randomUUID(),
      entityType: "test_fixture",
      entityId: randomUUID(),
      operation: "test.fixture",
      payload: {},
    });

    try {
      await createFolder({
        ownerId: ownerA,
        operationId: randomUUID(),
        name: "Unrelated collision",
        parentId: null,
      });
    } catch (error) {
      expect(error).not.toMatchObject({ code: "FOLDER_NAME_CONFLICT" });
      expect(postgresConstraintName(error)).toBe("change_log_owner_seq_pk");
      await expect(listFolders({ ownerId: ownerA })).resolves.toEqual([]);
      expect(await ownerSyncSeq(ownerA)).toBe(0n);
      return;
    }

    throw new Error("Expected the unrelated unique constraint to reject create");
  });

  it("distinguishes missing parents from owned inactive parents", async () => {
    const foreignParent = await seedFolder({ ownerId: ownerB, name: "Foreign" });
    for (const parentId of [foreignParent, randomUUID()]) {
      await expect(
        createFolder({
          ownerId: ownerA,
          operationId: randomUUID(),
          name: `Missing ${parentId}`,
          parentId,
        }),
      ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND", status: 404 });
    }

    for (const status of ["trashed", "deleting", "deleted"] as const) {
      const parentId = await seedFolder({
        ownerId: ownerA,
        name: `Inactive ${status}`,
        status,
      });
      await expect(
        createFolder({
          ownerId: ownerA,
          operationId: randomUUID(),
          name: `Child of ${status}`,
          parentId,
        }),
      ).rejects.toMatchObject({ code: "FOLDER_NOT_ACTIVE", status: 409 });
    }
    expect(await ownerSyncSeq(ownerA)).toBe(0n);
    expect(await ownerChanges(ownerA)).toEqual([]);
  });

  it("renames only the folder name with optimistic state checks and exact metadata", async () => {
    const parent = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Parent",
      parentId: null,
    });
    const folder = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Before",
      parentId: parent.id,
    });
    await seedPattern({ ownerId: ownerA, folderId: folder.id, status: "ready" });

    const operationId = randomUUID();
    const renamed = await renameFolder({
      ownerId: ownerA,
      folderId: folder.id,
      operationId,
      name: "  Renomme\u0301  ",
      version: 0,
    });
    expect(renamed).toMatchObject({
      id: folder.id,
      ownerId: ownerA,
      parentId: parent.id,
      name: "Renomm\u00e9",
      normalizedName: "renomm\u00e9",
      status: "active",
      version: 1,
      changeSeq: "3",
      createdAt: folder.createdAt,
      directPatternCount: 1,
      recursivePatternCount: 1,
    });
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(folder.updatedAt),
    );

    const changes = await ownerChanges(ownerA);
    expect(changes).toHaveLength(3);
    expect(changes[2]).toMatchObject({
      seq: 3n,
      operationId,
      entityType: "folder",
      entityId: folder.id,
      operation: "folder.updated",
      payload: { folder: renamed },
    });
    await expect(
      renameFolder({
        ownerId: ownerA,
        folderId: folder.id,
        operationId: randomUUID(),
        name: "Stale",
        version: 0,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_STATE_CHANGED", status: 409 });
    expect(await ownerSyncSeq(ownerA)).toBe(3n);
  });

  it("rejects rename of inactive, missing, and foreign folders without mutation", async () => {
    const foreign = await seedFolder({ ownerId: ownerB, name: "Foreign" });
    for (const folderId of [foreign, randomUUID()]) {
      await expect(
        renameFolder({
          ownerId: ownerA,
          folderId,
          operationId: randomUUID(),
          name: "Unavailable",
          version: 0,
        }),
      ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND", status: 404 });
    }

    for (const status of ["trashed", "deleting", "deleted"] as const) {
      const folderId = await seedFolder({
        ownerId: ownerA,
        name: `Inactive ${status}`,
        status,
        version: 4,
      });
      await expect(
        renameFolder({
          ownerId: ownerA,
          folderId,
          operationId: randomUUID(),
          name: "Unavailable",
          version: 4,
        }),
      ).rejects.toMatchObject({ code: "FOLDER_NOT_ACTIVE", status: 409 });
    }

    const [foreignAfter] = await db
      .select({ name: folders.name, version: folders.version })
      .from(folders)
      .where(and(eq(folders.ownerId, ownerB), eq(folders.id, foreign)));
    expect(foreignAfter).toEqual({ name: "Foreign", version: 0 });
    expect(await ownerSyncSeq(ownerA)).toBe(0n);
  });

  it("replays canonical create requests and rejects reuse for a different payload", async () => {
    const operationId = randomUUID();
    const created = await createFolder({
      ownerId: ownerA,
      operationId,
      name: "  Cafe\u0301  ",
      parentId: null,
    });
    const replay = await createFolder({
      ownerId: ownerA,
      operationId: operationId.toUpperCase(),
      name: "Caf\u00e9",
      parentId: null,
    });
    expect(replay).toEqual(created);

    await expect(
      createFolder({
        ownerId: ownerA,
        operationId,
        name: "Different",
        parentId: null,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    expect(await ownerChanges(ownerA)).toHaveLength(1);
    expect(await ownerSyncSeq(ownerA)).toBe(1n);
    const stored = await db
      .select({ kind: operations.kind })
      .from(operations)
      .where(eq(operations.ownerId, ownerA));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.kind).toMatch(/^folder\.create:[a-f0-9]{64}$/);
    expect(stored[0]?.kind).not.toContain("Caf");
  });

  it("replays canonical renames and binds reused operation IDs to the target and patch", async () => {
    const first = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "First",
      parentId: null,
    });
    const second = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Second",
      parentId: null,
    });
    const foreign = await seedFolder({ ownerId: ownerB, name: "Foreign" });
    const operationId = randomUUID();
    const renamed = await renameFolder({
      ownerId: ownerA,
      folderId: first.id,
      operationId,
      name: "  Cafe\u0301  ",
      version: 0,
    });
    await seedPattern({ ownerId: ownerA, folderId: first.id });

    await expect(
      renameFolder({
        ownerId: ownerA,
        folderId: first.id.toUpperCase(),
        operationId: operationId.toUpperCase(),
        name: "Caf\u00e9",
        version: 0,
      }),
    ).resolves.toEqual(renamed);
    for (const mismatch of [
      { folderId: first.id, name: "Different", version: 0 },
      { folderId: first.id, name: "Caf\u00e9", version: 1 },
      { folderId: second.id, name: "Other target", version: 0 },
    ]) {
      await expect(
        renameFolder({
          ownerId: ownerA,
          operationId,
          ...mismatch,
        }),
      ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    }
    for (const folderId of [foreign, randomUUID()]) {
      await expect(
        renameFolder({
          ownerId: ownerA,
          folderId,
          operationId,
          name: "Hidden target",
          version: 0,
        }),
      ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND", status: 404 });
    }

    expect(await ownerChanges(ownerA)).toHaveLength(3);
    expect(await ownerSyncSeq(ownerA)).toBe(3n);
    expect(
      await db
        .select()
        .from(operations)
        .where(eq(operations.ownerId, ownerA)),
    ).toHaveLength(3);
    await expect(listFolders({ ownerId: ownerA })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, name: "Caf\u00e9", version: 1 }),
        expect.objectContaining({ id: second.id, name: "Second", version: 0 }),
      ]),
    );
  });

  it("isolates list, counts, names, and mutations by owner", async () => {
    const owned = await createFolder({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "Shared",
      parentId: null,
    });
    const foreign = await createFolder({
      ownerId: ownerB,
      operationId: randomUUID(),
      name: "SHARED",
      parentId: null,
    });
    await seedPattern({ ownerId: ownerB, folderId: foreign.id });

    await expect(listFolders({ ownerId: ownerA })).resolves.toEqual([
      expect.objectContaining({
        id: owned.id,
        directPatternCount: 0,
        recursivePatternCount: 0,
      }),
    ]);
    await expect(
      renameFolder({
        ownerId: ownerA,
        folderId: foreign.id,
        operationId: randomUUID(),
        name: "Stolen",
        version: 0,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND", status: 404 });
    await expect(
      createFolder({
        ownerId: ownerA,
        operationId: randomUUID(),
        name: "Child",
        parentId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND", status: 404 });
    await expect(listFolders({ ownerId: ownerB })).resolves.toEqual([
      expect.objectContaining({ id: foreign.id, name: "SHARED" }),
    ]);
  });

  it("maps invalid mutation input to the public validation error", async () => {
    const validOperationId = randomUUID();
    await expect(
      createFolder({
        ownerId: ownerA,
        operationId: "not-an-operation-id",
        name: "Folder",
        parentId: null,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(
      createFolder({
        ownerId: ownerA,
        operationId: validOperationId,
        name: " ",
        parentId: null,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(
      createFolder({
        ownerId: ownerA,
        operationId: validOperationId,
        name: "Folder",
        parentId: "not-a-folder-id",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(
      renameFolder({
        ownerId: ownerA,
        folderId: "not-a-folder-id",
        operationId: validOperationId,
        name: "Renamed",
        version: -1,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  });
});
