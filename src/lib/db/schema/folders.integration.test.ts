import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { resetDatabase } from "@/test/database";

type PostgresConstraintError = {
  code: string;
  constraint_name: string;
};

const nestedFolderNameCases = [
  ["active", true],
  ["trashed", true],
  ["deleting", true],
  ["deleted", false],
] as const;

const postgresConstraintError = (
  error: unknown,
): PostgresConstraintError | undefined => {
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
      typeof candidate.code === "string" &&
      "constraint_name" in candidate &&
      typeof candidate.constraint_name === "string"
    ) {
      return {
        code: candidate.code,
        constraint_name: candidate.constraint_name,
      };
    }

    candidate = "cause" in candidate ? candidate.cause : undefined;
  }

  return undefined;
};

const expectConstraintViolation = async (
  operation: Promise<unknown>,
  expected: PostgresConstraintError,
) => {
  try {
    await operation;
  } catch (error) {
    expect(postgresConstraintError(error)).toEqual(expected);
    return;
  }

  throw new Error(
    `Expected PostgreSQL constraint ${expected.constraint_name} to reject the operation`,
  );
};

const insertFolder = async (input: {
  ownerId: string;
  parentId?: string | null;
  id?: string;
  name?: string;
  normalizedName?: string;
}) => {
  const id = input.id ?? randomUUID();

  await db.execute(sql`
    insert into folders (id, owner_id, parent_id, name, normalized_name)
    values (
      ${id},
      ${input.ownerId},
      ${input.parentId ?? null},
      ${input.name ?? "Folder"},
      ${input.normalizedName ?? id}
    )
  `);

  return id;
};

const insertPattern = (input: { ownerId: string; folderId: string }) =>
  db.execute(sql`
    insert into patterns (
      id,
      owner_id,
      folder_id,
      name,
      original_filename,
      extension,
      size_bytes
    ) values (
      ${randomUUID()},
      ${input.ownerId},
      ${input.folderId},
      'Garden print',
      'garden.psd',
      'psd',
      1024
    )
  `);

describe("folders schema", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();

    ownerA = randomUUID();
    ownerB = randomUUID();
    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values
        (${ownerA}, 'folder-owner-a@example.test', 'Folder Owner', 'test-password-hash'),
        (${ownerB}, 'folder-owner-b@example.test', 'Folder Owner', 'test-password-hash')
    `);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("creates folders and the pattern location columns", async () => {
    const [result] = await db.execute<{ folders: string | null }>(sql`
      select to_regclass('public.folders')::text as folders
    `);
    expect(result?.folders).toBe("folders");

    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'patterns'
        and column_name in ('folder_id', 'trash_batch_id', 'pre_trash_status')
    `);
    expect(columns.map((row) => row.column_name).sort()).toEqual([
      "folder_id",
      "pre_trash_status",
      "trash_batch_id",
    ]);
  });

  it("rejects a parent folder owned by another tenant", async () => {
    const ownerBFolder = await insertFolder({ ownerId: ownerB });

    await expectConstraintViolation(
      insertFolder({ ownerId: ownerA, parentId: ownerBFolder }),
      { code: "23503", constraint_name: "folders_owner_parent_fk" },
    );
  });

  it("rejects a folder that is its own parent", async () => {
    const folderId = randomUUID();

    await expectConstraintViolation(
      insertFolder({ ownerId: ownerA, id: folderId, parentId: folderId }),
      { code: "23514", constraint_name: "folders_parent_not_self" },
    );
  });

  it("rejects a pattern folder owned by another tenant", async () => {
    const ownerBFolder = await insertFolder({ ownerId: ownerB });

    await expectConstraintViolation(
      insertPattern({ ownerId: ownerA, folderId: ownerBFolder }),
      { code: "23503", constraint_name: "patterns_owner_folder_fk" },
    );
  });

  it("rejects duplicate normalized root folder names", async () => {
    await insertFolder({
      ownerId: ownerA,
      name: "Flora",
      normalizedName: "flora",
    });

    await expectConstraintViolation(
      insertFolder({
        ownerId: ownerA,
        name: "FLORA",
        normalizedName: "flora",
      }),
      {
        code: "23505",
        constraint_name: "folders_owner_root_name_live_unique",
      },
    );
  });

  it("allows the same normalized name under different parents", async () => {
    const firstParent = await insertFolder({
      ownerId: ownerA,
      normalizedName: "first-parent",
    });
    const secondParent = await insertFolder({
      ownerId: ownerA,
      normalizedName: "second-parent",
    });

    await insertFolder({
      ownerId: ownerA,
      parentId: firstParent,
      normalizedName: "flora",
    });

    await expect(
      insertFolder({
        ownerId: ownerA,
        parentId: secondParent,
        normalizedName: "flora",
      }),
    ).resolves.toBeDefined();
  });

  it.each(nestedFolderNameCases)(
    "enforces nested normalized name availability while the prior folder is %s",
    async (status, nameIsReserved) => {
      const parentId = await insertFolder({
        ownerId: ownerA,
        normalizedName: `parent-${status}`,
      });
      const folderId = await insertFolder({
        ownerId: ownerA,
        parentId,
        name: "Flora",
        normalizedName: "flora",
      });

      await db.execute(sql`
        update folders
        set status = ${status}
        where owner_id = ${ownerA} and id = ${folderId}
      `);

      const duplicateInsert = insertFolder({
        ownerId: ownerA,
        parentId,
        name: "FLORA",
        normalizedName: "flora",
      });

      if (nameIsReserved) {
        await expectConstraintViolation(duplicateInsert, {
          code: "23505",
          constraint_name: "folders_owner_parent_name_live_unique",
        });
      } else {
        await expect(duplicateInsert).resolves.toBeDefined();
      }
    },
  );

  it("releases a root normalized name only after the prior folder is deleted", async () => {
    const folderId = await insertFolder({
      ownerId: ownerA,
      name: "Flora",
      normalizedName: "flora",
    });

    await db.execute(sql`
      update folders
      set status = 'trashed'
      where owner_id = ${ownerA} and id = ${folderId}
    `);

    await expectConstraintViolation(
      insertFolder({
        ownerId: ownerA,
        name: "Flora again",
        normalizedName: "flora",
      }),
      {
        code: "23505",
        constraint_name: "folders_owner_root_name_live_unique",
      },
    );

    await db.execute(sql`
      update folders
      set status = 'deleted'
      where owner_id = ${ownerA} and id = ${folderId}
    `);

    await expect(
      insertFolder({
        ownerId: ownerA,
        name: "Flora again",
        normalizedName: "flora",
      }),
    ).resolves.toBeDefined();
  });
});
