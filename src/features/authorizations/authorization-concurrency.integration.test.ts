import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, db } from "@/lib/db/client";
import { resetDatabase } from "@/test/database";

import { createAuthorization } from "./authorization-service";

describe("authorization concurrency", () => {
  let ownerId: string;
  let patternId: string;

  beforeEach(async () => {
    await resetDatabase();
    ownerId = randomUUID();
    patternId = randomUUID();

    await db.execute(sql`
      insert into users (id, email, display_name, password_hash)
      values (${ownerId}, 'authorization-race@example.test', 'Owner', 'test-password-hash')
    `);
    await db.execute(sql`
      insert into patterns (
        id, owner_id, name, original_filename, extension, size_bytes, status
      ) values (
        ${patternId}, ${ownerId}, 'Race', 'race.psd', 'psd', 1024, 'ready'
      )
    `);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("serializes a standard grant and buyout at the same commercial version", async () => {
    const base = {
      ownerId,
      patternId,
      commercialVersion: 0,
      licenseeName: "并发客户",
      priceYuan: "1000",
      authorizedOn: "2026-10-08",
      note: null,
      historyConfirmed: false,
    };

    const results = await Promise.allSettled([
      createAuthorization({
        ...base,
        operationId: randomUUID(),
        kind: "standard",
        fieldId: "00000000-0000-4000-8000-000000000001",
      }),
      createAuthorization({
        ...base,
        operationId: randomUUID(),
        kind: "global_buyout",
        fieldId: null,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const [rejected] = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      code: "AUTHORIZATION_STATE_CHANGED",
    });

    const [state] = await db.execute<{
      active_count: number;
      commercial_version: number;
    }>(sql`
      select
        (select count(*)::int from authorizations where owner_id = ${ownerId} and pattern_id = ${patternId} and status = 'active') as active_count,
        commercial_version
      from patterns
      where owner_id = ${ownerId} and id = ${patternId}
    `);
    expect(state).toEqual({ active_count: 1, commercial_version: 1 });
  });
});
