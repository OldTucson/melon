import type { Page } from "@playwright/test";

import { currentDateInTimeZone } from "../../src/features/authorizations/dates";
import { HOMEWEAR_FIELD_ID, STATIONERY_FIELD_ID, seedDashboard } from "../../src/test/fixtures/authorization-seed";
import { expect, test } from "./commercial-fixtures";
import { E2E_DATABASE_URL, E2E_USERS } from "./environment";
import { loginAs } from "./fixtures";

async function expectKpis(page: Page, revenue: string, count: string, patterns: string, average: string) {
  const kpis = page.getByRole("region", { name: "商业授权关键指标" });
  for (const [label, value] of [["授权收入", revenue], ["有效授权", count], ["授权图案", patterns], ["平均授权价", average]]) {
    await expect(kpis.locator(".dashboard-kpi").filter({ has: page.getByText(label!, { exact: true }) }).locator("strong")).toHaveText(value!);
  }
}

async function expectCurrentStates(page: Page) {
  const list = page.getByRole("list", { name: "当前商业状态数据" });
  for (const [label, count, state] of [["未授权", "1", "unlicensed"], ["普通授权", "2", "standard"], ["领域独占", "1", "field_exclusive"], ["全局买断", "1", "global_buyout"]]) {
    const link = list.getByRole("link", { name: `${label} ${count}`, exact: true });
    await expect(link).toHaveAttribute("href", `/library?commercialState=${state}`);
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`deterministic dashboard dates, filters, rankings and drill-downs in ${theme}`, async ({ page }, info) => {
    const seed = await seedDashboard(E2E_DATABASE_URL, E2E_USERS.tenant.id, currentDateInTimeZone());
    await loginAs(page, E2E_USERS.tenant);
    await page.goto("/settings");
    await page.getByRole("group", { name: "主题", exact: true }).getByText(theme === "light" ? "浅色" : "夜间", { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.goto("/dashboard?range=current_year");
    await expectKpis(page, "¥18,800.00", "4", "4", "¥4,700.00");
    await expectCurrentStates(page);
    const trend = page.getByRole("table", { name: "收入趋势数据" });
    await expect(trend).toBeVisible();
    const month = `${seed.today.slice(0, 7)}-01`;
    if (month === seed.current) {
      await expect(trend.getByRole("row", { name: `${month} 4 ¥18,800.00`, exact: true })).toBeVisible();
    } else {
      await expect(trend.getByRole("row", { name: `${seed.current} 2 ¥6,000.00`, exact: true })).toBeVisible();
      await expect(trend.getByRole("row", { name: `${month} 2 ¥12,800.00`, exact: true })).toBeVisible();
    }
    const fields = page.getByRole("table", { name: "授权领域排行" });
    await expect(fields.getByRole("row").nth(1)).toHaveText("家居服2¥6,000.00");
    await expect(fields.getByRole("row").nth(2)).toHaveText("文具纸品1¥2,800.00");
    await expect(fields.getByRole("link", { name: "家居服" })).toHaveAttribute("href", `/library?authorizationField=${HOMEWEAR_FIELD_ID}`);
    const patterns = page.getByRole("table", { name: "授权图案排行" });
    await expect(patterns.getByRole("row").nth(1)).toContainText("买断图案图库1¥10,000.00");
    await expect(patterns.getByRole("link", { name: "买断图案 图库" })).toHaveAttribute("href", `/library?selected=${seed.patterns[2]!.id}`);
    await expect(patterns.getByRole("link", { name: "回收站图案 回收站" })).toHaveAttribute("href", `/trash?selected=${seed.patterns[3]!.id}`);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", await page.locator("body").evaluate((body) => body.clientWidth));
    await page.screenshot({ path: info.outputPath(`dashboard-${theme}.png`), fullPage: true });

    await page.getByLabel("统计时间").selectOption("last_12_months");
    await expect(page).toHaveURL(/range=last_12_months/);
    // On December 31, the trailing year no longer includes last year's Dec 31.
    const includesPriorYear = !seed.today.endsWith("-12-31");
    await expectKpis(page, includesPriorYear ? "¥19,500.00" : "¥18,800.00", includesPriorYear ? "5" : "4", "4", includesPriorYear ? "¥3,900.00" : "¥4,700.00");
    await expectCurrentStates(page);
    await page.getByLabel("统计时间").selectOption("all_time");
    await expectKpis(page, "¥19,800.00", "6", "5", "¥3,300.00");
    await expect(page).toHaveURL(/range=all_time/);

    await page.getByLabel("统计时间").selectOption("custom");
    await page.getByLabel("开始日期").fill(seed.today);
    await expect(page).toHaveURL(new RegExp(`start=${seed.today}`));
    await page.getByLabel("结束日期").fill(seed.today);
    const onlyToday = seed.today !== seed.current;
    await expectKpis(page, onlyToday ? "¥12,800.00" : "¥18,800.00", onlyToday ? "2" : "4", onlyToday ? "2" : "4", onlyToday ? "¥6,400.00" : "¥4,700.00");
    await expect(trend.getByRole("row", { name: `${seed.today} ${onlyToday ? "2 ¥12,800.00" : "4 ¥18,800.00"}`, exact: true })).toBeVisible();

    await page.getByLabel("统计时间").selectOption("current_year");
    await page.getByRole("combobox", { name: "授权领域", exact: true }).selectOption(HOMEWEAR_FIELD_ID);
    await expectKpis(page, "¥6,000.00", "2", "2", "¥3,000.00");
    await expect(page).toHaveURL(new RegExp(`field=${HOMEWEAR_FIELD_ID}`));
    await expectCurrentStates(page);
    await page.getByRole("combobox", { name: "授权领域", exact: true }).selectOption(STATIONERY_FIELD_ID);
    await expectKpis(page, "¥2,800.00", "1", "1", "¥2,800.00");
    await page.getByRole("combobox", { name: "授权领域", exact: true }).selectOption("");
    for (const [kind, revenue, count, average] of [["standard", "¥3,800.00", "2", "¥1,900.00"], ["field_exclusive", "¥5,000.00", "1", "¥5,000.00"], ["global_buyout", "¥10,000.00", "1", "¥10,000.00"]]) {
      await page.getByLabel("授权类型", { exact: true }).selectOption(kind!);
      await expectKpis(page, revenue!, count!, count!, average!);
      await expect(page).toHaveURL(new RegExp(`kind=${kind}`));
      await expectCurrentStates(page);
    }
    await page.getByLabel("授权类型", { exact: true }).selectOption("");
    await expectKpis(page, "¥18,800.00", "4", "4", "¥4,700.00");
    await expect(page).toHaveURL(/\/dashboard\?range=current_year$/);
    await fields.getByRole("link", { name: "家居服" }).click();
    await expect(page).toHaveURL(new RegExp(`/library\\?authorizationField=${HOMEWEAR_FIELD_ID}`));
    await page.goto("/dashboard?range=current_year");
    await patterns.getByRole("link", { name: "买断图案 图库" }).click();
    await expect(page).toHaveURL(new RegExp(`selected=${seed.patterns[2]!.id}`));
    await page.getByRole("tab", { name: "商业授权" }).click();
    await expect(page.getByLabel("授权汇总")).toContainText("已买断");
    await page.goto("/dashboard?range=current_year");
    await patterns.getByRole("link", { name: "回收站图案 回收站" }).click();
    await expect(page).toHaveURL(new RegExp(`/trash\\?selected=${seed.patterns[3]!.id}`));
    await expect(page.getByRole("checkbox", { name: "选择回收站图案", exact: true })).toBeChecked();
  });
}
