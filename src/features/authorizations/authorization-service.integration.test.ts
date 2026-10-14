import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { resetDatabase } from "@/test/database";

import {
  createAuthorization,
  editAuthorization,
  restoreAuthorization,
  voidAuthorization,
} from "./authorization-service";
import {
  archiveAuthorizationField,
  createAuthorizationField,
} from "./field-service";

const HOMEWEAR_FIELD_ID = "00000000-0000-4000-8000-000000000001";
const STATIONERY_FIELD_ID = "00000000-0000-4000-8000-000000000008";

describe("authorization service", () => {
  let ownerId: string;
  let patternId: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    patternId = randomUUID();

    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values (${ownerId}, 'authorization-service@example.test', 'Owner', 'test-password-hash')
    `);
    await db.execute(sql`
      insert into patterns (
        id,
        owner_id,
        name,
        original_filename,
        extension,
        size_bytes,
        status
      ) values (
        ${patternId},
        ${ownerId},
        'Garden',
        'garden.psd',
        'psd',
        1024,
        'ready'
      )
    `);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const create = (
    overrides: Partial<Parameters<typeof createAuthorization>[0]> = {},
  ) =>
    createAuthorization({
      ownerId,
      patternId,
      operationId: randomUUID(),
      commercialVersion: 0,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      licenseeName: "示例客户",
      priceYuan: "1280.00",
      authorizedOn: "2026-10-08",
      note: null,
      historyConfirmed: false,
      ...overrides,
    });

  it("creates one replay-safe authorization and increments commercial state once", async () => {
    const operationId = randomUUID();
    const input = {
      ownerId,
      patternId,
      operationId,
      commercialVersion: 0,
      kind: "standard" as const,
      fieldId: HOMEWEAR_FIELD_ID,
      licenseeName: "  示例客户  ",
      priceYuan: "1280.00",
      authorizedOn: "2026-10-08",
      note: "  首批授权  ",
      historyConfirmed: false,
    };

    const created = await createAuthorization(input);
    const replayed = await createAuthorization(input);

    expect(created).toMatchObject({
      ownerId,
      patternId,
      operationId,
      kind: "standard",
      fieldId: HOMEWEAR_FIELD_ID,
      fieldNameSnapshot: "家居服",
      licenseeName: "示例客户",
      priceFen: "128000",
      priceYuan: "1280.00",
      authorizedOn: "2026-10-08",
      note: "首批授权",
      status: "active",
      version: 0,
    });
    expect(replayed).toEqual(created);

    const [state] = await db.execute<{
      authorization_count: number;
      change_count: number;
      commercial_version: number;
    }>(sql`
      select
        (select count(*)::int from authorizations where owner_id = ${ownerId}) as authorization_count,
        (select count(*)::int from change_log where owner_id = ${ownerId}) as change_count,
        commercial_version
      from patterns
      where owner_id = ${ownerId} and id = ${patternId}
    `);
    expect(state).toEqual({
      authorization_count: 1,
      change_count: 1,
      commercial_version: 1,
    });
  });

  it("allows repeated ordinary authorizations in one field", async () => {
    await create();
    await expect(
      create({ commercialVersion: 1, licenseeName: "第二客户" }),
    ).resolves.toMatchObject({ kind: "standard", fieldId: HOMEWEAR_FIELD_ID });
  });

  it("requires confirmation before exclusivity and then locks only that field", async () => {
    await create();
    const exclusiveOperationId = randomUUID();

    await expect(
      create({
        operationId: exclusiveOperationId,
        commercialVersion: 1,
        kind: "field_exclusive",
      }),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED",
      details: expect.objectContaining({ activeCount: 1 }),
    });

    await expect(
      create({
        operationId: exclusiveOperationId,
        commercialVersion: 1,
        kind: "field_exclusive",
        historyConfirmed: true,
      }),
    ).resolves.toMatchObject({ kind: "field_exclusive" });

    await expect(
      create({ commercialVersion: 2 }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FIELD_LOCKED" });
    await expect(
      create({ commercialVersion: 2, fieldId: STATIONERY_FIELD_ID }),
    ).resolves.toMatchObject({ fieldNameSnapshot: "文具纸品" });
  });

  it("requires confirmation before buyout and blocks every future field", async () => {
    await create();
    const buyoutOperationId = randomUUID();

    await expect(
      create({
        operationId: buyoutOperationId,
        commercialVersion: 1,
        kind: "global_buyout",
        fieldId: null,
      }),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_HISTORY_CONFIRMATION_REQUIRED",
    });

    await create({
      operationId: buyoutOperationId,
      commercialVersion: 1,
      kind: "global_buyout",
      fieldId: null,
      historyConfirmed: true,
    });

    await expect(
      create({ commercialVersion: 2, fieldId: STATIONERY_FIELD_ID }),
    ).rejects.toMatchObject({ code: "PATTERN_BOUGHT_OUT" });
  });

  it("rejects non-ready patterns and stale commercial versions", async () => {
    await db.execute(sql`
      update patterns set status = 'trashed' where owner_id = ${ownerId} and id = ${patternId}
    `);
    await expect(create()).rejects.toMatchObject({ code: "PATTERN_NOT_ACTIVE" });

    await db.execute(sql`
      update patterns set status = 'ready' where owner_id = ${ownerId} and id = ${patternId}
    `);
    await create();
    await expect(
      create({ commercialVersion: 0, fieldId: STATIONERY_FIELD_ID }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_STATE_CHANGED" });
  });

  it("edits a full record while excluding itself from buyout history", async () => {
    const created = await create();

    const edited = await editAuthorization({
      ownerId,
      authorizationId: created.id,
      operationId: randomUUID(),
      version: 0,
      commercialVersion: 1,
      kind: "global_buyout",
      fieldId: null,
      licenseeName: "买断客户",
      priceYuan: "5000",
      authorizedOn: "2026-10-09",
      note: null,
      historyConfirmed: false,
    });

    expect(edited).toMatchObject({
      id: created.id,
      kind: "global_buyout",
      fieldId: null,
      fieldNameSnapshot: null,
      priceFen: "500000",
      version: 1,
    });

    await expect(
      editAuthorization({
        ownerId,
        authorizationId: created.id,
        operationId: randomUUID(),
        version: 0,
        commercialVersion: 2,
        kind: "global_buyout",
        fieldId: null,
        licenseeName: "买断客户",
        priceYuan: "5000",
        authorizedOn: "2026-10-09",
        note: null,
        historyConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_STATE_CHANGED" });
  });

  it("voids idempotently and releases a buyout restriction", async () => {
    const buyout = await create({ kind: "global_buyout", fieldId: null });

    const voided = await voidAuthorization({
      ownerId,
      authorizationId: buyout.id,
      operationId: randomUUID(),
      version: 0,
      commercialVersion: 1,
    });
    const repeated = await voidAuthorization({
      ownerId,
      authorizationId: buyout.id,
      operationId: randomUUID(),
      version: 0,
      commercialVersion: 0,
    });

    expect(voided).toMatchObject({ status: "void", version: 1 });
    expect(repeated).toEqual(voided);
    await expect(
      create({ commercialVersion: 2, fieldId: STATIONERY_FIELD_ID }),
    ).resolves.toMatchObject({ status: "active" });

    const [state] = await db.execute<{
      change_count: number;
      commercial_version: number;
    }>(sql`
      select
        (select count(*)::int from change_log where owner_id = ${ownerId}) as change_count,
        commercial_version
      from patterns
      where owner_id = ${ownerId} and id = ${patternId}
    `);
    expect(state).toEqual({ change_count: 3, commercial_version: 3 });
  });

  it("rejects restore when another exclusive authorization now owns the field", async () => {
    const first = await create({ kind: "field_exclusive" });
    await voidAuthorization({
      ownerId,
      authorizationId: first.id,
      operationId: randomUUID(),
      version: 0,
      commercialVersion: 1,
    });
    await create({ commercialVersion: 2, kind: "field_exclusive" });

    await expect(
      restoreAuthorization({
        ownerId,
        authorizationId: first.id,
        operationId: randomUUID(),
        version: 1,
        commercialVersion: 3,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_RESTORE_CONFLICT" });
  });

  it("rejects restore after its custom field was archived", async () => {
    const field = await createAuthorizationField({
      ownerId,
      operationId: randomUUID(),
      name: "童装",
    });
    const authorization = await create({ fieldId: field.id });
    await voidAuthorization({
      ownerId,
      authorizationId: authorization.id,
      operationId: randomUUID(),
      version: 0,
      commercialVersion: 1,
    });
    await archiveAuthorizationField({
      ownerId,
      fieldId: field.id,
      operationId: randomUUID(),
    });

    await expect(
      restoreAuthorization({
        ownerId,
        authorizationId: authorization.id,
        operationId: randomUUID(),
        version: 1,
        commercialVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_RESTORE_CONFLICT" });
  });

  it("hides another owner's authorization from mutations", async () => {
    const created = await create();
    const attackerId = randomUUID();
    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values (${attackerId}, 'authorization-attacker@example.test', 'Attacker', 'test-password-hash')
    `);

    await expect(
      voidAuthorization({
        ownerId: attackerId,
        authorizationId: created.id,
        operationId: randomUUID(),
        version: 0,
        commercialVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

