import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "@playwright/test";

import { E2E_USERS } from "./environment";
import { loginAs, test } from "./fixtures";
import { seedImageSearchPatterns } from "./image-search-fixtures";

const fixturePath = path.resolve(
  process.cwd(),
  "services/visual-search/tests/fixtures/checker-crop.jpg",
);

test.beforeAll(async () => {
  await seedImageSearchPatterns();
});

async function interceptFixtureAssets(page: Parameters<typeof loginAs>[0]) {
  const fixture = await readFile(fixturePath);
  await page.route("**/api/assets/**", (route) =>
    route.fulfill({
      body: fixture,
      headers: {
        "cache-control": "no-store",
        "content-type": "image/jpeg",
      },
      status: 200,
    }),
  );
}

async function expectNoViewportOverflow(
  page: Parameters<typeof loginAs>[0],
) {
  const dimensions = await page.locator("body").evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  const queryBar = await page.locator(".palette-query-bar").boundingBox();
  const viewport = page.viewportSize();
  expect(queryBar).not.toBeNull();
  expect(queryBar!.x).toBeGreaterThanOrEqual(0);
  expect(queryBar!.x + queryBar!.width).toBeLessThanOrEqual(
    viewport!.width + 1,
  );
}

test("palette search preserves ranked workflow across responsive themes", async ({
  page,
}, info) => {
  await interceptFixtureAssets(page);
  await loginAs(page, E2E_USERS.designer);

  const sourceCard = page.getByRole("listitem", { name: /高概率来源图案/ });
  await expect(
    sourceCard.getByRole("button", { name: /^按颜色 .* 搜索$/ }),
  ).toHaveCount(3);

  await page.getByRole("button", { name: "列表视图" }).click();
  await expect(
    sourceCard.getByRole("button", { name: /^按颜色 .* 搜索$/ }),
  ).toHaveCount(3);
  await sourceCard
    .getByRole("button", { name: "打开 高概率来源图案 检查器" })
    .press("Enter");
  const inspector = page.getByLabel("图案检查器", { exact: true });
  await expect(inspector.getByText("#285947", { exact: true })).toBeVisible();
  await expect(inspector.getByText("50%", { exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "收起检查器" }).click();

  const savedCard = page.getByRole("listitem", { name: /可能来源图案/ });
  await savedCard
    .getByRole("checkbox", { name: "选择 可能来源图案" })
    .click();
  await sourceCard
    .getByRole("button", { name: "按颜色 #285947 搜索" })
    .press("Enter");

  const results = page.getByRole("region", { name: "配色搜索结果" });
  await expect(results).toBeVisible();
  await expect(page.getByRole("heading", { name: "配色搜索" })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "配色搜索按匹配度排序" }),
  ).toBeDisabled();
  await expect(results.getByRole("listitem").nth(0)).toContainText(
    "视觉相似图案",
  );
  await expect(results.getByRole("listitem").nth(1)).toContainText(
    "高概率来源图案",
  );

  const firstResult = results.getByRole("listitem").first();
  await firstResult
    .getByRole("button", { name: "按颜色 #CC9C3F 搜索" })
    .click();
  await firstResult
    .getByRole("button", { name: "按颜色 #8F4038 搜索" })
    .click();
  await expect(page.getByRole("button", { name: /^移除颜色 / })).toHaveCount(3);
  await expect(
    firstResult.getByRole("button", { name: "按颜色 #CC9C3F 搜索" }),
  ).toHaveAttribute("aria-pressed", "true");

  await firstResult
    .getByRole("button", { name: "按颜色 #CC9C3F 搜索" })
    .click();
  await expect(
    page.getByRole("button", { name: "移除颜色 #CC9C3F" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".palette-query-heading").getByRole("status"),
  ).toHaveText("4 个结果");

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((nextTheme) => {
      window.localStorage.setItem("theme", nextTheme);
      document.documentElement.dataset.theme = nextTheme;
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expectNoViewportOverflow(page);
    await page
      .locator("nextjs-portal")
      .evaluateAll((portals) => portals.forEach((portal) => portal.remove()));
    await page.screenshot({
      fullPage: true,
      path: info.outputPath(`palette-search-${theme}.png`),
    });
  }

  await page.getByRole("combobox", { name: "按格式筛选" }).selectOption("png");
  await expect(results.getByRole("listitem")).toHaveCount(2);
  await expect(results.getByRole("listitem").nth(0)).toContainText(
    "可能来源图案",
  );
  await expect(results.getByRole("listitem").nth(1)).toContainText(
    "高概率来源图案",
  );

  await page.getByRole("button", { name: "清除配色" }).click();
  await expect(results).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "选择 可能来源图案" }),
  ).toBeChecked();
  await expect(page.getByRole("button", { name: "列表视图" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await sourceCard
    .getByRole("button", { name: "按颜色 #285947 搜索" })
    .click();
  await expect(results).toBeVisible();
  await page.getByRole("button", { name: "以图搜图" }).click();
  await expect(results).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "以图搜图" })).toBeVisible();
});
