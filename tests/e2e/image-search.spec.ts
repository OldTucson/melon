import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "@playwright/test";

import { E2E_USERS } from "./environment";
import { loginAs, test } from "./fixtures";
import { seedImageSearchPatterns } from "./image-search-fixtures";

const queryFixturePath = path.resolve(
  process.cwd(),
  "services/visual-search/tests/fixtures/checker-crop.jpg",
);
const realVisualSearch = process.env.RUN_REAL_VISUAL_SEARCH_TESTS === "1";

test.beforeAll(async () => {
  if (!realVisualSearch) await seedImageSearchPatterns();
});

async function interceptFixtureAssets(page: Parameters<typeof loginAs>[0]) {
  const fixture = await readFile(queryFixturePath);
  await page.route("**/api/assets/**", async (route) => {
    const download = new URL(route.request().url()).pathname.endsWith(
      "/download",
    );
    await route.fulfill({
      body: fixture,
      headers: {
        "cache-control": "no-store",
        "content-disposition": download
          ? 'attachment; filename="visual-search-fixture.jpg"'
          : "inline",
        "content-type": "image/jpeg",
      },
      status: 200,
    });
  });
}

async function pasteQueryImage(page: Parameters<typeof loginAs>[0]) {
  const bytes = [...(await readFile(queryFixturePath))];
  await page.evaluate((encoded) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("E2E_IMAGE_SEARCH_DIALOG_MISSING");
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array(encoded)], "pasted-query.jpg", {
        type: "image/jpeg",
      }),
    );
    dialog.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, bytes);
}

function inspector(page: Parameters<typeof loginAs>[0]) {
  return page.getByLabel("图案检查器", { exact: true });
}

async function expectNoViewportOverflow(page: Parameters<typeof loginAs>[0]) {
  expect(
    await page.locator("body").evaluate((body) => ({
      clientWidth: body.clientWidth,
      scrollWidth: body.scrollWidth,
    })),
  ).toEqual(
    expect.objectContaining({
      clientWidth: expect.any(Number),
      scrollWidth: expect.any(Number),
    }),
  );
  expect(
    await page
      .locator("body")
      .evaluate((body) => body.scrollWidth <= body.clientWidth),
  ).toBe(true);
  const viewport = page.viewportSize();
  const header = await page
    .getByLabel("以图搜图结果")
    .locator(".image-search-results-header")
    .boundingBox();
  expect(header).not.toBeNull();
  expect(header!.x).toBeGreaterThanOrEqual(0);
  expect(header!.x + header!.width).toBeLessThanOrEqual(viewport!.width + 1);
}

