import type { Locator, Page } from "@playwright/test";

import { E2E_USERS } from "./environment";
import {
  browserRequest,
  E2E_PATTERN_SEEDS,
  expect,
  loginAs,
  readChangeLog,
  readTenantSnapshot,
  test,
} from "./fixtures";

type FolderDto = {
  id: string;
  name: string;
  parentId: string | null;
};

type PatternItem = {
  folderId: string | null;
  id: string;
};

type PatternPage = {
  items: PatternItem[];
  nextCursor: string | null;
};

async function createFolder(page: Page, name: string) {
  await page.getByLabel("文件夹名称").fill(name);
  await page.getByLabel("文件夹名称").press("Enter");
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
}

async function selectSeedPatterns(page: Page) {
  for (const [index, pattern] of E2E_PATTERN_SEEDS.folderWorkflow.entries()) {
    const checkbox = page.getByRole("checkbox", {
      name: `选择 ${pattern.name}`,
    });
    if (index === 0) await checkbox.click();
    else await checkbox.click({ modifiers: ["Meta"] });
  }
}

function seedCard(page: Page, name: string): Locator {
  return page.getByRole("listitem", { name: new RegExp(`^${name},`) });
}

function requireRow<T extends { id: string }>(rows: readonly T[], id: string) {
  const row = rows.find((candidate) => candidate.id === id);
  expect(row).toBeDefined();
  return row!;
}

async function expectSingleChange(
  seq: string,
  operation: string,
  entityId?: string,
) {
  const rows = (await readChangeLog(E2E_USERS.designer.id)).filter(
    (row) => row.seq === seq,
  );
  expect(rows).toEqual([
    expect.objectContaining({
      operation,
      seq,
      ...(entityId === undefined ? {} : { entityId }),
    }),
  ]);
}

