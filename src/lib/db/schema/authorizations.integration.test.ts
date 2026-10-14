import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { resetDatabase } from "@/test/database";

type PostgresConstraintError = {
  code: string;
  constraint_name: string;
};

type AuthorizationKind = "standard" | "field_exclusive" | "global_buyout";

const SYSTEM_FIELD_ID = "00000000-0000-4000-8000-000000000001";

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

const insertAuthorization = (input: {
  ownerId: string;
  patternId: string;
  kind?: AuthorizationKind;
  fieldId?: string | null;
  fieldNameSnapshot?: string | null;
  operationId?: string;
  priceFen?: bigint;
}) => {
  const kind = input.kind ?? "standard";
  const fieldId =
    input.fieldId === undefined
      ? kind === "global_buyout"
        ? null
        : SYSTEM_FIELD_ID
      : input.fieldId;
  const fieldNameSnapshot =
    input.fieldNameSnapshot === undefined
      ? kind === "global_buyout"
        ? null
        : "家居服"
      : input.fieldNameSnapshot;

  return db.execute(sql`
    insert into authorizations (
      id,
      owner_id,
      pattern_id,
      operation_id,
      kind,
      field_id,
      field_name_snapshot,
      licensee_name,
      price_fen,
      authorized_on
    ) values (
      ${randomUUID()},
      ${input.ownerId},
      ${input.patternId},
      ${input.operationId ?? randomUUID()},
      ${kind},
      ${fieldId},
      ${fieldNameSnapshot},
      '示例客户',
      ${input.priceFen ?? 10000n},
      '2026-10-08'
    )
  `);
};

