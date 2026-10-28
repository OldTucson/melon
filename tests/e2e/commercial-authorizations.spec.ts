import { randomUUID } from "node:crypto";

import type { AuthorizationFieldDto } from "../../src/features/authorizations/api";
import { currentDateInTimeZone } from "../../src/features/authorizations/dates";
import { HOMEWEAR_FIELD_ID, seedCommercialPattern } from "../../src/test/fixtures/authorization-seed";
import { changeStatus, expect, fillAuthorization, history, openCommercial, saveAuthorization, test } from "./commercial-fixtures";
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_USERS } from "./environment";
import { browserRequest, loginAs } from "./fixtures";

test("repeated licensing, edit, exclusivity, restore conflict and buyout history", async ({ page }, info) => {
  const pattern = await seedCommercialPattern(E2E_DATABASE_URL, E2E_USERS.designer.id, `${info.project.name}:rules`);
  await loginAs(page, E2E_USERS.designer);
  await openCommercial(page, pattern.id);
  for (const [customer, price] of [["普通客户甲", "1000"], ["普通客户乙", "500"]]) {
    await fillAuthorization(page, { customer: customer!, price: price! });
    await saveAuthorization(page, customer!);
  }
  await page.getByRole("button", { name: "更多操作 普通客户乙", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑记录" }).click();
  await page.getByLabel("授权价格", { exact: true }).fill("600");
  await saveAuthorization(page, "普通客户乙");
  await expect(page.getByRole("article", { name: "普通客户乙授权记录" })).toContainText("¥600.00");

  await fillAuthorization(page, { customer: "独占客户", price: "5000", kind: "field_exclusive" });
  await saveAuthorization(page, "独占客户", 2);
  await expect(page.getByLabel("授权汇总")).toContainText("领域独占");
  await fillAuthorization(page, { customer: "被阻止客户", price: "100" });
  const blocked = page.waitForResponse((response) => response.url().endsWith(`/api/patterns/${pattern.id}/authorizations`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "保存授权" }).click();
  const rejection = await blocked;
  expect(rejection.status()).toBe(409);
  expect(await rejection.json()).toMatchObject({ error: { code: "AUTHORIZATION_FIELD_LOCKED" } });
  await expect(page.getByRole("alert").filter({ hasText: "授权记录未能保存" })).toBeVisible();
  await expect(page.getByRole("article", { name: "被阻止客户授权记录" })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭授权表单" }).click();

  await fillAuthorization(page, { customer: "文具客户", price: "800", field: "文具纸品" });
  await saveAuthorization(page, "文具客户");
  await changeStatus(page, "普通客户甲", "void");
  await page.getByLabel("显示作废记录").check();
  await expect(page.getByRole("article", { name: "普通客户甲授权记录" })).toContainText("已作废");
  await changeStatus(page, "普通客户甲", "restore");
  await expect(page.getByRole("status")).toContainText("当前授权状态冲突，无法恢复这条记录");

  await fillAuthorization(page, { customer: "买断客户", price: "10000", kind: "global_buyout" });
  await saveAuthorization(page, "买断客户", 3);
  await expect(page.getByLabel("授权汇总")).toContainText("¥16,400.00");
  await expect(page.getByRole("button", { name: "新增授权", exact: true })).toBeDisabled();
  const state = await history(page, pattern.id);
  const boughtOut = await browserRequest(page, `/api/patterns/${pattern.id}/authorizations`, {
    method: "POST", body: {
      operationId: randomUUID(), commercialVersion: state.commercialVersion,
      kind: "standard", fieldId: HOMEWEAR_FIELD_ID, licenseeName: "绕过界面客户",
      priceYuan: "1", authorizedOn: currentDateInTimeZone(), note: null, historyConfirmed: true,
    },
  });
  expect(boughtOut).toMatchObject({ status: 409, body: { error: { code: "PATTERN_BOUGHT_OUT" } } });
  expect((await history(page, pattern.id)).items).toHaveLength(5);
});

test("refreshes stale versions and creates then archives custom fields", async ({ page }, info) => {
  const pattern = await seedCommercialPattern(E2E_DATABASE_URL, E2E_USERS.designer.id, `${info.project.name}:stale`);
  const fieldName = `布艺-${info.project.name}`;
  await loginAs(page, E2E_USERS.designer);
  await openCommercial(page, pattern.id);
  await fillAuthorization(page, { customer: "过期草稿", price: "100" });
  const remote = await browserRequest(page, `/api/patterns/${pattern.id}/authorizations`, {
    method: "POST", body: {
      operationId: randomUUID(), commercialVersion: 0,
      kind: "standard", fieldId: HOMEWEAR_FIELD_ID, licenseeName: "另一窗口客户",
      priceYuan: "200", authorizedOn: currentDateInTimeZone(), note: null, historyConfirmed: false,
    },
  });
  expect(remote.status).toBe(201);
  await page.getByRole("button", { name: "保存授权" }).click();
  await expect(page.getByRole("status")).toContainText("授权状态已更新，请重新操作");
  await expect(page.getByRole("article", { name: "另一窗口客户授权记录" })).toBeVisible();
  await expect(page.getByRole("article", { name: "过期草稿授权记录" })).toHaveCount(0);

  await page.getByRole("button", { name: "新增授权", exact: true }).click();
  await page.getByRole("button", { name: "新建授权领域" }).click();
  await page.getByLabel("自定义授权领域名称").fill(fieldName);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "授权领域", exact: true })).toHaveValue(fieldName);
  await page.getByLabel("授权客户", { exact: true }).fill("自定义领域客户");
  await page.getByLabel("授权价格", { exact: true }).fill("300");
  await saveAuthorization(page, "自定义领域客户");
  await expect(page.getByLabel("授权汇总")).toContainText("¥500.00");

  await page.goto("/settings");
  await page.getByRole("button", { name: `归档 ${fieldName}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "归档授权领域" });
  await expect(dialog).toContainText("历史授权记录会保留");
  await dialog.getByRole("button", { name: "确认归档" }).click();
  await expect(dialog).toBeHidden();
  await openCommercial(page, pattern.id);
  await expect(page.getByRole("article", { name: "自定义领域客户授权记录" })).toContainText(fieldName);
  await page.getByRole("button", { name: "新增授权", exact: true }).click();
  await page.getByRole("combobox", { name: "授权领域", exact: true }).fill(fieldName);
  await expect(page.getByRole("listbox").getByRole("option", { name: fieldName, exact: true })).toHaveCount(0);
  await expect(page.getByText("没有匹配的领域")).toBeVisible();
});

test("trash preserves read-only history, restores and explains permanent-delete impact", async ({ page }, info) => {
  const pattern = await seedCommercialPattern(E2E_DATABASE_URL, E2E_USERS.designer.id, `${info.project.name}:lifecycle`);
  await loginAs(page, E2E_USERS.designer);
  await openCommercial(page, pattern.id);
  await fillAuthorization(page, { customer: "保留历史客户", price: "1200" });
  await saveAuthorization(page, "保留历史客户");
  const saved = await history(page, pattern.id);
  await page.getByRole("tab", { name: "基本信息" }).click();
  await page.getByRole("button", { name: "收起检查器", exact: true }).click();
  await page
    .getByRole("checkbox", { name: `选择 ${pattern.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  const trashDialog = page.getByRole("dialog", { name: "移入回收站" });
  await expect(trashDialog).toContainText("有效授权 1 笔");
  await expect(trashDialog).toContainText("¥1,200.00");
  await expect(trashDialog).toContainText("永久删除后，授权历史和过去看板收入也会删除。");
  await trashDialog.getByRole("button", { name: "确认移入回收站" }).click();
  await expect(trashDialog).toBeHidden();
  await page.goto(`/trash?selected=${pattern.id}`);
  const batch = page.getByRole("region", { name: "已删除图案批次", exact: true }).filter({ has: page.getByRole("checkbox", { name: `选择${pattern.name}`, exact: true }) });
  await expect(page.getByRole("button", { name: "新增授权", exact: true })).toHaveCount(0);
  expect((await history(page, pattern.id)).items).toEqual(saved.items);
  const blocked = await browserRequest(page, `/api/authorizations/${saved.items[0]!.id}/void`, {
    method: "POST", body: { operationId: randomUUID(), version: saved.items[0]!.version, commercialVersion: saved.commercialVersion },
  });
  expect(blocked.status).toBe(409);
  await batch.getByRole("button", { name: "恢复所选" }).click();
  await expect(page.getByRole("checkbox", { name: `选择${pattern.name}`, exact: true })).toHaveCount(0);
  await openCommercial(page, pattern.id);
  await expect(page.getByLabel("授权汇总")).toContainText("¥1,200.00");
  await expect(page.getByRole("button", { name: "新增授权", exact: true })).toBeEnabled();

  await page.getByRole("tab", { name: "基本信息" }).click();
  await page.getByRole("button", { name: "收起检查器", exact: true }).click();
  await page
    .getByRole("checkbox", { name: `选择 ${pattern.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByRole("button", { name: "确认移入回收站" }).click();
  await expect(trashDialog).toBeHidden();
  await page.goto(`/trash?selected=${pattern.id}`);
  await batch.getByRole("button", { name: "永久删除所选" }).click();
  const purgeDialog = page.getByRole("dialog", { name: "永久删除", exact: true });
  await expect(purgeDialog).toContainText("有效授权 1 笔 · ¥1,200.00");
  await expect(purgeDialog).toContainText("共 1 条授权记录 · 0 个文件");
  await expect(purgeDialog.getByRole("list", { name: "永久删除对象" })).toContainText(pattern.name);
  await expect(purgeDialog.getByRole("button", { name: "确认永久删除" })).toBeEnabled();
  // The purge service always lists storage prefixes; its completion is covered
  // by fake-OSS integration tests. This browser journey never contacts OSS.
  await purgeDialog.getByRole("button", { name: "取消", exact: true }).click();
  expect((await history(page, pattern.id)).items).toHaveLength(1);
});

test("another tenant cannot read or mutate the first tenant's commercial IDs", async ({ page, browser }, info) => {
  const pattern = await seedCommercialPattern(E2E_DATABASE_URL, E2E_USERS.designer.id, `${info.project.name}:isolation`);
  await loginAs(page, E2E_USERS.designer);
  await openCommercial(page, pattern.id);
  await fillAuthorization(page, { customer: "租户私有客户", price: "150" });
  await saveAuthorization(page, "租户私有客户");
  const before = await history(page, pattern.id);
  const field = await browserRequest<AuthorizationFieldDto>(page, "/api/authorization-fields", {
    method: "POST", body: { operationId: randomUUID(), name: `私有-${info.project.name}` },
  });
  expect(field.status).toBe(201);
  const context = await browser.newContext({ baseURL: E2E_BASE_URL });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === E2E_BASE_URL ? route.continue() : route.abort());
  const tenantPage = await context.newPage();
  try {
    await loginAs(tenantPage, E2E_USERS.tenant);
    for (const url of [`/api/patterns/${pattern.id}`, `/api/patterns/${pattern.id}/authorizations`]) {
      expect((await browserRequest(tenantPage, url)).status).toBe(404);
    }
    const fields = await browserRequest<AuthorizationFieldDto[]>(tenantPage, "/api/authorization-fields?includeArchived=true");
    expect(fields.body.map((item) => item.id)).not.toContain(field.body.id);
    const details = { kind: "standard", fieldId: HOMEWEAR_FIELD_ID, licenseeName: "越权客户", priceYuan: "1", authorizedOn: currentDateInTimeZone(), note: null, historyConfirmed: true };
    const statusBody = { version: before.items[0]!.version, commercialVersion: before.commercialVersion };
    const attempts = [
      { url: `/api/patterns/${pattern.id}/authorizations`, method: "POST", body: { commercialVersion: before.commercialVersion, ...details } },
      { url: `/api/authorizations/${before.items[0]!.id}`, method: "PATCH", body: { ...statusBody, ...details } },
      { url: `/api/authorizations/${before.items[0]!.id}/void`, method: "POST", body: statusBody },
      { url: `/api/authorizations/${before.items[0]!.id}/restore`, method: "POST", body: statusBody },
      { url: `/api/authorization-fields/${field.body.id}`, method: "DELETE", body: {} },
    ];
    for (const attempt of attempts) {
      expect((await browserRequest(tenantPage, attempt.url, { method: attempt.method, body: { ...attempt.body, operationId: randomUUID() } })).status).toBe(404);
    }
  } finally {
    await context.close();
  }
  expect(await history(page, pattern.id)).toEqual(before);
  const fieldsAfter = await browserRequest<AuthorizationFieldDto[]>(page, "/api/authorization-fields");
  expect(fieldsAfter.body.find((item) => item.id === field.body.id)?.status).toBe("active");
});
