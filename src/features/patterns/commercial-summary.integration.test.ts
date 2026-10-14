import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { SYSTEM_AUTHORIZATION_FIELD_SEED } from "@/features/authorizations/system-fields";
import { closeDatabase, db } from "@/lib/db/client";
import { authorizations, patterns, users } from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";

import { listPatterns } from "./pattern-service";

const fieldA = SYSTEM_AUTHORIZATION_FIELD_SEED[0]!;
const fieldB = SYSTEM_AUTHORIZATION_FIELD_SEED[1]!;

describe("pattern commercial summaries", () => {
  let ownerId: string;
  let otherOwnerId: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    await db.insert(users).values([
      {
        id: ownerId,
        email: "commercial-summary@example.test",
        displayName: "Commercial summary",
        passwordHash: "test-password-hash",
        mustChangePassword: false,
      },
      {
        id: otherOwnerId,
        email: "commercial-summary-other@example.test",
        displayName: "Other owner",
        passwordHash: "test-password-hash",
        mustChangePassword: false,
      },
    ]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function seedPattern(name: string, inputOwnerId = ownerId) {
    const id = randomUUID();
    await db.insert(patterns).values({
      id,
      ownerId: inputOwnerId,
      name,
      originalFilename: `${name}.png`,
      extension: "png",
      sizeBytes: 1024n,
      status: "ready",
      previewStatus: "ready",
      createdAt: new Date("2026-10-08T00:00:00.000Z"),
      updatedAt: new Date("2026-10-08T00:00:00.000Z"),
    });
    return id;
  }

  async function seedAuthorization(input: {
    patternId: string;
    kind: "standard" | "field_exclusive" | "global_buyout";
    fieldId?: string | null;
    fieldName?: string | null;
    priceFen: bigint;
    status?: "active" | "void";
    inputOwnerId?: string;
  }) {
    await db.insert(authorizations).values({
      id: randomUUID(),
      ownerId: input.inputOwnerId ?? ownerId,
      patternId: input.patternId,
      operationId: randomUUID(),
      kind: input.kind,
      fieldId: input.fieldId ?? null,
      fieldNameSnapshot: input.fieldName ?? null,
      licenseeName: `客户-${randomUUID()}`,
      priceFen: input.priceFen,
      authorizedOn: "2026-10-08",
      status: input.status ?? "active",
      voidedAt:
        input.status === "void" ? new Date("2026-10-09T00:00:00.000Z") : null,
    });
  }

  it("returns one active-only summary per pattern with commercial priority", async () => {
    const unlicensed = await seedPattern("A unlicensed");
    const standard = await seedPattern("B standard");
    const exclusive = await seedPattern("C exclusive");
    const buyout = await seedPattern("D buyout");
    const foreign = await seedPattern("E foreign", otherOwnerId);

    await seedAuthorization({
      patternId: standard,
      kind: "standard",
      fieldId: fieldA.id,
      fieldName: fieldA.name,
      priceFen: 12_800n,
    });
    await seedAuthorization({
      patternId: standard,
      kind: "standard",
      fieldId: fieldB.id,
      fieldName: fieldB.name,
      priceFen: 99_999n,
      status: "void",
    });
    await seedAuthorization({
      patternId: exclusive,
      kind: "standard",
      fieldId: fieldB.id,
      fieldName: fieldB.name,
      priceFen: 2_000n,
    });
    await seedAuthorization({
      patternId: exclusive,
      kind: "field_exclusive",
      fieldId: fieldA.id,
      fieldName: fieldA.name,
      priceFen: 3_000n,
    });
    await seedAuthorization({
      patternId: buyout,
      kind: "global_buyout",
      priceFen: 50_000n,
    });
    await seedAuthorization({
      patternId: foreign,
      inputOwnerId: otherOwnerId,
      kind: "standard",
      fieldId: fieldA.id,
      fieldName: fieldA.name,
      priceFen: 777n,
    });

    const result = await listPatterns({
      ownerId,
      input: { sort: "name_asc" },
    });
    const summaries = Object.fromEntries(
      result.items.map((item) => [item.id, item.commercialSummary]),
    );

    expect(summaries).toEqual({
      [unlicensed]: {
        state: "unlicensed",
        activeCount: 0,
        revenueFen: "0",
      },
      [standard]: {
        state: "standard",
        activeCount: 1,
        revenueFen: "12800",
      },
      [exclusive]: {
        state: "field_exclusive",
        activeCount: 2,
        revenueFen: "5000",
      },
      [buyout]: {
        state: "global_buyout",
        activeCount: 1,
        revenueFen: "50000",
      },
    });
  });

  it("filters by exact commercial state and active authorization field", async () => {
    const unlicensed = await seedPattern("A unlicensed");
    const standard = await seedPattern("B standard");
    const exclusive = await seedPattern("C exclusive");
    const buyout = await seedPattern("D buyout");

    await seedAuthorization({
      patternId: standard,
      kind: "standard",
      fieldId: fieldB.id,
      fieldName: fieldB.name,
      priceFen: 100n,
      status: "void",
    });
    await seedAuthorization({
      patternId: standard,
      kind: "standard",
      fieldId: fieldA.id,
      fieldName: fieldA.name,
      priceFen: 200n,
    });
    await seedAuthorization({
      patternId: exclusive,
      kind: "field_exclusive",
      fieldId: fieldB.id,
      fieldName: fieldB.name,
      priceFen: 300n,
    });
    await seedAuthorization({
      patternId: buyout,
      kind: "global_buyout",
      priceFen: 400n,
    });

    const byState = await listPatterns({
      ownerId,
      input: { commercialState: "field_exclusive", sort: "name_asc" },
    });
    expect(byState.items.map((item) => item.id)).toEqual([exclusive]);

    const byField = await listPatterns({
      ownerId,
      input: { authorizationField: fieldB.id, sort: "name_asc" },
    });
    expect(byField.items.map((item) => item.id)).toEqual([exclusive]);

    const unlicensedOnly = await listPatterns({
      ownerId,
      input: { commercialState: "unlicensed", sort: "name_asc" },
    });
    expect(unlicensedOnly.items.map((item) => item.id)).toEqual([unlicensed]);

    const incompatible = await listPatterns({
      ownerId,
      input: {
        commercialState: "global_buyout",
        authorizationField: fieldB.id,
      },
    });
    expect(incompatible.items).toEqual([]);
    expect([standard, buyout]).not.toContain(byField.items[0]?.id);
  });

  it("keeps cursor pagination stable when a commercial filter is active", async () => {
    const first = await seedPattern("Same A");
    const second = await seedPattern("Same B");
    for (const patternId of [first, second]) {
      await seedAuthorization({
        patternId,
        kind: "standard",
        fieldId: fieldA.id,
        fieldName: fieldA.name,
        priceFen: 100n,
      });
    }

    const pageOne = await listPatterns({
      ownerId,
      input: { commercialState: "standard", limit: 1 },
    });
    const pageTwo = await listPatterns({
      ownerId,
      input: {
        commercialState: "standard",
        limit: 1,
        cursor: pageOne.nextCursor!,
      },
    });

    expect(pageOne.nextCursor).not.toBeNull();
    expect(pageTwo.nextCursor).toBeNull();
    expect(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id)))
      .toEqual(new Set([first, second]));
  });
});
