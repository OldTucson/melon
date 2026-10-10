import "fake-indexeddb/auto";

import { Blob as NodeBlob } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";

import {
  createUploadDatabase,
  deleteCheckpoint,
  listRecoverableUploads,
  loadCheckpoint,
  saveCheckpoint,
  type UploadCheckpointRow,
} from "./upload-db";

const row = (): UploadCheckpointRow => ({
  localTaskId: "local-1",
  ownerId: "10000000-0000-4000-8000-000000000000",
  patternId: "00000000-0000-4000-8000-000000000001",
  sourceAssetId: "00000000-0000-4000-8000-000000000002",
  previewAssetId: "00000000-0000-4000-8000-000000000003",
  thumbnailAssetId: "00000000-0000-4000-8000-000000000004",
  operationId: "00000000-0000-4000-8000-000000000005",
  sessionId: "00000000-0000-4000-8000-000000000006",
  filename: "leaf.png",
  extension: "png",
  size: 123,
  lastModified: 456,
  contentHash: "a".repeat(64),
  objectKeys: { source: "users/u/patterns/p/source/id.png" },
  sdkCheckpoints: {
    source: {
      uploadId: "upload-1",
      doneParts: [{ number: 1, etag: "etag" }],
      file: new File(["secret bytes"], "leaf.png"),
      credentials: {
        accessKeySecret: "must-not-persist",
        securityToken: "must-not-persist",
      },
      nested: new NodeBlob(["also secret"]),
    },
  },
  updatedAt: 789,
});

describe("upload checkpoint database", () => {
  const databases: ReturnType<typeof createUploadDatabase>[] = [];

  afterEach(async () => {
    await Promise.all(databases.map((database) => database.delete()));
    databases.length = 0;
  });

  it("persists recovery metadata without file bytes or credentials", async () => {
    const database = createUploadDatabase(`melon-upload-test-${crypto.randomUUID()}`);
    databases.push(database);

    await saveCheckpoint(database, row());
    const restored = await loadCheckpoint(database, "local-1");
    const serialized = JSON.stringify(restored);

    expect(restored?.sdkCheckpoints.source).toMatchObject({
      uploadId: "upload-1",
      doneParts: [{ number: 1, etag: "etag" }],
    });
    expect(serialized).not.toMatch(
      /secret bytes|also secret|accessKeySecret|securityToken|must-not-persist|credentials|\"file\":/i,
    );
    expect(restored?.sdkCheckpoints.source).not.toBeInstanceOf(Blob);
  });

  it("lists and deletes recoverable uploads", async () => {
    const database = createUploadDatabase(`melon-upload-test-${crypto.randomUUID()}`);
    databases.push(database);
    await saveCheckpoint(database, row());

    expect(
      await listRecoverableUploads(
        database,
        "10000000-0000-4000-8000-000000000000",
      ),
    ).toHaveLength(1);
    expect(
      await listRecoverableUploads(
        database,
        "20000000-0000-4000-8000-000000000000",
      ),
    ).toEqual([]);
    await deleteCheckpoint(database, "local-1");
    expect(await listRecoverableUploads(database)).toEqual([]);
  });
});
