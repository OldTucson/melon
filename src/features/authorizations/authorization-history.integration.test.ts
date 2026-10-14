import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { resetDatabase } from "@/test/database";

import {
  createAuthorization,
  listAuthorizations,
  voidAuthorization,
} from "./authorization-service";

describe("authorization history", () => {
  let ownerId: string;
  let patternId: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    patternId = randomUUID();
    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values (${ownerId}, 'authorization-history@example.test', 'Owner', 'test-password-hash')
    `);
    await db.execute(sql`
      insert into patterns (
        id, owner_id, name, original_filename, extension, size_bytes, status
      ) values (
        ${patternId}, ${ownerId}, 'History', 'history.psd', 'psd', 1024, 'ready'
      )
    `);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const create = (commercialVersion: number, input: { price: string; date: string }) =>
    createAuthorization({
      ownerId,
      patternId,
      operationId: randomUUID(),
      commercialVersion,
      kind: "standard",
      fieldId: "00000000-0000-4000-8000-000000000001",
      licenseeName: `客户 ${commercialVersion}`,
      priceYuan: input.price,
      authorizedOn: input.date,
      note: null,
      historyConfirmed: false,
    });

  it("returns active history, summary, and stable cursor pages", async () => {
    const first = await create(0, { price: "100", date: "2026-10-07" });
    await create(1, { price: "200", date: "2026-10-08" });
    await voidAuthorization({
      ownerId,
      authorizationId: first.id,
      operationId: randomUUID(),
      version: 0,
      commercialVersion: 2,
    });

    const active = await listAuthorizations({ ownerId, patternId });
    expect(active).toMatchObject({
      commercialVersion: 3,
      summary: {
        state: "standard",
        activeCount: 1,
        revenueFen: "20000",
      },
    });
    expect(active.items).toHaveLength(1);
    expect(active.items[0]?.authorizedOn).toBe("2026-10-08");

    const pageOne = await listAuthorizations({
      ownerId,
      patternId,
      includeVoid: true,
      limit: 1,
    });
    expect(pageOne.items).toHaveLength(1);
    expect(pageOne.nextCursor).toBeTruthy();
    const pageTwo = await listAuthorizations({
      ownerId,
      patternId,
      includeVoid: true,
      limit: 1,
      cursor: pageOne.nextCursor!,
    });
    expect(pageTwo.items).toHaveLength(1);
    expect(pageTwo.items[0]?.id).not.toBe(pageOne.items[0]?.id);
    expect(pageTwo.nextCursor).toBeNull();
  });

  it("returns the same 404 for unknown and cross-owner patterns", async () => {
    const attackerId = randomUUID();
    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values (${attackerId}, 'authorization-history-attacker@example.test', 'Attacker', 'test-password-hash')
    `);

    for (const id of [patternId, randomUUID()]) {
      await expect(
        listAuthorizations({ ownerId: attackerId, patternId: id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
  });
});
