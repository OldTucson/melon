import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { E2E_USERS } from "./environment";
import { expect, loginAs, test, TRANSPARENT_PNG } from "./fixtures";

type BrowserResponse<T> = { body: T; status: number };

async function browserRequest<T>(
  page: Page,
  url: string,
  input: { body?: unknown; method?: string } = {},
) {
  return page.evaluate(
    async ({ body, method, url }): Promise<BrowserResponse<T>> => {
      const response = await fetch(url, {
        method: method ?? "GET",
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }),
      });
      return {
        body: (await response.json()) as T,
        status: response.status,
      };
    },
    { body: input.body, method: input.method, url },
  );
}

test("does not expose another tenant's patterns, assets, or upload sessions", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "One browser is sufficient for server isolation");

  await loginAs(page, E2E_USERS.tenant);
  const patternId = randomUUID();
  const sourceAssetId = randomUUID();
  const operationId = randomUUID();
  const initialized = await browserRequest<{
    pattern: { id: string; version: number };
    session: { id: string };
    sourceAsset: { id: string; objectKey: string };
  }>(page, "/api/uploads/init", {
    method: "POST",
    body: {
      patternId,
      sourceAssetId,
      operationId,
      originalFilename: "tenant-private.png",
      extension: "png",
      sizeBytes: TRANSPARENT_PNG.byteLength,
      lastModified: 1_700_000_000_000,
    },
  });
  expect(initialized.status).toBe(200);

  await page.context().clearCookies();
  await loginAs(page, E2E_USERS.designer);

  const list = await browserRequest<{ items: Array<{ id: string }> }>(
    page,
    "/api/patterns",
  );
  expect(list.status).toBe(200);
  expect(list.body.items).not.toContainEqual(expect.objectContaining({ id: patternId }));

  const detail = await browserRequest(page, `/api/patterns/${patternId}`);
  expect(detail.status).toBe(404);

  const update = await browserRequest(page, `/api/patterns/${patternId}`, {
    method: "PATCH",
    body: {
      operationId: randomUUID(),
      patch: { name: "Leaked", version: initialized.body.pattern.version },
    },
  });
  expect(update.status).toBe(404);

  for (const action of ["view", "download"] as const) {
    const asset = await browserRequest(
      page,
      `/api/assets/${initialized.body.sourceAsset.id}/${action}`,
    );
    expect(asset.status).toBe(404);
  }

  const credentials = await browserRequest(
    page,
    `/api/uploads/${initialized.body.session.id}/credentials`,
    {
      method: "POST",
      body: { operationId },
    },
  );
  expect(credentials.status).toBe(404);

  const completion = await browserRequest(
    page,
    `/api/uploads/${initialized.body.session.id}/complete`,
    {
      method: "POST",
      body: {
        operationId,
        assets: [
          {
            assetId: initialized.body.sourceAsset.id,
            role: "source",
            objectKey: initialized.body.sourceAsset.objectKey,
            extension: "png",
            sizeBytes: TRANSPARENT_PNG.byteLength,
          },
        ],
      },
    },
  );
  expect(completion.status).toBe(404);
});
