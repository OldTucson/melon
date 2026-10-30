import type { Locator, Page } from "@playwright/test";
import { E2E_USERS } from "./environment";
import { loginAs } from "./fixtures";
import {
  test, expect, seedDocument, revokeShare, removeWebAsset,
  documentFixture, installDocumentBytes,
} from "./inspiration-document-fixtures";

const screenshotStyle = "nextjs-portal { visibility: hidden !important; }";

const viewports = [
  { width: 1512, height: 982, columns: 3 },
  { width: 1280, height: 800, columns: 2 },
  { width: 390, height: 844, columns: 1 },
] as const;

async function openOwner(page: Page) {
  await page.goto("/inspiration");
  await expect(page.getByRole("article", { name: documentFixture.title })).toBeVisible();
  await expect(page.getByText("方向内私有纹样", { exact: true })).toBeVisible();
}

async function assertDocument(page: Page, count: number, columns: number) {
  const article = page.getByRole("article", { name: documentFixture.title });
  const names = await article.locator(":scope > section").evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")));
  expect(names.filter((name) => name !== "主视觉" && name !== "私有素材补充")).toEqual([
    "研究结论", "市场信号", "款式", "类型", "风格", "品类", "色款", "材质", "商品参考", "设计灵感", "研究来源",
  ]);
  await expect(article.getByRole("button", { name: /^预览：/ })).toHaveCount(count);
  expect(await page.evaluate(() => ({
    body: document.body.scrollWidth <= innerWidth,
    document: document.documentElement.scrollWidth <= innerWidth,
  }))).toEqual({ body: true, document: true });
  const width = (await article.boundingBox())!.width;
  expect.soft(width, "reading measure must not exceed 960px").toBeLessThanOrEqual(961);
  if (page.viewportSize()!.width >= 1280) expect.soft(width).toBeGreaterThanOrEqual(950);
  const sections = await article.locator(":scope > section").evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }));
  for (let i = 1; i < sections.length; i++) expect(sections[i]!.top + 1).toBeGreaterThanOrEqual(sections[i - 1]!.bottom);
  const grid = article.getByRole("region", { name: "商品参考", exact: true }).locator("div").first();
  if (count >= 4) {
    expect.soft(await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length), "product columns").toBe(columns);
  }
  const images = article.locator("img");
  for (const img of await images.all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    const box = (await img.boundingBox())!;
    expect(box.width).toBeGreaterThan(40);
    expect(Math.abs(box.width / box.height - 4 / 3)).toBeLessThan(0.02);
  }
  const figures = await article.locator("figure").evaluateAll((nodes) => nodes.map((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  }));
  for (let i = 0; i < figures.length; i++) for (let j = i + 1; j < figures.length; j++) {
    const a = figures[i]!;
    const b = figures[j]!;
    expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1, "media figures must not overlap").toBe(true);
  }
  const links = article.getByRole("link", { name: "打开原始页面", exact: true });
  await expect(links).toHaveCount(count);
  for (const link of await links.all()) {
    expect(await link.getAttribute("href")).toMatch(/^https:\/\/example\.test\/editorial\//);
    const box = (await link.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  await page.evaluate(() => { for (const node of document.querySelectorAll("*")) if (node instanceof HTMLElement) node.scrollTo(0, 0); scrollTo(0, 0); });
}

async function controlBoxes(page: Page) {
  return Promise.all(["重命名", "分享研究", "删除研究"].map(async (name) => {
    const button = page.getByRole("button", { name, exact: true });
    return button.boundingBox();
  }));
}

for (const viewport of viewports) {
  test(`${viewport.width}x${viewport.height}: 0/1/4/8 images, owner/shared layout and keyboard dialog`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await loginAs(page, E2E_USERS.designer);
    let initialControls: Awaited<ReturnType<typeof controlBoxes>> | undefined;
    for (const count of [0, 1, 4, 8] as const) {
      await seedDocument(count);
      await installDocumentBytes(page, count);
      await openOwner(page);
      await assertDocument(page, count, viewport.columns);
      const controls = await controlBoxes(page);
      expect(controls.every(Boolean)).toBe(true);
      if (initialControls) expect(controls).toEqual(initialControls);
      initialControls = controls;
      await expect(page.getByRole("region", { name: "柔和通勤", exact: true }).getByText("方向内私有纹样")).toBeVisible();
      await expect(page.getByRole("region", { name: "私有素材补充", exact: true }).getByText("未分配私有纹样")).toBeVisible();
      if (count === 8) {
        await page.getByRole("heading", { name: documentFixture.title, exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`owner-${viewport.width}x${viewport.height}.png`), fullPage: true, style: screenshotStyle });
        await alignSection(page.getByRole("region", { name: "主视觉", exact: true }));
        await page.screenshot({ path: testInfo.outputPath(`owner-media-${viewport.width}x${viewport.height}.png`), style: screenshotStyle });
        await alignSection(page.getByRole("region", { name: "商品参考", exact: true }));
        await page.screenshot({ path: testInfo.outputPath(`owner-products-${viewport.width}x${viewport.height}.png`), style: screenshotStyle });
        const trigger = page.getByRole("button", { name: "预览：棉麻主视觉", exact: true });
        await keyboardDialog(page, trigger);
      }
      // Drop the session: shared HTML and media must work without an owner cookie.
      await page.context().clearCookies();
      await page.goto(documentFixture.sharePath);
      await assertDocument(page, count, viewport.columns);
      await expect(page.getByText(/私有纹样|仅自己可见|私有素材补充/)).toHaveCount(0);
      expect(await page.locator('a[href^="/library"]').count()).toBe(0);
      if (count === 8) {
        await page.getByRole("heading", { name: documentFixture.title, exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`shared-${viewport.width}x${viewport.height}.png`), fullPage: true, style: screenshotStyle });
        await keyboardDialog(page, page.getByRole("button", { name: "预览：棉麻主视觉", exact: true }));
      }
      if (count !== 8) await loginAs(page, E2E_USERS.designer);
    }
  });

  test(`${viewport.width}x${viewport.height}: broken media preserves ratio and source`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await seedDocument(8);
    await installDocumentBytes(page, 8);
    await page.goto(documentFixture.sharePath);
    const trigger = page.getByRole("button", { name: "预览：棉麻主视觉", exact: true });
    const before = (await trigger.boundingBox())!;
    await installDocumentBytes(page, 8, true);
    await page.reload();
    // A newly mounted dialog handles the same corrupt bytes after hydration.
    await trigger.click();
    const hydratedDialog = page.getByRole("dialog", { name: "棉麻主视觉", exact: true });
    await expect(hydratedDialog.getByText("图片暂时无法显示")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger.getByText("图片暂时无法显示")).toBeVisible();
    expect(await trigger.boundingBox()).toEqual(before);
    await expect(page.getByRole("region", { name: "主视觉" }).getByRole("link", { name: "打开原始页面" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`broken-${viewport.width}x${viewport.height}.png`), fullPage: true, style: screenshotStyle });
  });
}

