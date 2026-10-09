import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { nextChangeSeq } from "@/lib/db/change-seq";
import { users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

const userValues = (email: string) => ({
  id: randomUUID(),
  email,
  displayName: "Library Owner",
  passwordHash: "test-password-hash",
});

async function insertPattern(ownerId: string) {
  const id = randomUUID();

  await db.execute(sql`
    insert into patterns (
      id,
      owner_id,
      name,
      original_filename,
      extension,
      size_bytes
    ) values (
      ${id},
      ${ownerId},
      'Garden print',
      'garden.psd',
      'psd',
      1024
    )
  `);

  return id;
}

async function insertTag(input: {
  ownerId: string;
  name: string;
  normalizedName: string;
  deletedAt?: Date;
}) {
  const id = randomUUID();

  await db.execute(sql`
    insert into tags (
      id,
      owner_id,
      name,
      normalized_name,
      color_token,
      deleted_at
    ) values (
      ${id},
      ${input.ownerId},
      ${input.name},
      ${input.normalizedName},
      'green',
      ${input.deletedAt ?? null}
    )
  `);

  return id;
}

const insertChange = (input: {
  ownerId: string;
  seq: bigint;
  operationId: string;
}) =>
  db.execute(sql`
    insert into change_log (
      owner_id,
      seq,
      operation_id,
      entity_type,
      entity_id,
      operation,
      payload
    ) values (
      ${input.ownerId},
      ${input.seq},
      ${input.operationId},
      'pattern',
      ${randomUUID()},
      'updated',
      ${JSON.stringify({ version: 1 })}::jsonb
    )
  `);

describe("core library schema", () => {
  let ownerA: string;
  let ownerB: string;

  beforeEach(async () => {
    await resetDatabase();

    ownerA = randomUUID();
    ownerB = randomUUID();
    await db.insert(users).values([
      { ...userValues("owner-a@example.test"), id: ownerA },
      { ...userValues("owner-b@example.test"), id: ownerB },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("starts every pattern with commercial version zero", async () => {
    const patternId = await insertPattern(ownerA);
    const rows = await db.execute<{ commercial_version: number }>(sql`
      select commercial_version
      from patterns
      where owner_id = ${ownerA} and id = ${patternId}
    `);

    expect(rows[0]?.commercial_version).toBe(0);
  });

  it("allows only one current asset for each pattern role", async () => {
    const patternId = await insertPattern(ownerA);
    const insertSource = (assetId: string, objectKey: string) =>
      db.execute(sql`
        insert into assets (
          id,
          owner_id,
          pattern_id,
          role,
          object_key,
          original_filename,
          size_bytes
        ) values (
          ${assetId},
          ${ownerA},
          ${patternId},
          'source',
          ${objectKey},
          'garden.psd',
          1024
        )
      `);

    await insertSource(randomUUID(), `users/${ownerA}/first.psd`);

    await expect(
      insertSource(randomUUID(), `users/${ownerA}/second.psd`),
    ).rejects.toThrow();
  });

  it("claims operation IDs once per owner while allowing another owner to reuse one", async () => {
    const operationId = randomUUID();
    const insertOperation = (ownerId: string, kind: string) =>
      db.execute(sql`
        insert into operations (owner_id, operation_id, kind, result)
        values (${ownerId}, ${operationId}, ${kind}, ${JSON.stringify({ ok: true })}::jsonb)
      `);

    await insertOperation(ownerA, "pattern.create");

    await expect(
      insertOperation(ownerA, "pattern.create.retry"),
    ).rejects.toThrow();
    await expect(insertOperation(ownerB, "pattern.create")).resolves.toBeDefined();
  });

  it("rejects tag relations that mix owners", async () => {
    const patternId = await insertPattern(ownerA);
    const foreignTagId = await insertTag({
      ownerId: ownerB,
      name: "Summer",
      normalizedName: "summer",
    });

    await expect(
      db.execute(sql`
        insert into pattern_tags (owner_id, pattern_id, tag_id)
        values (${ownerA}, ${patternId}, ${foreignTagId})
      `),
    ).rejects.toThrow();
  });

  it("scopes active normalized tag names to an owner and releases soft-deleted names", async () => {
    const ownerATagId = await insertTag({
      ownerId: ownerA,
      name: "Summer",
      normalizedName: "summer",
    });

    await expect(
      insertTag({
        ownerId: ownerB,
        name: "Summer",
        normalizedName: "summer",
      }),
    ).resolves.toBeDefined();

    await expect(
      insertTag({
        ownerId: ownerA,
        name: "SUMMER",
        normalizedName: "summer",
      }),
    ).rejects.toThrow();

    await db.execute(sql`
      update tags
      set deleted_at = now()
      where owner_id = ${ownerA} and id = ${ownerATagId}
    `);

    await expect(
      insertTag({
        ownerId: ownerA,
        name: "Summer again",
        normalizedName: "summer",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects assets whose owner does not own the pattern", async () => {
    const patternId = await insertPattern(ownerA);

    await expect(
      db.execute(sql`
        insert into assets (
          id,
          owner_id,
          pattern_id,
          role,
          object_key,
          original_filename,
          size_bytes
        ) values (
          ${randomUUID()},
          ${ownerB},
          ${patternId},
          'source',
          'users/foreign/source.psd',
          'source.psd',
          1024
        )
      `),
    ).rejects.toThrow();
  });

  it("rejects upload sessions whose owner does not own the pattern", async () => {
    const patternId = await insertPattern(ownerA);

    await expect(
      db.execute(sql`
        insert into upload_sessions (
          id,
          owner_id,
          pattern_id,
          operation_id,
          source_object_key,
          file_fingerprint,
          size_bytes,
          expires_at
        ) values (
          ${randomUUID()},
          ${ownerB},
          ${patternId},
          ${randomUUID()},
          'users/foreign/source.psd',
          ${JSON.stringify({ lastModified: 1 })}::jsonb,
          1024,
          now() + interval '1 hour'
        )
      `),
    ).rejects.toThrow();
  });

  it("allocates strictly increasing change sequences in the caller transaction", async () => {
    const allocated = await db.transaction(async (tx) => [
      await nextChangeSeq(tx, ownerA),
      await nextChangeSeq(tx, ownerA),
    ]);

    expect(allocated).toEqual([1n, 2n]);

    const [owner] = await db
      .select({ syncSeq: users.syncSeq })
      .from(users)
      .where(eq(users.id, ownerA));
    expect(owner?.syncSeq).toBe(2n);
  });

  it("allocates a gap-free sequence across concurrent transactions", async () => {
    const allocationPromises = Array.from({ length: 20 }, () =>
      db.transaction((tx) => nextChangeSeq(tx, ownerA)),
    );
    const allocated = await Promise.all(allocationPromises);
    const sorted = [...allocated].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    expect(sorted).toEqual(
      Array.from({ length: 20 }, (_, index) => BigInt(index + 1)),
    );
    expect(new Set(allocated.map(String)).size).toBe(20);

    const [owner] = await db
      .select({ syncSeq: users.syncSeq })
      .from(users)
      .where(eq(users.id, ownerA));
    expect(owner?.syncSeq).toBe(20n);
  });

  it("scopes change log sequence and operation uniqueness to an owner", async () => {
    const operationId = randomUUID();

    await insertChange({ ownerId: ownerA, seq: 1n, operationId });

    await expect(
      insertChange({
        ownerId: ownerA,
        seq: 1n,
        operationId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      insertChange({ ownerId: ownerA, seq: 2n, operationId }),
    ).rejects.toThrow();
    await expect(
      insertChange({ ownerId: ownerB, seq: 1n, operationId }),
    ).resolves.toBeDefined();
  });

  it("rejects sequence allocation for an unknown owner", async () => {
    await expect(
      db.transaction((tx) => nextChangeSeq(tx, randomUUID())),
    ).rejects.toThrow("OWNER_NOT_FOUND");
  });
});
