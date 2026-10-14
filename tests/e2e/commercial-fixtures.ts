import type { Page } from "@playwright/test";

import type { AuthorizationHistoryPage, AuthorizationKind } from "../../src/features/authorizations/api";
import { E2E_BASE_URL, E2E_METADATA_ONLY } from "./environment";
import { browserRequest, expect, test as base } from "./fixtures";

export const test = base.extend({
  page: async ({ page }, providePage) => {
    if (!E2E_METADATA_ONLY) throw new Error("COMMERCIAL_E2E_REQUIRES_METADATA_ONLY");
    const externalRequests: string[] = [];
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== E2E_BASE_URL) {
        externalRequests.push(url.origin);
        await route.abort();
      } else await route.continue();
    });
    await providePage(page);
    expect(externalRequests, "commercial journeys must make no external/OSS requests").toEqual([]);
  },
});
export { expect };

export async function openCommercial(page: Page, patternId: string) {
  await page.goto(`/library?selected=${patternId}`);
  await page.getByRole("tab", { name: "商业授权" }).click();
  await expect(page.getByRole("region", { name: "商业授权", exact: true })).toBeVisible();
}

export async function history(page: Page, patternId: string) {
  const response = await browserRequest<AuthorizationHistoryPage>(page, `/api/patterns/${patternId}/authorizations?includeVoid=true`);
  expect(response.status).toBe(200);
  return response.body;
}

export async function fillAuthorization(page: Page, input: { customer: string; price: string; kind?: AuthorizationKind; field?: string }) {
  await page.getByRole("button", { name: "新增授权", exact: true }).click();
  const label = { standard: "普通授权", field_exclusive: "领域独占", global_buyout: "买断" }[input.kind ?? "standard"];
  const radio = page.getByRole("radio", { name: label, exact: true });
  if (!(await radio.isChecked())) {
    await radio.focus();
    await radio.press("Space");
  }
  await expect(radio).toBeChecked();
  if (input.kind !== "global_buyout") {
    await page.getByRole("combobox", { name: "授权领域", exact: true }).fill(input.field ?? "家居服");
    await page.getByRole("listbox").getByRole("option", { name: input.field ?? "家居服", exact: true }).click();
  }
  await page.getByLabel("授权客户", { exact: true }).fill(input.customer);
  await page.getByLabel("授权价格", { exact: true }).fill(input.price);
}

export async function saveAuthorization(page: Page, customer: string, historyCount?: number) {
  await page.getByRole("button", { name: "保存授权" }).click();
  if (historyCount !== undefined) {
    const dialog = page.getByRole("dialog", { name: "确认授权历史" });
    await expect(dialog).toContainText(`已有 ${historyCount} 条有效授权`);
    await dialog.getByRole("button", { name: "仍然保存" }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(page.getByRole("button", { name: "保存授权" })).toHaveCount(0);
  await expect(page.getByRole("article", { name: `${customer}授权记录` })).toBeVisible();
}

export async function changeStatus(page: Page, customer: string, action: "void" | "restore") {
  await page.getByRole("button", { name: `更多操作 ${customer}`, exact: true }).click();
  await page.getByRole("menuitem", { name: action === "void" ? "作废记录" : "恢复记录" }).click();
  await page.getByRole("button", { name: action === "void" ? "确认作废" : "确认恢复", exact: true }).click();
  await expect(page.getByRole("dialog", { name: action === "void" ? "确认作废授权" : "确认恢复授权", exact: true })).toHaveCount(0);
}
