import { createHash } from "node:crypto";

import { E2E_USERS } from "./environment";
import { expect, loginAs, test, TRANSPARENT_PNG } from "./fixtures";

test("uploads, tags, filters, previews, favorites, and downloads", async ({
  page,
}, testInfo) => {
  const suffix = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-");
  const filename = `transparent-${suffix}.png`;
  const patternName = `Watermelon Bloom ${suffix}`;
  const tagName = `夏季 ${suffix}`;

  await loginAs(page, E2E_USERS.designer);
  await page.getByLabel("选择要上传的图案").setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: TRANSPARENT_PNG,
  });

  await expect(page.getByText("上传完成")).toBeVisible();
  let card = page.getByRole("listitem", {
    name: new RegExp(filename.replace(".png", ""), "i"),
  });
  await expect(card).toBeVisible();

  const nameInput = page.getByLabel("图案名称");
  await expect(nameInput).toBeVisible();
  await nameInput.fill(patternName);
  await nameInput.press("Tab");
  card = page.getByRole("listitem", { name: new RegExp(patternName, "i") });
  await expect(card).toBeVisible();

  const createTag = page.getByRole("button", { name: "创建标签" });
  await expect(createTag).toBeEnabled();
  await createTag.click();
  await page.getByLabel("标签名称").fill(tagName);
  await page.getByRole("button", { name: "保存并添加标签" }).click();
  await expect(page.getByRole("checkbox", { name: tagName })).toBeChecked();

  await page.getByRole("button", { name: "筛选标签" }).click();
  await page.getByRole("menuitemcheckbox", { name: tagName }).click();
  await expect(page).toHaveURL(/(?:\?|&)tag=/);
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "预览" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `${patternName} 预览` })).toBeVisible();
  const preview = dialog.getByRole("img", { name: `${patternName} 预览图` });
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "关闭预览" }).click();

  await card.getByRole("button", { name: "收藏" }).click();
  await expect(card.getByRole("button", { name: "取消收藏" })).toBeVisible();
  await page.getByRole("link", { name: "收藏", exact: true }).click();
  await expect(page).toHaveURL(/favorite=true/);
  card = page.getByRole("listitem", { name: new RegExp(patternName, "i") });
  await expect(card).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await card.getByRole("link", { name: `下载 ${patternName}` }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(
    createHash("sha256").update(TRANSPARENT_PNG).digest("hex"),
  );

  const hasPageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasPageOverflow).toBe(false);
});