test("manages nested folders and restores folder and pattern trash", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "One browser owns the shared workflow state");

  await loginAs(page, E2E_USERS.designer);

  await page.getByRole("button", { name: "新建文件夹" }).click();
  await createFolder(page, "夏日果园");

  await page.getByRole("button", { name: "夏日果园的操作" }).click();
  await page.getByRole("menuitem", { name: "新建子文件夹" }).click();
  await createFolder(page, "柑橘");

  await page.getByRole("button", { name: "夏日果园的操作" }).click();
  await page.getByRole("menuitem", { name: "新建子文件夹" }).click();
  const duplicateName = page.getByLabel("文件夹名称");
  await duplicateName.fill("柑橘");
  await duplicateName.press("Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: "同名文件夹" }),
  ).toContainText("同名文件夹");
  await expect(duplicateName).toHaveValue("柑橘");
  await duplicateName.press("Escape");

  await page.getByRole("button", { name: "新建文件夹" }).click();
  await createFolder(page, "参考图库");
  await page.getByRole("button", { name: "参考图库的操作" }).click();
  await page.getByRole("menuitem", { name: "重命名" }).click();
  const renameDraft = page.getByLabel("文件夹名称");
  await renameDraft.fill("夏日果园");
  await renameDraft.press("Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: "同名文件夹" }),
  ).toContainText("同名文件夹");
  await expect(renameDraft).toHaveValue("夏日果园");
  await renameDraft.press("Escape");

  await selectSeedPatterns(page);
  const bulkActions = page.getByLabel("批量操作");
  await expect(bulkActions).toContainText("已选择 2 项");
  await bulkActions.getByRole("button", { name: "移动" }).click();
  await page.getByRole("menuitem", { name: "柑橘", exact: true }).click();

  const folderResponse = await browserRequest<FolderDto[]>(page, "/api/folders");
  expect(folderResponse.status).toBe(200);
  const root = folderResponse.body.find((folder) => folder.name === "夏日果园");
  const child = folderResponse.body.find(
    (folder) => folder.name === "柑橘" && folder.parentId === root?.id,
  );
  expect(root).toBeDefined();
  expect(child).toBeDefined();

  const expectedPatternIds: string[] = E2E_PATTERN_SEEDS.folderWorkflow
    .map((pattern) => pattern.id)
    .sort();
  await expect
    .poll(async () => {
      const response = await browserRequest<PatternPage>(
        page,
        `/api/patterns?folderId=${child!.id}&includeDescendants=false`,
      );
      expect(response.status).toBe(200);
      return response.body.items
        .filter((pattern) => expectedPatternIds.includes(pattern.id))
        .map((pattern) => pattern.id)
        .sort();
    })
    .toEqual(expectedPatternIds);

  const directRoot = await browserRequest<PatternPage>(
    page,
    `/api/patterns?folderId=${root!.id}&includeDescendants=false`,
  );
  expect(directRoot.status).toBe(200);
  expect(
    directRoot.body.items.filter((pattern) =>
      expectedPatternIds.includes(pattern.id),
    ),
  ).toEqual([]);

  const movedSnapshot = await readTenantSnapshot(E2E_USERS.designer.id);
  const movedRows = expectedPatternIds.map((patternId) =>
    requireRow(movedSnapshot.patterns, patternId),
  );
  for (const pattern of movedRows) {
    expect(pattern).toEqual(
      expect.objectContaining({
        changeSeq: movedRows[0]!.changeSeq,
        folderId: child!.id,
        status: "ready",
      }),
    );
  }
  await expectSingleChange(movedRows[0]!.changeSeq, "patterns.moved");

  await page.getByRole("link", { name: "柑橘", exact: true }).click();
  for (const pattern of E2E_PATTERN_SEEDS.folderWorkflow) {
    await expect(seedCard(page, pattern.name)).toHaveCount(1);
  }

  await page.getByRole("link", { name: "未分类", exact: true }).click();
  await expect(page).toHaveURL(/(?:\?|&)unfiled=true(?:&|$)/);
  await expect(
    seedCard(page, E2E_PATTERN_SEEDS.isolationActor.name),
  ).toHaveCount(1);
  const unfiled = await browserRequest<PatternPage>(page, "/api/patterns?unfiled=true");
  expect(unfiled.status).toBe(200);
  for (const pattern of E2E_PATTERN_SEEDS.folderWorkflow) {
    expect(unfiled.body.items).not.toContainEqual(
      expect.objectContaining({ id: pattern.id }),
    );
    await expect(seedCard(page, pattern.name)).toHaveCount(0);
  }

  await page.getByRole("button", { name: "夏日果园的操作" }).click();
  await page.getByRole("menuitem", { name: "移入回收站" }).click();
  const folderDialog = page.getByRole("dialog", {
    name: "将“夏日果园”移入回收站",
  });
  await expect(folderDialog).toContainText(/将影响 2 个文件夹和 2\s*个图案/);
  await folderDialog.getByRole("button", { name: "确认移入回收站" }).click();
  await expect(folderDialog).toBeHidden();
  await expect(
    page.getByRole("link", { name: "夏日果园", exact: true }),
  ).toHaveCount(0);

  const trashedSnapshot = await readTenantSnapshot(E2E_USERS.designer.id);
  const trashedRoot = requireRow(trashedSnapshot.folders, root!.id);
  const trashedChild = requireRow(trashedSnapshot.folders, child!.id);
  expect(trashedRoot).toEqual(
    expect.objectContaining({
      parentId: null,
      status: "trashed",
      trashBatchId: expect.any(String),
    }),
  );
  expect(trashedChild).toEqual(
    expect.objectContaining({
      parentId: root!.id,
      status: "trashed",
      trashBatchId: trashedRoot.trashBatchId,
      changeSeq: trashedRoot.changeSeq,
    }),
  );
  for (const patternId of expectedPatternIds) {
    expect(requireRow(trashedSnapshot.patterns, patternId)).toEqual(
      expect.objectContaining({
        folderId: child!.id,
        status: "trashed",
        preTrashStatus: "ready",
        trashBatchId: trashedRoot.trashBatchId,
        changeSeq: trashedRoot.changeSeq,
      }),
    );
  }
  await expectSingleChange(
    trashedRoot.changeSeq,
    "folder_tree.trashed",
    root!.id,
  );

  await page.getByRole("link", { name: "回收站", exact: true }).click();
  const folderBatch = page.getByRole("region", { name: "夏日果园" });
  await expect(folderBatch).toContainText("2 个文件夹 · 2 个图案");
  await folderBatch.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(folderBatch).toHaveCount(0);

  await page.getByRole("link", { name: "全部图案", exact: true }).click();
  const childLink = page.getByRole("link", { name: "柑橘", exact: true });
  if (!(await childLink.isVisible())) {
    await page.getByRole("button", { name: "展开夏日果园" }).click();
  }
  await expect(childLink).toBeVisible();
  await childLink.click();
  for (const pattern of E2E_PATTERN_SEEDS.folderWorkflow) {
    await expect(seedCard(page, pattern.name)).toHaveCount(1);
  }

  const restoredSnapshot = await readTenantSnapshot(E2E_USERS.designer.id);
  const restoredRoot = requireRow(restoredSnapshot.folders, root!.id);
  const restoredChild = requireRow(restoredSnapshot.folders, child!.id);
  expect(restoredRoot).toEqual(
    expect.objectContaining({
      parentId: null,
      status: "active",
      trashBatchId: null,
      trashedAt: null,
    }),
  );
  expect(restoredChild).toEqual(
    expect.objectContaining({
      parentId: root!.id,
      status: "active",
      trashBatchId: null,
      trashedAt: null,
      changeSeq: restoredRoot.changeSeq,
    }),
  );
  for (const patternId of expectedPatternIds) {
    expect(requireRow(restoredSnapshot.patterns, patternId)).toEqual(
      expect.objectContaining({
        folderId: child!.id,
        status: "ready",
        preTrashStatus: null,
        trashBatchId: null,
        trashedAt: null,
        changeSeq: restoredRoot.changeSeq,
      }),
    );
  }
  await expectSingleChange(
    restoredRoot.changeSeq,
    "folder_tree.restored",
    root!.id,
  );

  await selectSeedPatterns(page);
  await expect(bulkActions).toContainText("已选择 2 项");
  await bulkActions.getByRole("button", { name: "移入回收站" }).click();
  const patternDialog = page.getByRole("dialog", { name: "移入回收站" });
  await expect(patternDialog).toContainText("确定将 2 个图案移入回收站吗");
  await patternDialog
    .getByRole("button", { name: "确认移入回收站" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "已将 2 个图案移入回收站",
  );

  const directTrashSnapshot = await readTenantSnapshot(E2E_USERS.designer.id);
  const directTrashRows = expectedPatternIds.map((patternId) =>
    requireRow(directTrashSnapshot.patterns, patternId),
  );
  const directTrashBatchId = directTrashRows[0]!.trashBatchId;
  expect(directTrashBatchId).toEqual(expect.any(String));
  for (const pattern of directTrashRows) {
    expect(pattern).toEqual(
      expect.objectContaining({
        folderId: child!.id,
        status: "trashed",
        preTrashStatus: "ready",
        trashBatchId: directTrashBatchId,
        changeSeq: directTrashRows[0]!.changeSeq,
      }),
    );
  }
  await expectSingleChange(
    directTrashRows[0]!.changeSeq,
    "patterns.trashed",
    directTrashBatchId!,
  );

  await page.getByRole("link", { name: "回收站", exact: true }).click();
  const patternBatch = page.getByRole("region", { name: "已删除图案批次" });
  await expect(patternBatch).toContainText("图案 · 2 项");
  const restored = E2E_PATTERN_SEEDS.folderWorkflow[0];
  const retained = E2E_PATTERN_SEEDS.folderWorkflow[1];
  await patternBatch
    .getByRole("checkbox", { name: `选择${restored.name}` })
    .check();
  await patternBatch.getByRole("button", { name: "恢复所选" }).click();
  await expect(
    page.getByRole("checkbox", { name: `选择${restored.name}` }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: `选择${retained.name}` }),
  ).toBeVisible();
  await expect(patternBatch).toContainText("图案 · 1 项");

  const partialRestore = await readTenantSnapshot(E2E_USERS.designer.id);
  const restoredPattern = requireRow(partialRestore.patterns, restored.id);
  const retainedPattern = requireRow(partialRestore.patterns, retained.id);
  expect(restoredPattern).toEqual(
    expect.objectContaining({
      folderId: child!.id,
      status: "ready",
      preTrashStatus: null,
      trashBatchId: null,
      trashedAt: null,
    }),
  );
  expect(retainedPattern).toEqual(
    expect.objectContaining({
      folderId: child!.id,
      status: "trashed",
      preTrashStatus: "ready",
      trashBatchId: directTrashBatchId,
    }),
  );
  await expectSingleChange(
    restoredPattern.changeSeq,
    "patterns.restored",
  );
});