async function alignSection(section: Locator) {
  await section.evaluate((node) => {
    node.scrollIntoView({ block: "start" });
    // The workspace has its own scroll container below a fixed application bar.
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollTop > 0) { parent.scrollTop -= 72; return; }
    }
    scrollBy(0, -72);
  });
}

async function keyboardDialog(page: Page, trigger: Locator) {
  await trigger.scrollIntoViewIfNeeded();
  // Reach the trigger using actual sequential keyboard navigation.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < 100 && !(await trigger.evaluate((node) => node === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "棉麻主视觉", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "打开原始页面" })).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

test("private matches are owner-only; revoked shares and removed assets return real 404s", async ({ page }) => {
  await seedDocument(8);
  await installDocumentBytes(page, 8);
  await loginAs(page, E2E_USERS.tenant);
  // APIRequestContext bypasses all browser byte interception. Denials must happen before storage.
  for (const path of [documentFixture.detailPath, documentFixture.visualsPath, documentFixture.ownerAssetPath, documentFixture.privateAssetPath]) {
    expect((await page.request.get(path)).status()).toBe(404);
  }
  await page.context().clearCookies();
  expect((await page.request.get(`${documentFixture.sharePath}/assets/${documentFixture.privateMatchId}`)).status()).toBe(404);
  expect((await page.goto(documentFixture.sharePath))!.status()).toBe(200);
  await expect(page.getByRole("article", { name: documentFixture.title })).toBeVisible();
  await removeWebAsset();
  expect((await page.request.get(documentFixture.removedAssetPath)).status()).toBe(404);
  // Revoke while the hero still exists: removal must not mask capability checks.
  await revokeShare();
  for (const path of [documentFixture.sharePath, documentFixture.sharedAssetPath, documentFixture.revokedSharePath]) {
    expect((await page.request.get(path)).status()).toBe(404);
  }
});