describe("authorization schema", () => {
  let ownerA: string;
  let ownerB: string;
  let patternA: string;
  let patternB: string;

  beforeEach(async () => {
    await resetDatabase();

    ownerA = randomUUID();
    ownerB = randomUUID();
    patternA = randomUUID();
    patternB = randomUUID();

    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values
        (${ownerA}, 'authorization-owner-a@example.test', 'Owner A', 'test-password-hash'),
        (${ownerB}, 'authorization-owner-b@example.test', 'Owner B', 'test-password-hash')
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
      ) values
        (${patternA}, ${ownerA}, 'Garden A', 'garden-a.psd', 'psd', 1024, 'ready'),
        (${patternB}, ${ownerB}, 'Garden B', 'garden-b.psd', 'psd', 1024, 'ready')
    `);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("creates both tables and seeds the immutable field dictionary", async () => {
    const [tables] = await db.execute<{
      authorization_fields: string | null;
      authorizations: string | null;
    }>(sql`
      select
        to_regclass('public.authorization_fields')::text as authorization_fields,
        to_regclass('public.authorizations')::text as authorizations
    `);
    expect(tables).toEqual({
      authorization_fields: "authorization_fields",
      authorizations: "authorizations",
    });

    const fields = await db.execute<{
      id: string;
      name: string;
      scope: string;
      status: string;
    }>(sql`
      select id, name, scope, status
      from authorization_fields
      where scope = 'system'
      order by id
    `);
    expect(fields).toHaveLength(12);
    expect(fields[0]).toEqual({
      id: SYSTEM_FIELD_ID,
      name: "家居服",
      scope: "system",
      status: "active",
    });
    expect(fields.map((field) => field.name)).toEqual([
      "家居服",
      "日用百货",
      "口水巾",
      "家纺床品",
      "服装服饰",
      "婴童用品",
      "箱包鞋帽",
      "文具纸品",
      "餐厨用品",
      "家居装饰",
      "包装礼品",
      "数码配件",
    ]);
  });

  it("ties field scope to owner presence", async () => {
    await expectConstraintViolation(
      db.execute(sql`
        insert into authorization_fields (
          id,
          owner_id,
          scope,
          name,
          normalized_name
        ) values (
          ${randomUUID()},
          ${ownerA},
          'system',
          'Invalid system field',
          'invalid system field'
        )
      `),
      {
        code: "23514",
        constraint_name: "authorization_fields_scope_owner_check",
      },
    );
  });

  it("keeps custom normalized names reserved after archival", async () => {
    await db.execute(sql`
      insert into authorization_fields (
        id,
        owner_id,
        scope,
        name,
        normalized_name,
        status,
        archived_at
      ) values (
        ${randomUUID()},
        ${ownerA},
        'custom',
        '童装',
        '童装',
        'archived',
        now()
      )
    `);

    await expectConstraintViolation(
      db.execute(sql`
        insert into authorization_fields (
          id,
          owner_id,
          scope,
          name,
          normalized_name
        ) values (
          ${randomUUID()},
          ${ownerA},
          'custom',
          '童装',
          '童装'
        )
      `),
      {
        code: "23505",
        constraint_name: "authorization_fields_owner_name_unique",
      },
    );
  });

  it.each([
    ["global_buyout", SYSTEM_FIELD_ID, "家居服"],
    ["standard", null, null],
    ["field_exclusive", null, null],
  ] as const)(
    "rejects invalid %s field shape",
    async (kind, fieldId, fieldNameSnapshot) => {
      await expectConstraintViolation(
        insertAuthorization({
          ownerId: ownerA,
          patternId: patternA,
          kind,
          fieldId,
          fieldNameSnapshot,
        }),
        {
          code: "23514",
          constraint_name: "authorizations_kind_field_check",
        },
      );
    },
  );

  it("rejects negative prices and accepts a zero price", async () => {
    await expectConstraintViolation(
      insertAuthorization({
        ownerId: ownerA,
        patternId: patternA,
        priceFen: -1n,
      }),
      {
        code: "23514",
        constraint_name: "authorizations_price_nonnegative",
      },
    );

    await expect(
      insertAuthorization({
        ownerId: ownerA,
        patternId: patternA,
        priceFen: 0n,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects cross-tenant pattern ownership", async () => {
    await expectConstraintViolation(
      insertAuthorization({ ownerId: ownerA, patternId: patternB }),
      {
        code: "23503",
        constraint_name: "authorizations_owner_pattern_fk",
      },
    );
  });

  it("makes operation IDs unique per owner", async () => {
    const operationId = randomUUID();
    await insertAuthorization({ ownerId: ownerA, patternId: patternA, operationId });

    await expectConstraintViolation(
      insertAuthorization({ ownerId: ownerA, patternId: patternA, operationId }),
      {
        code: "23505",
        constraint_name: "authorizations_owner_operation_unique",
      },
    );
  });

  it("allows repeated ordinary grants in one field", async () => {
    await insertAuthorization({ ownerId: ownerA, patternId: patternA });

    await expect(
      insertAuthorization({ ownerId: ownerA, patternId: patternA }),
    ).resolves.toBeDefined();
  });

  it("allows only one active global buyout per pattern", async () => {
    await insertAuthorization({
      ownerId: ownerA,
      patternId: patternA,
      kind: "global_buyout",
    });

    await expectConstraintViolation(
      insertAuthorization({
        ownerId: ownerA,
        patternId: patternA,
        kind: "global_buyout",
      }),
      {
        code: "23505",
        constraint_name: "authorizations_active_buyout_unique",
      },
    );
  });

  it("allows only one active field-exclusive grant per pattern and field", async () => {
    await insertAuthorization({
      ownerId: ownerA,
      patternId: patternA,
      kind: "field_exclusive",
    });

    await expectConstraintViolation(
      insertAuthorization({
        ownerId: ownerA,
        patternId: patternA,
        kind: "field_exclusive",
      }),
      {
        code: "23505",
        constraint_name: "authorizations_active_field_exclusive_unique",
      },
    );
  });

  it("keeps archived fields referenced by authorization history", async () => {
    const customFieldId = randomUUID();
    await db.execute(sql`
      insert into authorization_fields (
        id,
        owner_id,
        scope,
        name,
        normalized_name
      ) values (
        ${customFieldId},
        ${ownerA},
        'custom',
        '童装',
        '童装'
      )
    `);
    await insertAuthorization({
      ownerId: ownerA,
      patternId: patternA,
      fieldId: customFieldId,
      fieldNameSnapshot: "童装",
    });

    await expect(
      db.execute(sql`
        update authorization_fields
        set status = 'archived', archived_at = now()
        where id = ${customFieldId}
      `),
    ).resolves.toBeDefined();

    const [history] = await db.execute<{ field_name_snapshot: string }>(sql`
      select field_name_snapshot
      from authorizations
      where owner_id = ${ownerA} and pattern_id = ${patternA}
    `);
    expect(history?.field_name_snapshot).toBe("童装");
  });
});
