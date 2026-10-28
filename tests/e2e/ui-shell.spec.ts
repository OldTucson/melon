import { E2E_USERS } from "./environment";
import { expect, loginAs, test } from "./fixtures";

const viewports = [
  { width: 1512, height: 982 },
  { width: 1280, height: 800 },
  { width: 834, height: 1112 },
  { width: 390, height: 844 },
] as const;

async function expectNoPageOverflow(page: Parameters<typeof loginAs>[0]) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        body: document.body.scrollWidth <= document.body.clientWidth,
        document:
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      })),
    )
    .toEqual({ body: true, document: true });
}

test("centers the desktop wordmark within the expanded sidebar", async ({
  page,
}) => {
  await page.setViewportSize(viewports[0]);
  await page.goto("/login");
  await page.evaluate(() => localStorage.removeItem("melon:sidebar-mode"));
  await loginAs(page, E2E_USERS.designer);

  const centerOffset = await page.evaluate(() => {
    const sidebar = document.querySelector(".workspace-sidebar");
    const wordmark = document.querySelector(".workspace-brand-full");
    if (!sidebar || !wordmark) throw new Error("WORKSPACE_BRAND_MISSING");
    const sidebarRect = sidebar.getBoundingClientRect();
    const wordmarkRect = wordmark.getBoundingClientRect();
    return (
      wordmarkRect.left +
      wordmarkRect.width / 2 -
      (sidebarRect.left + sidebarRect.width / 2)
    );
  });

  expect(Math.abs(centerOffset)).toBeLessThanOrEqual(1);
});

test("vertically centers the collapsed brand mark within the topbar", async ({
  page,
}) => {
  await page.setViewportSize(viewports[0]);
  await page.goto("/login");
  await page.evaluate(() => localStorage.removeItem("melon:sidebar-mode"));
  await loginAs(page, E2E_USERS.designer);
  await page.getByRole("button", { name: "折叠主导航" }).click();

  const centerOffset = await page.evaluate(() => {
    const topbar = document.querySelector(".workspace-topbar");
    const brandMark = document.querySelector(".workspace-brand-mark");
    if (!topbar || !brandMark) throw new Error("WORKSPACE_BRAND_MISSING");
    const topbarRect = topbar.getBoundingClientRect();
    const markRect = brandMark.getBoundingClientRect();
    return (
      markRect.top +
      markRect.height / 2 -
      (topbarRect.top + topbarRect.height / 2)
    );
  });

  expect(Math.abs(centerOffset)).toBeLessThanOrEqual(1);
});

test("workspace adapts without overflow and preserves navigation controls", async ({
  page,
}) => {
  await page.setViewportSize(viewports[0]);
  await page.goto("/login");
  await page.evaluate(() => localStorage.removeItem("melon:sidebar-mode"));
  await loginAs(page, E2E_USERS.designer);

  const workspace = page.locator(".workspace");
  await expect(workspace).toHaveAttribute("data-sidebar", "expanded");
  const firstGridRow = page.locator(".virtual-pattern-row").first();
  await expect(firstGridRow).toBeVisible();
  await expect(firstGridRow).toHaveCSS(
    "grid-template-columns",
    /\S+ \S+ \S+ \S+ \S+/,
  );

  await page.getByRole("button", { name: "折叠主导航" }).click();
  await expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
  await page.reload();
  await expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
  await page.getByRole("button", { name: "展开主导航" }).click();
  await expect(workspace).toHaveAttribute("data-sidebar", "expanded");

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/library");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "全部图案" }),
    ).toBeVisible();
    await expectNoPageOverflow(page);
  }

  const navigationTrigger = page.getByRole("button", { name: "打开主导航" });
  await navigationTrigger.click();
  const navigation = page.getByRole("dialog", { name: "主导航" });
  await expect(navigation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(navigationTrigger).toBeFocused();

  await page.setViewportSize(viewports[0]);
  await page.goto("/settings");
  await page
    .locator(".theme-options label")
    .filter({ hasText: "夜间" })
    .click();
  await expect(page.getByRole("radio", { name: "夜间" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page
    .locator(".theme-options label")
    .filter({ hasText: "浅色" })
    .click();
  await expect(page.getByRole("radio", { name: "浅色" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.goto("/library");
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "折叠主导航" })).toBeFocused();
  const outline = await page.evaluate(() => {
    const element = document.activeElement;
    return element instanceof HTMLElement
      ? getComputedStyle(element).outlineWidth
      : "0px";
  });
  expect(Number.parseFloat(outline)).toBeGreaterThanOrEqual(2);
});
