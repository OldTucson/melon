import { randomUUID } from "node:crypto";

import { E2E_USERS } from "./environment";
import {
  browserRequest,
  browserStatusRequest,
  E2E_PATTERN_SEEDS,
  expect,
  expireUploadSafetyWindowForE2E,
  loginAs,
  readChangeLog,
  readOperationSnapshot,
  readTenantSnapshot,
  test,
  TRANSPARENT_PNG,
} from "./fixtures";
import {
  assertE2eOssObjectsMissing,
  hashE2eOssObjects,
} from "./oss-client";

type PatternDto = {
  folderId: string | null;
  id: string;
  sourceAssetId: string | null;
  status: string;
  trashBatchId: string | null;
  version: number;
};

type PatternPage = {
  items: PatternDto[];
  nextCursor: string | null;
};

type FolderDto = {
  id: string;
  name: string;
  parentId: string | null;
  version: number;
};

type FolderDeleteImpact = {
  alreadyTrashedFolderCount: number;
  alreadyTrashedPatternCount: number;
  folderCount: number;
  hasDeletingEntities: boolean;
  patternCount: number;
  scopeFingerprint: string;
};

type TrashList = {
  folderBatches: Array<{
    rootFolderId: string;
    trashBatchId: string;
  }>;
  patternBatches: unknown[];
};

test("does not expose another tenant's patterns, assets, or upload sessions", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "One browser is sufficient for server isolation");

  await loginAs(page, E2E_USERS.tenant);
  const patternId = randomUUID();
  const sourceAssetId = randomUUID();
  const operationId = randomUUID();
  const initialized = await browserRequest<{
    pattern: { id: string; version: number };
    session: { id: string };
    sourceAsset: { id: string; objectKey: string };
  }>(page, "/api/uploads/init", {
    method: "POST",
    body: {
      patternId,
      sourceAssetId,
      operationId,
      originalFilename: "tenant-private.png",
      extension: "png",
      sizeBytes: TRANSPARENT_PNG.byteLength,
      lastModified: 1_700_000_000_000,
    },
  });
  expect(initialized.status).toBe(200);

  await page.context().clearCookies();
  await loginAs(page, E2E_USERS.designer);

  const list = await browserRequest<{ items: Array<{ id: string }> }>(
    page,
    "/api/patterns",
  );
  expect(list.status).toBe(200);
  expect(list.body.items).not.toContainEqual(expect.objectContaining({ id: patternId }));

  const detail = await browserRequest(page, `/api/patterns/${patternId}`);
  expect(detail.status).toBe(404);

  const update = await browserRequest(page, `/api/patterns/${patternId}`, {
    method: "PATCH",
    body: {
      operationId: randomUUID(),
      patch: { name: "Leaked", version: initialized.body.pattern.version },
    },
  });
  expect(update.status).toBe(404);

  for (const action of ["view", "download"] as const) {
    const asset = await browserRequest(
      page,
      `/api/assets/${initialized.body.sourceAsset.id}/${action}`,
    );
    expect(asset.status).toBe(404);
  }

  const credentials = await browserRequest(
    page,
    `/api/uploads/${initialized.body.session.id}/credentials`,
    {
      method: "POST",
      body: { operationId },
    },
  );
  expect(credentials.status).toBe(404);

  const completion = await browserRequest(
    page,
    `/api/uploads/${initialized.body.session.id}/complete`,
    {
      method: "POST",
      body: {
        operationId,
        assets: [
          {
            assetId: initialized.body.sourceAsset.id,
            role: "source",
            objectKey: initialized.body.sourceAsset.objectKey,
            extension: "png",
            sizeBytes: TRANSPARENT_PNG.byteLength,
          },
        ],
      },
    },
  );
  expect(completion.status).toBe(404);
});

