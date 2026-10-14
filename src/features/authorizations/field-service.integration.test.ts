import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { resetDatabase } from "@/test/database";

import {
  archiveAuthorizationField,
  createAuthorizationField,
  listAuthorizationFields,
} from "./field-service";

describe("authorization field service", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = randomUUID();
    ownerB = randomUUID();

    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values
        (${ownerA}, 'field-owner-a@example.test', 'Owner A', 'test-password-hash'),
        (${ownerB}, 'field-owner-b@example.test', 'Owner B', 'test-password-hash')
    `);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("lists the fixed dictionary and isolates custom fields by owner", async () => {
    await createAuthorizationField({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "童装",
    });
    await createAuthorizationField({
      ownerId: ownerB,
      operationId: randomUUID(),
      name: "汽车用品",
    });

    const fields = await listAuthorizationFields({ ownerId: ownerA });

    expect(fields).toHaveLength(13);
    expect(fields.filter((field) => field.scope === "system")).toHaveLength(12);
    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "家居服", scope: "system" }),
        expect.objectContaining({
          name: "童装",
          ownerId: ownerA,
          scope: "custom",
        }),
      ]),
    );
    expect(fields.some((field) => field.name === "汽车用品")).toBe(false);
  });

  it("normalizes a custom name and records one change", async () => {
    const created = await createAuthorizationField({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "  ＨｏｍｅＷｅａｒ  ",
    });

    expect(created).toMatchObject({
      ownerId: ownerA,
      scope: "custom",
      name: "HomeWear",
      normalizedName: "homewear",
      status: "active",
    });

    const [change] = await db.execute<{
      operation: string;
      payload: { field: { id: string } };
    }>(sql`
      select operation, payload
      from change_log
      where owner_id = ${ownerA}
    `);
    expect(change).toMatchObject({
      operation: "authorization_field.created",
      payload: { field: { id: created.id } },
    });
  });

  it.each(["家居服", "  家居服  "])(
    "rejects a custom name matching system field %j",
    async (name) => {
      await expect(
        createAuthorizationField({
          ownerId: ownerA,
          operationId: randomUUID(),
          name,
        }),
      ).rejects.toMatchObject({ code: "AUTHORIZATION_FIELD_EXISTS" });
    },
  );

  it("keeps an archived custom name reserved", async () => {
    const created = await createAuthorizationField({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "童装",
    });
    await archiveAuthorizationField({
      ownerId: ownerA,
      fieldId: created.id,
      operationId: randomUUID(),
    });

    await expect(
      createAuthorizationField({
        ownerId: ownerA,
        operationId: randomUUID(),
        name: "童装",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FIELD_EXISTS" });
  });

  it("allows different owners to use the same custom name", async () => {
    await createAuthorizationField({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "童装",
    });

    await expect(
      createAuthorizationField({
        ownerId: ownerB,
        operationId: randomUUID(),
        name: "童装",
      }),
    ).resolves.toMatchObject({ ownerId: ownerB, name: "童装" });
  });

  it("archives an owned custom field idempotently without duplicate changes", async () => {
    const created = await createAuthorizationField({
      ownerId: ownerA,
      operationId: randomUUID(),
      name: "童装",
    });
    const archiveOperationId = randomUUID();

    const archived = await archiveAuthorizationField({
      ownerId: ownerA,
      fieldId: created.id,
      operationId: archiveOperationId,
    });
    const replayed = await archiveAuthorizationField({
      ownerId: ownerA,
      fieldId: created.id,
      operationId: archiveOperationId,
    });
    const repeated = await archiveAuthorizationField({
      ownerId: ownerA,
      fieldId: created.id,
      operationId: randomUUID(),
    });

    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();
    expect(replayed).toEqual(archived);
    expect(repeated).toEqual(archived);

    const [counts] = await db.execute<{
      change_count: number;
      sync_seq: bigint;
    }>(sql`
      select
        (select count(*)::int from change_log where owner_id = ${ownerA}) as change_count,
        sync_seq
      from users
      where id = ${ownerA}
    `);
    expect(counts?.change_count).toBe(2);
    expect(BigInt(counts?.sync_seq ?? -1)).toBe(2n);

    expect(await listAuthorizationFields({ ownerId: ownerA })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
    );
    expect(
      await listAuthorizationFields({ ownerId: ownerA, includeArchived: true }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.id, status: "archived" }),
      ]),
    );
  });

  it("does not expose system or another owner's field through archive", async () => {
    const other = await createAuthorizationField({
      ownerId: ownerB,
      operationId: randomUUID(),
      name: "童装",
    });

    await expect(
      archiveAuthorizationField({
        ownerId: ownerA,
        fieldId: other.id,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      archiveAuthorizationField({
        ownerId: ownerA,
        fieldId: "00000000-0000-4000-8000-000000000001",
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("rejects reusing an operation ID for different field creation", async () => {
    const operationId = randomUUID();
    await createAuthorizationField({
      ownerId: ownerA,
      operationId,
      name: "童装",
    });

    await expect(
      createAuthorizationField({
        ownerId: ownerA,
        operationId,
        name: "汽车用品",
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" });
  });
});
