import { writePsdBuffer } from "ag-psd";
import { zipSync } from "fflate";

import { E2E_USERS } from "./environment";
import { expect, loginAs, test, TRANSPARENT_PNG } from "./fixtures";

function createPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 48 >>\nstream\nBT /F1 24 Tf 32 92 Td (Melon PDF Preview) Tj ET\nendstream",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

function createPsd() {
  const width = 48;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data.set(index % 2 ? [36, 138, 98, 255] : [241, 91, 122, 255], offset);
  }
  return writePsdBuffer({
    width,
    height,
    imageData: { width, height, data },
  });
}

const pdf = createPdf();
function previewFiles(suffix: string) {
  return [
    {
      name: `worker-pdf-${suffix}.pdf`,
      mimeType: "application/pdf",
      buffer: pdf,
    },
    {
      name: `worker-ai-${suffix}.ai`,
      mimeType: "application/pdf",
      buffer: pdf,
    },
    {
      name: `worker-psd-${suffix}.psd`,
      mimeType: "image/vnd.adobe.photoshop",
      buffer: createPsd(),
    },
    {
      name: `worker-procreate-${suffix}.procreate`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(
        zipSync({
          "Document.archive": new Uint8Array([1, 2, 3]),
          "QuickLook/Thumbnail.png": TRANSPARENT_PNG,
        }),
      ),
    },
  ];
}

test("renders PDF, PDF-compatible AI, PSD, and Procreate previews", async ({
  page,
}, testInfo) => {
  await loginAs(page, E2E_USERS.designer);
  const files = previewFiles(
    testInfo.project.name.replace(/[^a-z0-9]+/gi, "-"),
  );

  for (const file of files) {
    const initializationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/uploads/init",
    );
    await page.getByLabel("选择要上传的图案").setInputFiles(file);
    const initialized = await initializationResponse;
    expect(
      initialized.ok(),
      `upload initialization failed: ${await initialized.text()}`,
    ).toBe(true);
    const trayRow = page
      .locator(".upload-tray-row")
      .filter({ hasText: file.name });
    await expect(trayRow.getByText("上传完成")).toBeVisible({ timeout: 90_000 });
    const inspectorDialog = page.getByRole("dialog", { name: "图案检查器" });
    if (await inspectorDialog.isVisible()) {
      await inspectorDialog.getByRole("button", { name: "收起检查器" }).click();
    }

    const patternName = file.name.slice(0, file.name.lastIndexOf("."));
    const card = page.getByRole("listitem", {
      name: new RegExp(`^${patternName},`, "i"),
    });
    await expect(card).toBeVisible();
    const thumbnail = card.getByRole("img", { name: `${patternName} 缩略图` });
    await expect(thumbnail).toBeVisible();
    await expect
      .poll(() =>
        thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        thumbnail.evaluate((image: HTMLImageElement) => image.naturalHeight),
      )
      .toBeGreaterThan(0);
  }

  const lastPatternName = files.at(-1)!.name.replace(/\.procreate$/i, "");
  const lastCard = page.getByRole("listitem", {
    name: new RegExp(`^${lastPatternName},`, "i"),
  });
  await lastCard
    .getByRole("button", { name: `打开 ${lastPatternName} 检查器` })
    .click();
  await page.getByRole("button", { name: "更新预览" }).click();
  const manualDialog = page.getByRole("dialog", {
    name: `更新“${lastPatternName}”的预览`,
  });
  await manualDialog.getByLabel("选择 JPG 或 PNG 预览").setInputFiles({
    name: "manual-cover.png",
    mimeType: "image/png",
    buffer: TRANSPARENT_PNG,
  });
  const completionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/manual-preview/complete"),
  );
  await manualDialog.getByRole("button", { name: "更新预览" }).click();
  const completed = await completionResponse;
  expect(
    completed.ok(),
    `manual preview completion failed: ${await completed.text()}`,
  ).toBe(true);
  await expect(manualDialog).toBeHidden();
  await expect(page.getByText("手动预览", { exact: true })).toBeVisible();
});