test("rejects cross-tenant folder, batch, restore, and purge identifiers", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "One browser is sufficient for server isolation");

  await loginAs(page, E2E_USERS.tenant);
  const filename = "tenant-folder-private.png";
  await page.getByLabel("选择要上传的图案").setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: TRANSPARENT_PNG,
  });
  await expect(page.getByText("上传完成")).toBeVisible();

  const uploaded = await browserRequest<PatternPage>(
    page,
    "/api/patterns?q=tenant-folder-private",
  );
  expect(uploaded.status).toBe(200);
  expect(uploaded.body.items).toHaveLength(1);
  const victimPattern = uploaded.body.items[0]!;
  expect(victimPattern.sourceAssetId).not.toBeNull();
  const sourceAssetId = victimPattern.sourceAssetId;
  if (!sourceAssetId) throw new Error("E2E_SOURCE_ASSET_MISSING");

  const createdFolder = await browserRequest<FolderDto>(page, "/api/folders", {
    method: "POST",
    body: {
      operationId: randomUUID(),
      input: { name: "租户私有文件夹", parentId: null },
    },
  });
  expect(createdFolder.status).toBe(201);

  const moved = await browserRequest<{ patterns: PatternDto[] }>(
    page,
    "/api/patterns/batch",
    {
      method: "POST",
      body: {
        operationId: randomUUID(),
        action: "move",
        folderId: createdFolder.body.id,
        patterns: [{ id: victimPattern.id, version: victimPattern.version }],
      },
    },
  );
  expect(moved.status).toBe(200);
  expect(moved.body.patterns[0]?.folderId).toBe(createdFolder.body.id);

  const folderTreeBefore = await browserRequest<FolderDto[]>(page, "/api/folders");
  const detailBefore = await browserRequest<PatternDto>(
    page,
    `/api/patterns/${victimPattern.id}`,
  );
  expect(folderTreeBefore.status).toBe(200);
  expect(detailBefore.status).toBe(200);
  const databaseBefore = await readTenantSnapshot(E2E_USERS.tenant.id);
  const victimAssets = databaseBefore.assets.filter(
    (asset) => asset.patternId === victimPattern.id,
  );
  expect(victimAssets.length).toBeGreaterThan(0);
  expect(victimAssets).toContainEqual(
    expect.objectContaining({ id: sourceAssetId, role: "source" }),
  );
  const assetHashesBefore = await hashE2eOssObjects(victimAssets);

  await page.context().clearCookies();
  await loginAs(page, E2E_USERS.designer);

  const foreignFolderQuery = await browserRequest<PatternPage>(
    page,
    `/api/patterns?folderId=${createdFolder.body.id}&includeDescendants=true`,
  );
  expect(foreignFolderQuery.status).toBe(200);
  expect(foreignFolderQuery.body.items).toEqual([]);

  const actor = await browserRequest<PatternDto>(
    page,
    `/api/patterns/${E2E_PATTERN_SEEDS.isolationActor.id}`,
  );
  expect(actor.status).toBe(200);
  const moveIntoForeignFolder = await browserRequest(
    page,
    "/api/patterns/batch",
    {
      method: "POST",
      body: {
        operationId: randomUUID(),
        action: "move",
        folderId: createdFolder.body.id,
        patterns: [{ id: actor.body.id, version: actor.body.version }],
      },
    },
  );
  expect(moveIntoForeignFolder.status).toBe(404);

  const moveForeignPattern = await browserRequest(page, "/api/patterns/batch", {
    method: "POST",
    body: {
      operationId: randomUUID(),
      action: "move",
      folderId: null,
      patterns: [{ id: victimPattern.id, version: detailBefore.body.version }],
    },
  });
  expect(moveForeignPattern.status).toBe(404);

  for (const asset of victimAssets) {
    for (const action of ["view", "download"] as const) {
      const foreignAsset = await browserStatusRequest(
        page,
        `/api/assets/${asset.id}/${action}`,
        "manual",
      );
      expect(foreignAsset.status).toBe(404);
    }
  }

  const foreignImpact = await browserRequest(
    page,
    `/api/folders/${createdFolder.body.id}/delete-impact`,
  );
  expect(foreignImpact.status).toBe(404);

  const attackerFolders = await browserRequest<FolderDto[]>(page, "/api/folders");
  expect(attackerFolders.status).toBe(200);
  expect(attackerFolders.body).not.toContainEqual(
    expect.objectContaining({ id: createdFolder.body.id }),
  );

  await page.context().clearCookies();
  await loginAs(page, E2E_USERS.tenant);

  const folderTreeAfter = await browserRequest<FolderDto[]>(page, "/api/folders");
  const detailAfter = await browserRequest<PatternDto>(
    page,
    `/api/patterns/${victimPattern.id}`,
  );
  expect(folderTreeAfter).toEqual(folderTreeBefore);
  expect(detailAfter).toEqual(detailBefore);
  expect(await readTenantSnapshot(E2E_USERS.tenant.id)).toEqual(databaseBefore);

  expect(await hashE2eOssObjects(victimAssets)).toEqual(assetHashesBefore);

  const impact = await browserRequest<FolderDeleteImpact>(
    page,
    `/api/folders/${createdFolder.body.id}/delete-impact`,
  );
  expect(impact.status).toBe(200);
  expect(impact.body).toEqual(
    expect.objectContaining({ folderCount: 1, patternCount: 1 }),
  );

  const trashOperationId = randomUUID();
  const trashedFolder = await browserRequest<{
    folderCount: number;
    patternCount: number;
    rootFolderId: string;
    trashBatchId: string;
  }>(page, `/api/folders/${createdFolder.body.id}`, {
    method: "DELETE",
    body: {
      operationId: trashOperationId,
      version: createdFolder.body.version,
      expectedImpact: impact.body,
    },
  });
  expect(trashedFolder.status).toBe(200);
  expect(trashedFolder.body).toEqual(
    expect.objectContaining({
      folderCount: 1,
      patternCount: 1,
      rootFolderId: createdFolder.body.id,
      trashBatchId: trashOperationId,
    }),
  );

  const trashBefore = await browserRequest<TrashList>(page, "/api/trash");
  const trashedDetailBefore = await browserRequest<PatternDto>(
    page,
    `/api/patterns/${victimPattern.id}`,
  );
  expect(trashBefore.status).toBe(200);
  expect(trashedDetailBefore.status).toBe(200);
  expect(trashBefore.body.folderBatches).toContainEqual(
    expect.objectContaining({
      rootFolderId: createdFolder.body.id,
      trashBatchId: trashOperationId,
    }),
  );
  const trashedDatabaseBefore = await readTenantSnapshot(E2E_USERS.tenant.id);

  await page.context().clearCookies();
  await loginAs(page, E2E_USERS.designer);

  for (const action of ["restore", "purge"] as const) {
    const patterns = await browserRequest(page, `/api/trash/patterns/${action}`, {
      method: "POST",
      body: {
        operationId: randomUUID(),
        patternIds: [victimPattern.id],
      },
    });
    expect(patterns.status).toBe(404);

    const folderBatch = await browserRequest(
      page,
      `/api/trash/folder-batches/${trashOperationId}/${action}`,
      {
        method: "POST",
        body: { operationId: randomUUID() },
      },
    );
    expect(folderBatch.status).toBe(404);
  }

  const attackerTrash = await browserRequest<TrashList>(page, "/api/trash");
  expect(attackerTrash.status).toBe(200);
  expect(attackerTrash.body.folderBatches).not.toContainEqual(
    expect.objectContaining({ trashBatchId: trashOperationId }),
  );

  await page.context().clearCookies();
  await loginAs(page, E2E_USERS.tenant);

  const trashAfter = await browserRequest<TrashList>(page, "/api/trash");
  const trashedDetailAfter = await browserRequest<PatternDto>(
    page,
    `/api/patterns/${victimPattern.id}`,
  );
  expect(trashAfter).toEqual(trashBefore);
  expect(trashedDetailAfter).toEqual(trashedDetailBefore);
  expect(await readTenantSnapshot(E2E_USERS.tenant.id)).toEqual(
    trashedDatabaseBefore,
  );

  expect(await hashE2eOssObjects(victimAssets)).toEqual(assetHashesBefore);

  const purgeOperationId = randomUUID();
  const deferredPurge = await browserRequest<{
    error: { code: string };
  }>(page, `/api/trash/folder-batches/${trashOperationId}/purge`, {
    method: "POST",
    body: { operationId: purgeOperationId },
  });
  expect(deferredPurge.status).toBe(409);
  expect(deferredPurge.body.error.code).toBe("TRASH_PURGE_DEFERRED");
  expect(await hashE2eOssObjects(victimAssets)).toEqual(assetHashesBefore);

  const deferredSnapshot = await readTenantSnapshot(E2E_USERS.tenant.id);
  expect(
    deferredSnapshot.folders.find(
      (folder) => folder.id === createdFolder.body.id,
    ),
  ).toEqual(
    expect.objectContaining({
      status: "deleting",
      trashBatchId: trashOperationId,
    }),
  );
  expect(
    deferredSnapshot.patterns.find(
      (pattern) => pattern.id === victimPattern.id,
    ),
  ).toEqual(
    expect.objectContaining({
      preTrashStatus: "ready",
      status: "deleting",
      trashBatchId: trashOperationId,
    }),
  );
  expect(
    deferredSnapshot.assets.filter(
      (asset) => asset.patternId === victimPattern.id,
    ),
  ).toEqual(victimAssets);
  expect(
    await readOperationSnapshot(E2E_USERS.tenant.id, purgeOperationId),
  ).toEqual({
    kind: expect.stringMatching(/^trash\.folder-batch\.purge:[0-9a-f]{64}$/),
    result: {
      state: "pending",
      target: { kind: "folder_batch", trashBatchId: trashOperationId },
    },
  });

  await expireUploadSafetyWindowForE2E(
    E2E_USERS.tenant.id,
    victimPattern.id,
  );
  const purged = await browserRequest<{
    deletedFolderCount: number;
    deletedPatternCount: number;
    state: string;
  }>(page, `/api/trash/folder-batches/${trashOperationId}/purge`, {
    method: "POST",
    body: { operationId: purgeOperationId },
  });
  expect(purged.status).toBe(200);
  expect(purged.body).toEqual({
    deletedFolderCount: 1,
    deletedPatternCount: 1,
    state: "complete",
  });

  const afterPurge = await readTenantSnapshot(E2E_USERS.tenant.id);
  const folderTombstone = afterPurge.folders.find(
    (folder) => folder.id === createdFolder.body.id,
  );
  const patternTombstone = afterPurge.patterns.find(
    (pattern) => pattern.id === victimPattern.id,
  );
  expect(folderTombstone).toEqual(
    expect.objectContaining({
      parentId: null,
      status: "deleted",
      trashBatchId: null,
      deletedAt: expect.any(Date),
    }),
  );
  expect(patternTombstone).toEqual(
    expect.objectContaining({
      folderId: null,
      status: "deleted",
      trashBatchId: null,
      preTrashStatus: null,
      deletedAt: expect.any(Date),
      changeSeq: folderTombstone?.changeSeq,
    }),
  );
  expect(
    afterPurge.assets.filter((asset) => asset.patternId === victimPattern.id),
  ).toEqual([]);
  await expect(
    assertE2eOssObjectsMissing(victimAssets.map((asset) => asset.objectKey)),
  ).resolves.toBeUndefined();
  const purgeChanges = (await readChangeLog(E2E_USERS.tenant.id)).filter(
    (row) => row.seq === folderTombstone?.changeSeq,
  );
  expect(purgeChanges).toEqual([
    expect.objectContaining({
      entityId: createdFolder.body.id,
      operation: "folder_tree.deleted",
      operationId: purgeOperationId,
    }),
  ]);
  for (const asset of victimAssets) {
    const action = asset.role === "source" ? "download" : "view";
    const deletedAsset = await browserStatusRequest(
      page,
      `/api/assets/${asset.id}/${action}`,
      "manual",
    );
    expect(deletedAsset.status).toBe(404);
  }
});
