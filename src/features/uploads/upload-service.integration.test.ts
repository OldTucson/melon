import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  previewObjectKey,
  sourceObjectKey,
} from "@/features/storage/object-keys";
import { UPLOAD_WRITE_DRAIN_GRACE_MS } from "@/features/storage/upload-timing";
import type {
  BrowserCredentialIssuer,
  BrowserOssCredentials,
} from "@/features/storage/contracts";
import { closeDatabase, db } from "@/lib/db/client";
import {
  assets,
  changeLog,
  operations,
  patterns,
  uploadSessions,
  users,
  visualSearchJobs,
} from "@/lib/db/schema";
import { resetDatabase } from "@/test/database";
import { FakeCredentialIssuer, FakeOssAdapter } from "@/test/fake-oss";

import type {
  UploadCompleteInput,
  UploadInitInput,
} from "./contracts";
import { parseUploadComplete } from "./contracts";
import {
  createUploadService,
  uploadLifecycleEventId,
} from "./upload-service";

const INITIAL_NOW = new Date("2026-10-09T10:00:00.000Z");
const PSD_BYTES = new TextEncoder().encode("8BPS");
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const WEBP_BYTES = new TextEncoder().encode("RIFF1234WEBP");

async function installRejectVisualSearchJobTrigger() {
  await db.execute(sql.raw(`
    create or replace function test_reject_visual_search_job_insert()
    returns trigger language plpgsql as $$
    begin
      raise exception 'TEST_VISUAL_SEARCH_ENQUEUE_FAILED';
    end;
    $$
  `));
  await db.execute(sql.raw(`
    create trigger test_reject_visual_search_job_insert
    before insert on visual_search_jobs
    for each row execute function test_reject_visual_search_job_insert()
  `));
}

async function removeRejectVisualSearchJobTrigger() {
  await db.execute(
    sql.raw(
      "drop trigger if exists test_reject_visual_search_job_insert on visual_search_jobs",
    ),
  );
  await db.execute(
    sql.raw("drop function if exists test_reject_visual_search_job_insert()"),
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const browserCredentials = (): BrowserOssCredentials => ({
  accessKeyId: "STS.blocked",
  accessKeySecret: "temporary-secret",
  securityToken: "temporary-token",
  expiration: "2026-10-09T10:15:00.000Z",
  region: "oss-cn-hangzhou",
  bucket: "melon-test-assets",
  endpoint: "https://assets.example.test",
  cname: true,
});

class BlockingCredentialIssuer implements BrowserCredentialIssuer {
  readonly started = deferred<void>();
  readonly response = deferred<BrowserOssCredentials>();

  async issue() {
    this.started.resolve(undefined);
    return this.response.promise;
  }
}

class SlowCredentialIssuer implements BrowserCredentialIssuer {
  async issue() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return browserCredentials();
  }
}

class BlockingHeadOssAdapter extends FakeOssAdapter {
  readonly started = deferred<void>();
  readonly headRelease = deferred<void>();

  override async headObject(key: string) {
    this.started.resolve(undefined);
    await this.headRelease.promise;
    return super.headObject(key);
  }
}

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

const initInput = (overrides: Partial<UploadInitInput> = {}): UploadInitInput => ({
  patternId: randomUUID(),
  sourceAssetId: randomUUID(),
  operationId: randomUUID(),
  originalFilename: "Watermelon Bloom.psd",
  extension: "psd",
  sizeBytes: PSD_BYTES.byteLength,
  lastModified: 1_760_000_000_000,
  contentHash: "a".repeat(64),
  ...overrides,
});

const sourceCompletion = (
  initialized: Awaited<ReturnType<ReturnType<typeof createUploadService>["initialize"]>>,
): UploadCompleteInput => ({
  operationId: initialized.operationId,
  assets: [
    {
      assetId: initialized.sourceAsset.id,
      role: "source",
      objectKey: initialized.sourceAsset.objectKey,
      extension: initialized.pattern.extension as "psd",
      sizeBytes: Number(initialized.sourceAsset.sizeBytes),
    },
  ],
});

class FlakyCredentialIssuer implements BrowserCredentialIssuer {
  attempts = 0;

  async issue(): Promise<BrowserOssCredentials> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("SDK secret failure detail");
    return {
      accessKeyId: "STS.recovered",
      accessKeySecret: "temporary-secret",
      securityToken: "temporary-token",
      expiration: "2026-10-09T10:15:00.000Z",
      region: "oss-cn-hangzhou",
      bucket: "melon-test-assets",
      endpoint: "https://assets.example.test",
      cname: true,
    };
  }
}