test("image search preserves the library workflow across responsive themes", async ({
  page,
}, info) => {
  test.skip(realVisualSearch, "ordinary CI uses the isolated internal stub");
  await interceptFixtureAssets(page);
  await loginAs(page, E2E_USERS.designer);

  await expect(page.getByText("高概率来源图案", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "列表视图" }).click();
  const normalCard = page.getByRole("listitem", { name: /可能来源图案/ });
  await normalCard.getByRole("checkbox", { name: "选择 可能来源图案" }).click();
  await normalCard
    .getByRole("button", { name: "打开 可能来源图案 检查器" })
    .press("Enter");
  await expect(inspector(page)).toContainText("可能来源图案");
  const compact = (page.viewportSize()?.width ?? 1440) <= 1100;
  if (compact) {
    await inspector(page)
      .getByRole("button", { name: "收起检查器" })
      .click();
    await expect(inspector(page)).toHaveCount(0);
  }

  await page.getByRole("button", { name: "以图搜图" }).click();
  const dialog = page.getByRole("dialog", { name: "以图搜图" });
  await dialog
    .getByLabel("选择搜索图片", { exact: true })
    .setInputFiles(queryFixturePath);
  await expect(dialog.getByRole("img", { name: "搜索图片预览" })).toBeVisible();
  await dialog.getByRole("button", { name: "移除搜索图片" }).click();

  await pasteQueryImage(page);
  await expect(dialog.getByText("pasted-query.jpg", { exact: true })).toBeVisible();
  const crop = dialog.getByRole("checkbox", { name: "裁剪搜索区域" });
  await expect(crop).toBeVisible();
  await crop.check();
  await expect(dialog.locator(".ReactCrop")).toBeVisible();
  await dialog.getByRole("button", { name: "开始搜索" }).click();

  const results = page.getByLabel("以图搜图结果");
  await expect(results).toBeVisible();
  await expect(inspector(page)).toHaveCount(0);
  await expect(
    results.getByRole("heading", { name: "高概率原图" }),
  ).toBeVisible();
  await expect(
    results.getByRole("heading", { name: "可能是原图" }),
  ).toBeVisible();
  await expect(
    results.getByRole("heading", { name: "视觉相似" }),
  ).toBeVisible();

  const resultCard = results.getByRole("listitem", { name: /高概率来源图案/ });
  const resultCheckbox = resultCard.getByRole("checkbox", {
    name: "选择 高概率来源图案",
  });
  await expect(resultCheckbox).not.toBeChecked();
  await resultCheckbox.click();
  await expect(resultCheckbox).toBeChecked();

  const downloadLink = resultCard.getByRole("link", {
    name: "下载 高概率来源图案",
  });
  await expect(downloadLink).toHaveAttribute(
    "href",
    /\/api\/assets\/.+\/download$/,
  );
  if (page.context().browser()?.browserType().name() === "chromium") {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadLink.click(),
    ]);
    expect(download.suggestedFilename()).toBe("visual-search-fixture.jpg");
  } else {
    const response = await downloadLink.evaluate(async (link) => {
      const result = await fetch((link as HTMLAnchorElement).href);
      return {
        disposition: result.headers.get("content-disposition"),
        status: result.status,
      };
    });
    expect(response).toEqual({
      disposition: 'attachment; filename="visual-search-fixture.jpg"',
      status: 200,
    });
  }

  await resultCard
    .getByRole("button", { name: "打开 高概率来源图案 检查器" })
    .press("Enter");
  await expect(inspector(page)).toContainText("高概率来源图案");
  await page.getByRole("button", { name: "收起检查器" }).click();

  await page
    .locator("nextjs-portal")
    .evaluateAll((portals) => portals.forEach((portal) => portal.remove()));
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((nextTheme) => {
      window.localStorage.setItem("theme", nextTheme);
      document.documentElement.dataset.theme = nextTheme;
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expectNoViewportOverflow(page);
    await page.screenshot({
      fullPage: true,
      path: info.outputPath(`image-search-${theme}.png`),
    });
  }

  await page.getByRole("combobox", { name: "按格式筛选" }).selectOption("png");
  await expect(results.getByText("未找到可能的原图", { exact: true })).toBeVisible();
  await expect(
    results.getByRole("heading", { name: "视觉相似" }),
  ).toBeVisible();
  await expect(
    results.getByRole("heading", { name: "高概率原图" }),
  ).toHaveCount(0);

  await results.getByRole("button", { name: "退出搜图" }).click();
  const restoredCard = page.getByRole("listitem", { name: /可能来源图案/ });
  await expect(
    restoredCard.getByRole("checkbox", { name: "选择 可能来源图案" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "选择 高概率来源图案" }),
  ).not.toBeChecked();
  await expect(page.getByRole("button", { name: "列表视图" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  if (compact) {
    await expect(inspector(page)).toHaveCount(0);
  } else {
    await expect(inspector(page)).toContainText("可能来源图案");
  }
});

test("real model image search smoke test", async ({ page }) => {
  test.skip(!realVisualSearch, "set RUN_REAL_VISUAL_SEARCH_TESTS=1 explicitly");
  const email = process.env.REAL_VISUAL_SEARCH_EMAIL;
  const password = process.env.REAL_VISUAL_SEARCH_PASSWORD;
  if (!email || !password) throw new Error("REAL_VISUAL_SEARCH_LOGIN_REQUIRED");

  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/library(?:\?|$)/);
  await page.getByRole("button", { name: "以图搜图" }).click();
  await page
    .getByLabel("选择搜索图片", { exact: true })
    .setInputFiles(queryFixturePath);
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect(page.getByLabel("以图搜图结果")).toBeVisible();
  await expect(
    page.getByLabel("以图搜图结果").getByRole("listitem").first(),
  ).toBeVisible();
});
