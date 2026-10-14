import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { batchPatterns } from "@/features/patterns/pattern-batch-service";
import { closeDatabase, db } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env/server";
import { resetDatabase } from "@/test/database";

import { createAuthorization } from "./authorization-service";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("AUTHORIZATION_CONCURRENCY_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForPatternLockWaiter(
  monitor: ReturnType<typeof postgres>,
  blockerPids: readonly number[],
  excludedPids: readonly number[] = [],
) {
  return withTimeout(
    (async () => {
      while (true) {
        const waiters = await monitor<{ pid: number }[]>`
          select activity.pid
          from pg_stat_activity activity
          where activity.datname = current_database()
            and activity.state = 'active'
            and activity.wait_event_type = 'Lock'
            and pg_blocking_pids(activity.pid) && ${blockerPids}::integer[]
            and not (activity.pid = any(${excludedPids}::integer[]))
            and activity.query ilike '%patterns%'
            and activity.query ilike '%for update%'
          order by activity.pid
        `;
        if (waiters[0]) return waiters[0].pid;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })(),
  );
}

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

  it("cannot commit an authorization after an earlier queued trash transition", async () => {
    const databaseUrl = getServerEnv().DATABASE_URL;
    const blocker = postgres(databaseUrl, { max: 1 });
    const monitor = postgres(databaseUrl, { max: 1 });
    const lockReady = deferred();
    const releaseLock = deferred();
    let blockerPid = 0;
    let released = false;
    const blockerTransaction = blocker.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`
        select pg_backend_pid() as pid
      `;
      blockerPid = backend!.pid;
      await tx`
        select id
        from patterns
        where owner_id = ${ownerId} and id = ${patternId}
        for update
      `;
      lockReady.resolve();
      await releaseLock.promise;
    });
    let trash: ReturnType<typeof batchPatterns> | undefined;
    let authorization: ReturnType<typeof createAuthorization> | undefined;

    try {
      await withTimeout(lockReady.promise);
      trash = batchPatterns({
        ownerId,
        mutation: {
          action: "trash",
          operationId: randomUUID(),
          patterns: [{ id: patternId, version: 0 }],
        },
      });
      void trash.catch(() => undefined);
      const trashPid = await waitForPatternLockWaiter(monitor, [blockerPid]);

      authorization = createAuthorization({
        ownerId,
        patternId,
        operationId: randomUUID(),
        commercialVersion: 0,
        kind: "standard",
        fieldId: "00000000-0000-4000-8000-000000000001",
        licenseeName: "Late customer",
        priceYuan: "1000",
        authorizedOn: "2026-10-08",
        note: null,
        historyConfirmed: false,
      });
      void authorization.catch(() => undefined);
      const authorizationPid = await waitForPatternLockWaiter(
        monitor,
        [blockerPid, trashPid],
        [trashPid],
      );
      expect(authorizationPid).not.toBe(trashPid);

      released = true;
      releaseLock.resolve();
      await withTimeout(blockerTransaction);
      await expect(withTimeout(trash)).resolves.toMatchObject({
        patterns: [{ id: patternId, status: "trashed" }],
      });
      await expect(withTimeout(authorization)).rejects.toMatchObject({
        code: "PATTERN_NOT_ACTIVE",
        status: 409,
      });

      const [state] = await db.execute<{
        status: string;
        authorizationCount: number;
      }>(sql`
        select
          pattern.status::text as status,
          (
            select count(*)::int
            from authorizations auth
            where auth.owner_id = ${ownerId}
              and auth.pattern_id = ${patternId}
          ) as "authorizationCount"
        from patterns pattern
        where pattern.owner_id = ${ownerId} and pattern.id = ${patternId}
      `);
      expect(state).toEqual({ status: "trashed", authorizationCount: 0 });
    } finally {
      if (!released) releaseLock.resolve();
      await Promise.allSettled([
        blockerTransaction,
        trash,
        authorization,
        blocker.end({ timeout: 1 }),
        monitor.end({ timeout: 1 }),
      ]);
    }
  });
});