describe("upload service lifecycle", () => {
  let ownerA: string;
  let ownerB: string;
  let now: Date;
  let oss: FakeOssAdapter;
  let issuer: FakeCredentialIssuer;
  let service: ReturnType<typeof createUploadService>;

  beforeEach(async () => {
    await resetDatabase();
    ownerA = await seedUser("upload-a@example.test");
    ownerB = await seedUser("upload-b@example.test");
    now = new Date(INITIAL_NOW);
    oss = new FakeOssAdapter();
    issuer = new FakeCredentialIssuer({ now: () => now });
    service = createUploadService({
      database: db,
      oss,
      credentialIssuer: issuer,
      now: () => now,
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("initializes once and exact replay reissues credentials without duplicating rows", async () => {
    const input = initInput();

    const first = await service.initialize({ ownerId: ownerA, input });
    const replay = await service.initialize({ ownerId: ownerA, input });

    expect(replay.pattern.id).toBe(first.pattern.id);
    expect(replay.session.id).toBe(first.session.id);
    expect(replay.sourceAsset.id).toBe(first.sourceAsset.id);
    expect(first.pattern.status).toBe("uploading");
    expect(first.pattern).toMatchObject({
      paletteStatus: "pending",
      palette: [],
    });
    expect(first.session.status).toBe("initialized");
    expect(issuer.issues).toHaveLength(2);
    expect(replay.credentials.accessKeyId).not.toBe(
      first.credentials.accessKeyId,
    );

    expect(await db.select().from(patterns)).toHaveLength(1);
    expect(await db.select().from(assets)).toHaveLength(1);
    expect(await db.select().from(uploadSessions)).toHaveLength(1);
    expect(await db.select().from(changeLog)).toHaveLength(1);
    const [operation] = await db.select().from(operations);
    expect(operation?.result).toMatchObject({
      initialized: {
        pattern: { id: input.patternId },
        sourceAsset: { id: input.sourceAssetId },
      },
    });
    expect(JSON.stringify(operation?.result)).not.toMatch(
      /accessKey|secret|securityToken|signed/i,
    );
  });

  it("rejects operation reuse with a changed initialization fingerprint", async () => {
    const input = initInput();
    await service.initialize({ ownerId: ownerA, input });

    await expect(
      service.initialize({
        ownerId: ownerA,
        input: { ...input, originalFilename: "Changed.psd" },
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    expect(await db.select().from(patterns)).toHaveLength(1);
  });

  it("commits initialization before STS and safely recovers on the same operation", async () => {
    const flaky = new FlakyCredentialIssuer();
    const flakyService = createUploadService({
      database: db,
      oss,
      credentialIssuer: flaky,
      now: () => now,
    });
    const input = initInput();

    await expect(
      flakyService.initialize({ ownerId: ownerA, input }),
    ).rejects.toMatchObject({
      code: "UPLOAD_CREDENTIALS_UNAVAILABLE",
      status: 503,
      message: expect.not.stringMatching(/SDK|secret/i),
    });
    const recovered = await flakyService.initialize({ ownerId: ownerA, input });

    expect(recovered.credentials.accessKeyId).toBe("STS.recovered");
    expect(flaky.attempts).toBe(2);
    expect(await db.select().from(patterns)).toHaveLength(1);
    expect(await db.select().from(assets)).toHaveLength(1);
    expect(await db.select().from(uploadSessions)).toHaveLength(1);
  });

  it("persists an issuance fence before STS and the exact credential expiration afterward", async () => {
    const blockedIssuer = new BlockingCredentialIssuer();
    const blockedService = createUploadService({
      database: db,
      oss,
      credentialIssuer: blockedIssuer,
      now: () => now,
    });
    const input = initInput();
    const pending = blockedService.initialize({ ownerId: ownerA, input });
    await blockedIssuer.started.promise;

    const [duringIssue] = await db
      .select({
        credentialIssueFenceAt: uploadSessions.credentialIssueFenceAt,
        credentialsExpireAt: uploadSessions.credentialsExpireAt,
      })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.ownerId, ownerA),
          eq(uploadSessions.operationId, input.operationId),
        ),
      );
    expect(duringIssue?.credentialIssueFenceAt?.getTime()).toBe(
      now.getTime() +
        15 * 60 * 1_000 +
        30_000 +
        UPLOAD_WRITE_DRAIN_GRACE_MS,
    );
    expect(duringIssue?.credentialsExpireAt).toBeNull();

    const credentials = browserCredentials();
    blockedIssuer.response.resolve(credentials);
    await expect(pending).resolves.toMatchObject({ credentials });

    const [afterIssue] = await db
      .select({
        credentialIssueFenceAt: uploadSessions.credentialIssueFenceAt,
        credentialsExpireAt: uploadSessions.credentialsExpireAt,
      })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.ownerId, ownerA),
          eq(uploadSessions.operationId, input.operationId),
        ),
      );
    expect(afterIssue?.credentialIssueFenceAt).toBeNull();
    expect(afterIssue?.credentialsExpireAt?.toISOString()).toBe(
      credentials.expiration,
    );
  });

  it("bounds credential issuance and retains the conservative fence on timeout", async () => {
    const timedService = createUploadService({
      database: db,
      oss,
      credentialIssuer: new SlowCredentialIssuer(),
      credentialIssueTimeoutMs: 5,
      now: () => now,
    });
    const input = initInput();

    await expect(
      timedService.initialize({ ownerId: ownerA, input }),
    ).rejects.toMatchObject({
      code: "UPLOAD_CREDENTIALS_UNAVAILABLE",
      status: 503,
    });

    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.operationId, input.operationId));
    expect(session?.credentialIssueFenceAt?.getTime()).toBe(
      now.getTime() +
        15 * 60 * 1_000 +
        5 +
        UPLOAD_WRITE_DRAIN_GRACE_MS,
    );
    expect(session?.credentialsExpireAt).toBeNull();
  });

  it.each(["cancel", "complete", "expire"] as const)(
    "does not return initialization credentials after a concurrent %s transition",
    async (transition) => {
      const blockedIssuer = new BlockingCredentialIssuer();
      const blockedService = createUploadService({
        database: db,
        oss,
        credentialIssuer: blockedIssuer,
        now: () => now,
      });
      const input = initInput();
      const pending = blockedService.initialize({ ownerId: ownerA, input });
      await blockedIssuer.started.promise;
      const [session] = await db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.operationId, input.operationId));
      const [source] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, input.sourceAssetId));
      expect(session).toBeDefined();
      expect(source).toBeDefined();

      if (transition === "cancel") {
        await service.cancel({
          ownerId: ownerA,
          sessionId: session!.id,
          input: { operationId: input.operationId },
        });
      } else if (transition === "complete") {
        oss.putObject(source!.objectKey, PSD_BYTES);
        await service.complete({
          ownerId: ownerA,
          sessionId: session!.id,
          input: {
            operationId: input.operationId,
            assets: [
              {
                assetId: source!.id,
                role: "source",
                objectKey: source!.objectKey,
                extension: "psd",
                sizeBytes: PSD_BYTES.byteLength,
              },
            ],
          },
        });
      } else {
        now = new Date(session!.expiresAt);
        await expect(
          service.refreshCredentials({
            ownerId: ownerA,
            sessionId: session!.id,
            operationId: input.operationId,
          }),
        ).rejects.toMatchObject({ code: "UPLOAD_SESSION_EXPIRED" });
      }

      blockedIssuer.response.resolve(browserCredentials());
      await expect(pending).rejects.toMatchObject({
        code:
          transition === "expire"
            ? "UPLOAD_SESSION_EXPIRED"
            : "UPLOAD_SESSION_INVALID_STATE",
      });
    },
  );

  it.each(["cancel", "complete", "expire"] as const)(
    "does not return refreshed credentials after a concurrent %s transition",
    async (transition) => {
      const initialized = await service.initialize({
        ownerId: ownerA,
        input: initInput(),
      });
      const blockedIssuer = new BlockingCredentialIssuer();
      const blockedService = createUploadService({
        database: db,
        oss,
        credentialIssuer: blockedIssuer,
        now: () => now,
      });
      const pending = blockedService.refreshCredentials({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        operationId: initialized.operationId,
      });
      await blockedIssuer.started.promise;

      if (transition === "cancel") {
        await service.cancel({
          ownerId: ownerA,
          sessionId: initialized.session.id,
          input: { operationId: initialized.operationId },
        });
      } else if (transition === "complete") {
        oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
        await service.complete({
          ownerId: ownerA,
          sessionId: initialized.session.id,
          input: sourceCompletion(initialized),
        });
      } else {
        now = new Date(initialized.session.expiresAt);
        await expect(
          service.refreshCredentials({
            ownerId: ownerA,
            sessionId: initialized.session.id,
            operationId: initialized.operationId,
          }),
        ).rejects.toMatchObject({ code: "UPLOAD_SESSION_EXPIRED" });
      }
      blockedIssuer.response.resolve(browserCredentials());

      await expect(pending).rejects.toMatchObject({
        code:
          transition === "expire"
            ? "UPLOAD_SESSION_EXPIRED"
            : "UPLOAD_SESSION_INVALID_STATE",
      });
    },
  );

  it.each(["pattern", "asset"] as const)(
    "maps a global client %s UUID collision to a stable conflict",
    async (collision) => {
      const existing = await service.initialize({ ownerId: ownerB, input: initInput() });
      const input = initInput({
        ...(collision === "pattern" ? { patternId: existing.pattern.id } : {}),
        ...(collision === "asset" ? { sourceAssetId: existing.sourceAsset.id } : {}),
      });

      await expect(service.initialize({ ownerId: ownerA, input })).rejects.toMatchObject({
        code: "UPLOAD_ID_CONFLICT",
        status: 409,
        message: expect.not.stringMatching(/duplicate|constraint|sql/i),
      });
      expect(
        await db.select().from(patterns).where(eq(patterns.ownerId, ownerA)),
      ).toHaveLength(0);
      expect(
        await db.select().from(operations).where(eq(operations.ownerId, ownerA)),
      ).toHaveLength(0);
    },
  );

  it("hides foreign sessions exactly like missing sessions across lifecycle calls", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    const complete = sourceCompletion(initialized);

    for (const sessionId of [initialized.session.id, randomUUID()]) {
      await expect(
        service.refreshCredentials({
          ownerId: ownerB,
          sessionId,
          operationId: initialized.operationId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        service.complete({ ownerId: ownerB, sessionId, input: complete }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        service.cancel({
          ownerId: ownerB,
          sessionId,
          input: { operationId: initialized.operationId },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
  });

  it("never resurrects a deleting pattern through any upload lifecycle call", async () => {
    const input = initInput();
    const initialized = await service.initialize({ ownerId: ownerA, input });
    await db
      .update(patterns)
      .set({ status: "deleting" })
      .where(eq(patterns.id, initialized.pattern.id));
    await db
      .update(uploadSessions)
      .set({ status: "aborted" })
      .where(eq(uploadSessions.id, initialized.session.id));

    await expect(service.initialize({ ownerId: ownerA, input })).rejects.toMatchObject({
      code: "UPLOAD_SESSION_INVALID_STATE",
      status: 409,
    });
    await expect(
      service.refreshCredentials({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        operationId: initialized.operationId,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALID_STATE", status: 409 });
    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: sourceCompletion(initialized),
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALID_STATE", status: 409 });
    await expect(
      service.cancel({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: { operationId: initialized.operationId },
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SESSION_INVALID_STATE", status: 409 });

    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, initialized.pattern.id));
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    expect(pattern?.status).toBe("deleting");
    expect(session?.status).toBe("aborted");
  });

  it("expires refresh at the exact boundary and persists diagnostics", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    now = new Date(initialized.session.expiresAt);

    await expect(
      service.refreshCredentials({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        operationId: initialized.operationId,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_SESSION_EXPIRED",
      status: 410,
    });

    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, initialized.pattern.id));
    expect(session).toMatchObject({
      status: "expired",
      lastErrorCode: "UPLOAD_SESSION_EXPIRED",
    });
    expect(pattern).toMatchObject({
      status: "failed",
      lastErrorCode: "UPLOAD_SESSION_EXPIRED",
    });
  });

  it("refreshes the same active operation without storing credential material", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });

    const first = await service.refreshCredentials({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      operationId: initialized.operationId,
    });
    const second = await service.refreshCredentials({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      operationId: initialized.operationId,
    });

    expect(first.credentials.accessKeyId).not.toBe(
      second.credentials.accessKeyId,
    );
    expect(await db.select().from(operations)).toHaveLength(1);
    const [operation] = await db.select().from(operations);
    expect(JSON.stringify(operation?.result)).not.toMatch(
      /accessKey|secret|securityToken|signed/i,
    );
  });

  it("updates the source placeholder and completes exact replay once", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES, "text/plain");
    const input = sourceCompletion(initialized);

    const [first, replay] = await Promise.all([
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input,
      }),
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input,
      }),
    ]);

    expect(first.pattern).toMatchObject({
      id: initialized.pattern.id,
      status: "ready",
      detectedMimeType: "image/vnd.adobe.photoshop",
      paletteStatus: "pending",
      palette: [],
    });
    expect(replay).toEqual(first);
    const sourceRows = await db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.patternId, initialized.pattern.id),
          eq(assets.role, "source"),
        ),
      );
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0]).toMatchObject({
      id: initialized.sourceAsset.id,
      detectedMimeType: "image/vnd.adobe.photoshop",
    });
    expect(await db.select().from(visualSearchJobs)).toEqual([]);

    const events = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.ownerId, ownerA));
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.operation).sort()).toEqual([
      "upload.completed",
      "upload.initialized",
    ]);
    const completeEvent = events.find(
      (event) => event.operation === "upload.completed",
    );
    expect(completeEvent?.operationId).toBe(
      uploadLifecycleEventId(initialized.operationId, "completed"),
    );
    expect(completeEvent?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(completeEvent?.operationId).not.toBe(initialized.operationId);
    expect(first).not.toHaveProperty("changeOperationId");
    expect(
      uploadLifecycleEventId(initialized.operationId, "completed"),
    ).toBe(completeEvent?.operationId);
    expect(
      uploadLifecycleEventId(initialized.operationId, "cancelled"),
    ).not.toBe(completeEvent?.operationId);
    expect(() =>
      parseUploadComplete({
        ...input,
        operationId: completeEvent!.operationId,
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

    const [operation] = await db.select().from(operations);
    expect(operation?.result).toMatchObject({
      initialized: { pattern: { id: initialized.pattern.id } },
      completion: {
        result: { pattern: { status: "ready" } },
      },
    });
  });

  it("rejects a changed completion payload after exact replay", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const input = sourceCompletion(initialized);
    await service.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input,
    });

    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: {
          ...input,
          assets: [{ ...input.assets[0]!, sizeBytes: 3 }],
        },
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
  });

  it("claims the first failed completion fingerprint and rejects a changed retry", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    const first = sourceCompletion(initialized);

    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: first,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_STORAGE_UNAVAILABLE" });
    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: {
          ...first,
          assets: [{ ...first.assets[0]!, sizeBytes: 3 }],
        },
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REUSED", status: 409 });
    const [operation] = await db.select().from(operations);
    expect(operation?.result).toMatchObject({
      initialized: { pattern: { id: initialized.pattern.id } },
      completion: { fingerprint: expect.any(String) },
    });
  });

  it("replays a completed result after session expiry without changing terminal state", async () => {
    const init = initInput();
    const initialized = await service.initialize({ ownerId: ownerA, input: init });
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const completion = sourceCompletion(initialized);
    const completed = await service.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input: completion,
    });
    now = new Date(Date.parse(initialized.session.expiresAt) + 1);

    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: completion,
      }),
    ).resolves.toEqual(completed);

    await expect(
      service.refreshCredentials({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        operationId: initialized.operationId,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_SESSION_INVALID_STATE",
      status: 409,
    });
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, initialized.pattern.id));
    expect(session?.status).toBe("completed");
    expect(pattern?.status).toBe("ready");

    const issuesBeforeInitReplay = issuer.issues.length;
    await expect(
      service.initialize({ ownerId: ownerA, input: init }),
    ).rejects.toMatchObject({
      code: "UPLOAD_SESSION_INVALID_STATE",
      status: 409,
    });
    expect(issuer.issues).toHaveLength(issuesBeforeInitReplay);
  });

  it("serializes concurrent different completion payloads instead of last-writer-wins", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const base = sourceCompletion(initialized);
    const previewA = {
      assetId: randomUUID(),
      role: "preview" as const,
      objectKey: "",
      extension: "png" as const,
      sizeBytes: PNG_BYTES.byteLength,
      width: 64,
      height: 64,
    };
    previewA.objectKey = `users/${ownerA}/patterns/${initialized.pattern.id}/derived/${previewA.assetId}.png`;
    const previewB = { ...previewA, assetId: randomUUID() };
    previewB.objectKey = `users/${ownerA}/patterns/${initialized.pattern.id}/derived/${previewB.assetId}.png`;
    oss.putObject(previewA.objectKey, PNG_BYTES);
    oss.putObject(previewB.objectKey, PNG_BYTES);

    const settled = await Promise.allSettled([
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: { ...base, assets: [...base.assets, previewA] },
      }),
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: { ...base, assets: [...base.assets, previewB] },
      }),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejection = settled.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: { code: "OPERATION_ID_REUSED", status: 409 },
    });
    expect(
      await db
        .select()
        .from(assets)
        .where(eq(assets.patternId, initialized.pattern.id)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(changeLog)
        .where(eq(changeLog.ownerId, ownerA)),
    ).toHaveLength(2);
  });

  it("releases the database transaction while OSS verification is pending", async () => {
    const initialized = await service.initialize({ ownerId: ownerA, input: initInput() });
    const blockingOss = new BlockingHeadOssAdapter();
    blockingOss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const blockedService = createUploadService({
      database: db,
      oss: blockingOss,
      credentialIssuer: issuer,
      now: () => now,
      verificationTimeoutMs: 5_000,
    });
    const pending = blockedService.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input: sourceCompletion(initialized),
    });
    await blockingOss.started.promise;

    const ordinaryQuery = await db.select({ id: users.id }).from(users).limit(1);
    const transactionActivity = await db.execute(sql<{ count: number }>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state = 'idle in transaction'
    `);
    blockingOss.headRelease.resolve(undefined);
    await pending;

    expect(ordinaryQuery).toHaveLength(1);
    expect(transactionActivity[0]?.count).toBe(0);
  });

  it("lets cancel win while verification is blocked and never resurrects the session", async () => {
    const initialized = await service.initialize({ ownerId: ownerA, input: initInput() });
    const blockingOss = new BlockingHeadOssAdapter();
    blockingOss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const blockedService = createUploadService({
      database: db,
      oss: blockingOss,
      credentialIssuer: issuer,
      now: () => now,
      verificationTimeoutMs: 5_000,
    });
    const completion = blockedService.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input: sourceCompletion(initialized),
    });
    await blockingOss.started.promise;

    const cancellation = service.cancel({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input: { operationId: initialized.operationId },
    });
    const cancelWon = await Promise.race([
      cancellation.then(() => true, () => false),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    blockingOss.headRelease.resolve(undefined);
    const [completionResult, cancellationResult] = await Promise.allSettled([
      completion,
      cancellation,
    ]);

    expect(cancelWon).toBe(true);
    expect(cancellationResult).toMatchObject({ status: "fulfilled" });
    expect(completionResult).toMatchObject({
      status: "rejected",
      reason: { code: "UPLOAD_SESSION_INVALID_STATE" },
    });
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    expect(session?.status).toBe("aborted");
  });

  it("allows the same completion payload to recover a completing session", async () => {
    const initialized = await service.initialize({ ownerId: ownerA, input: initInput() });
    const blockingOss = new BlockingHeadOssAdapter();
    blockingOss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const blockedService = createUploadService({
      database: db,
      oss: blockingOss,
      credentialIssuer: issuer,
      now: () => now,
      verificationTimeoutMs: 5_000,
    });
    const input = sourceCompletion(initialized);
    const abandoned = blockedService.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input,
    });
    await blockingOss.started.promise;

    const recovery = service.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input,
    });
    const recoveredBeforeRelease = await Promise.race([
      recovery.then(() => true, () => false),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    blockingOss.headRelease.resolve(undefined);
    const [recovered, replay] = await Promise.all([recovery, abandoned]);

    expect(recoveredBeforeRelease).toBe(true);
    expect(replay).toEqual(recovered);
    expect(
      await db
        .select()
        .from(changeLog)
        .where(and(eq(changeLog.ownerId, ownerA), eq(changeLog.operation, "upload.completed"))),
    ).toHaveLength(1);
  });

  it("does not let a late verification failure overwrite a successful completion", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    const blockingOss = new BlockingHeadOssAdapter();
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const blockedService = createUploadService({
      database: db,
      oss: blockingOss,
      credentialIssuer: issuer,
      now: () => now,
      verificationTimeoutMs: 5_000,
    });
    const input = sourceCompletion(initialized);
    const lateFailure = blockedService.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input,
    });
    await blockingOss.started.promise;

    const completed = await service.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input,
    });
    blockingOss.headRelease.resolve(undefined);

    await expect(lateFailure).resolves.toEqual(completed);
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    expect(session).toMatchObject({ status: "completed", lastErrorCode: null });
    expect(
      await db
        .select()
        .from(changeLog)
        .where(
          and(
            eq(changeLog.ownerId, ownerA),
            eq(changeLog.operation, "upload.completed"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("lets expiry win while verification is blocked", async () => {
    const initialized = await service.initialize({ ownerId: ownerA, input: initInput() });
    const blockingOss = new BlockingHeadOssAdapter();
    blockingOss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const blockedService = createUploadService({
      database: db,
      oss: blockingOss,
      credentialIssuer: issuer,
      now: () => now,
      verificationTimeoutMs: 5_000,
    });
    const completion = blockedService.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input: sourceCompletion(initialized),
    });
    await blockingOss.started.promise;
    now = new Date(initialized.session.expiresAt);

    const expiry = service.refreshCredentials({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      operationId: initialized.operationId,
    });
    const expiryWon = await Promise.race([
      expiry.then(() => false, (error: { code?: string }) => error.code === "UPLOAD_SESSION_EXPIRED"),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    blockingOss.headRelease.resolve(undefined);

    expect(expiryWon).toBe(true);
    await expect(completion).rejects.toMatchObject({ code: "UPLOAD_SESSION_EXPIRED" });
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    expect(session?.status).toBe("expired");
  });

  it("times out blocked OSS verification and persists a retryable failure", async () => {
    const initialized = await service.initialize({ ownerId: ownerA, input: initInput() });
    const blockingOss = new BlockingHeadOssAdapter();
    blockingOss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const timedService = createUploadService({
      database: db,
      oss: blockingOss,
      credentialIssuer: issuer,
      now: () => now,
      verificationTimeoutMs: 20,
    });
    const completion = timedService.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input: sourceCompletion(initialized),
    });
    await blockingOss.started.promise;
    const outcome = await Promise.race([
      completion.then(
        () => ({ code: "resolved" }),
        (error: { code?: string }) => ({ code: error.code }),
      ),
      new Promise<{ code: string }>((resolve) =>
        setTimeout(() => resolve({ code: "test-timeout" }), 200),
      ),
    ]);
    blockingOss.headRelease.resolve(undefined);
    await completion.catch(() => undefined);

    expect(outcome).toEqual({ code: "UPLOAD_STORAGE_UNAVAILABLE" });
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    expect(session).toMatchObject({
      status: "failed",
      lastErrorCode: "UPLOAD_STORAGE_UNAVAILABLE",
    });
  });

  it("persists signature mismatch without making the pattern ready and can retry", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    oss.putObject(
      initialized.sourceAsset.objectKey,
      new TextEncoder().encode("NOPE"),
    );
    const input = sourceCompletion(initialized);

    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SIGNATURE_MISMATCH" });

    const [failedPattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, initialized.pattern.id));
    const [failedSession] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    expect(failedPattern).toMatchObject({
      status: "failed",
      lastErrorCode: "UPLOAD_SIGNATURE_MISMATCH",
    });
    expect(failedSession).toMatchObject({
      status: "failed",
      lastErrorCode: "UPLOAD_SIGNATURE_MISMATCH",
    });
    expect(
      await db
        .select()
        .from(assets)
        .where(eq(assets.patternId, initialized.pattern.id)),
    ).toHaveLength(1);

    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input,
      }),
    ).resolves.toMatchObject({ pattern: { status: "ready" } });
  });

  it("maps OSS failures without leaking them and retains a retryable diagnostic", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    const input = sourceCompletion(initialized);

    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_STORAGE_UNAVAILABLE",
      status: 503,
      message: expect.not.stringMatching(/OSS_OBJECT_NOT_FOUND/i),
    });
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    expect(session).toMatchObject({
      status: "failed",
      lastErrorCode: "UPLOAD_STORAGE_UNAVAILABLE",
    });

    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input,
      }),
    ).resolves.toMatchObject({ pattern: { status: "ready" } });
  });

  it("cancels idempotently from the browser abort report and refuses completed sessions", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    const input = {
      operationId: initialized.operationId,
      multipartAbort: { attempted: true, succeeded: false },
    };

    const first = await service.cancel({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input,
    });
    const replay = await service.cancel({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input,
    });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      session: { status: "aborted" },
      warning: "UPLOAD_MULTIPART_CLEANUP_PENDING",
    });

    const another = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    oss.putObject(another.sourceAsset.objectKey, PSD_BYTES);
    await service.complete({
      ownerId: ownerA,
      sessionId: another.session.id,
      input: sourceCompletion(another),
    });
    await expect(
      service.cancel({
        ownerId: ownerA,
        sessionId: another.session.id,
        input: { operationId: another.operationId },
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_CANNOT_CANCEL_COMPLETED",
      status: 409,
    });
  });

  it("authorizes source downloads, derived views, and sanitizes signed filenames", async () => {
    const maliciousName = "\r\n../'\"bad\\name.psd";
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput({ originalFilename: "Safe source.psd" }),
    });
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const previewId = randomUUID();
    const previewKey = `users/${ownerA}/patterns/${initialized.pattern.id}/derived/${previewId}.png`;
    oss.putObject(previewKey, PNG_BYTES);
    const completed = await service.complete({
      ownerId: ownerA,
      sessionId: initialized.session.id,
      input: {
        ...sourceCompletion(initialized),
        assets: [
          ...sourceCompletion(initialized).assets,
          {
            assetId: previewId,
            role: "preview",
            objectKey: previewKey,
            extension: "png",
            sizeBytes: PNG_BYTES.byteLength,
            width: 100,
            height: 100,
          },
        ],
      },
    });
    await db
      .update(assets)
      .set({ originalFilename: maliciousName })
      .where(eq(assets.id, initialized.sourceAsset.id));

    const download = await service.signAssetDownload({
      ownerId: ownerA,
      assetId: initialized.sourceAsset.id,
    });
    const view = await service.signAssetView({
      ownerId: ownerA,
      assetId: completed.assets.find((asset) => asset.role === "preview")!.id,
    });

    expect(download.location).toContain("expires=300");
    expect(download.location).not.toMatch(/[\r\n'"\\]/);
    expect(oss.signedGets.at(-2)).toMatchObject({
      expiresSeconds: 300,
      filename: "..badname.psd",
    });
    expect(view.location).toContain("expires=60");
    expect(oss.signedGets.at(-1)).toMatchObject({ expiresSeconds: 60 });

    await expect(
      service.signAssetView({
        ownerId: ownerA,
        assetId: initialized.sourceAsset.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      service.signAssetDownload({ ownerId: ownerA, assetId: previewId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    for (const assetId of [initialized.sourceAsset.id, randomUUID()]) {
      await expect(
        service.signAssetDownload({ ownerId: ownerB, assetId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }

    await db
      .update(assets)
      .set({ originalFilename: "\r\n/\\'\"\u0001" })
      .where(eq(assets.id, initialized.sourceAsset.id));
    await service.signAssetDownload({
      ownerId: ownerA,
      assetId: initialized.sourceAsset.id,
    });
    expect(oss.signedGets.at(-1)?.filename).toBe("download.psd");

    await db
      .update(assets)
      .set({ originalFilename: "瓜".repeat(200) + ".psd" })
      .where(eq(assets.id, initialized.sourceAsset.id));
    await service.signAssetDownload({
      ownerId: ownerA,
      assetId: initialized.sourceAsset.id,
    });
    expect(
      new TextEncoder().encode(oss.signedGets.at(-1)?.filename).byteLength,
    ).toBeLessThanOrEqual(180);
    expect(oss.signedGets.at(-1)?.filename).toMatch(/\.psd$/);
  });

  it("completes and signs a bounded derived WebP preview", async () => {
    const originalFilename = `${"🍉".repeat(125)}x.psd`;
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput({ originalFilename }),
    });
    expect(initialized.pattern.name.length).toBeLessThanOrEqual(160);
    expect(initialized.pattern.name).not.toMatch(/[\uD800-\uDBFF]$/);
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const previewId = randomUUID();
    const previewKey = previewObjectKey({
      ownerId: ownerA,
      patternId: initialized.pattern.id,
      assetId: previewId,
      extension: "webp",
    });
    oss.putObject(previewKey, WEBP_BYTES, "text/plain");

    const completionInput: UploadCompleteInput = {
      ...sourceCompletion(initialized),
      assets: [
        ...sourceCompletion(initialized).assets,
        {
          assetId: previewId,
          role: "preview",
          objectKey: previewKey,
          extension: "webp",
          sizeBytes: WEBP_BYTES.byteLength,
          width: 2048,
          height: 2048,
        },
      ],
    };
    const [completed, replay] = await Promise.all([
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: completionInput,
      }),
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: completionInput,
      }),
    ]);
    expect(replay).toEqual(completed);
    const preview = completed.assets.find((asset) => asset.role === "preview");
    expect(preview).toMatchObject({
      id: previewId,
      detectedMimeType: "image/webp",
      originalFilename: "preview.webp",
    });
    expect(await db.select().from(visualSearchJobs)).toEqual([
      expect.objectContaining({
        ownerId: ownerA,
        patternId: initialized.pattern.id,
        previewAssetId: previewId,
        indexVersion: "visual-search-v2",
        status: "pending",
        attemptCount: 0,
        maxAttempts: 5,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    await service.signAssetView({ ownerId: ownerA, assetId: previewId });
    expect(oss.signedGets.at(-1)).toMatchObject({
      filename: "preview.webp",
      expiresSeconds: 60,
    });
  });

  it("rolls back upload completion when preview indexing cannot be enqueued", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    oss.putObject(initialized.sourceAsset.objectKey, PSD_BYTES);
    const previewId = randomUUID();
    const previewKey = previewObjectKey({
      ownerId: ownerA,
      patternId: initialized.pattern.id,
      assetId: previewId,
      extension: "webp",
    });
    oss.putObject(previewKey, WEBP_BYTES);
    const completionInput: UploadCompleteInput = {
      ...sourceCompletion(initialized),
      assets: [
        ...sourceCompletion(initialized).assets,
        {
          assetId: previewId,
          role: "preview",
          objectKey: previewKey,
          extension: "webp",
          sizeBytes: WEBP_BYTES.byteLength,
          width: 2048,
          height: 2048,
        },
      ],
    };

    await installRejectVisualSearchJobTrigger();
    try {
      await expect(
        service.complete({
          ownerId: ownerA,
          sessionId: initialized.session.id,
          input: completionInput,
        }),
      ).rejects.toBeDefined();
    } finally {
      await removeRejectVisualSearchJobTrigger();
    }

    const [pattern] = await db
      .select()
      .from(patterns)
      .where(eq(patterns.id, initialized.pattern.id));
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, initialized.session.id));
    const assetRows = await db
      .select()
      .from(assets)
      .where(eq(assets.patternId, initialized.pattern.id));
    expect(pattern).toMatchObject({
      status: "processing",
      previewStatus: "pending",
      version: 0,
    });
    expect(session?.status).toBe("completing");
    expect(assetRows).toEqual([
      expect.objectContaining({
        id: initialized.sourceAsset.id,
        role: "source",
        detectedMimeType: null,
      }),
    ]);
    expect(await db.select().from(visualSearchJobs)).toEqual([]);
  });

  it("does not accept a foreign-looking source key even when its size matches", async () => {
    const initialized = await service.initialize({
      ownerId: ownerA,
      input: initInput(),
    });
    const foreignKey = sourceObjectKey({
      ownerId: ownerB,
      patternId: initialized.pattern.id,
      assetId: initialized.sourceAsset.id,
      extension: "psd",
    });
    oss.putObject(foreignKey, PSD_BYTES);
    const completion = sourceCompletion(initialized);

    await expect(
      service.complete({
        ownerId: ownerA,
        sessionId: initialized.session.id,
        input: {
          ...completion,
          assets: [{ ...completion.assets[0]!, objectKey: foreignKey }],
        },
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_OBJECT_INVALID", status: 422 });
  });
});
