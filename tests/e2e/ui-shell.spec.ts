import { randomUUID } from "node:crypto";

import postgres from "postgres";

import {
  inspirationResultFixture,
  inspirationSourceFixture,
} from "../../src/features/inspiration/test-fixtures";
import { E2E_DATABASE_URL, E2E_USERS } from "./environment";
import { expect, loginAs, test } from "./fixtures";

const inspirationAnalysisId = "88888888-8888-4888-8888-888888888801";
const inspirationVisualJobId = "88888888-8888-4888-8888-888888888802";
const inspirationPatternIds = Array.from(
  { length: 8 },
  (_, index) => `88888888-8888-4888-8888-88888888881${index}`,
);

async function seedInspirationVisualWorkspace() {
  const client = postgres(E2E_DATABASE_URL, { max: 1 });
  const ownerId = E2E_USERS.designer.id;
  try {
    await client.begin(async (sql) => {
      await sql`
        delete from inspiration_analyses
        where id = ${inspirationAnalysisId}
      `;

      for (const [index, patternId] of inspirationPatternIds.entries()) {
        const assetId = `88888888-8888-4888-8888-88888888882${index}`;
        const documentId = `88888888-8888-4888-8888-88888888883${index}`;
        const title = `柔和通勤图案 ${index + 1}`;

        await sql`
          insert into patterns (
            id, owner_id, name, original_filename, extension,
            detected_mime_type, size_bytes, status, preview_status,
            created_at, updated_at
          ) values (
            ${patternId}, ${ownerId}, ${title}, ${`palette-${index + 1}.png`},
            'png', 'image/png', 4096, 'ready', 'ready',
            '2026-10-28T01:00:00.000Z',
            ${`2026-10-28T01:00:0${index}.000Z`}
          )
          on conflict (id) do update set
            name = excluded.name,
            status = excluded.status,
            preview_status = excluded.preview_status,
            updated_at = excluded.updated_at
        `;
        await sql`delete from assets where id = ${assetId}`;
        await sql`
          insert into assets (
            id, owner_id, pattern_id, role, object_key,
            original_filename, detected_mime_type, size_bytes, width, height
          ) values (
            ${assetId}, ${ownerId}, ${patternId}, 'preview',
            ${`users/${ownerId}/patterns/${patternId}/derived/${assetId}.png`},
            ${`palette-${index + 1}.png`}, 'image/png', 4096, 800, 600
          )
        `;
        await sql`
          insert into visual_search_documents (
            id, owner_id, pattern_id, preview_asset_id, preview_hash,
            index_version, status, width, height, indexed_at
          ) values (
            ${documentId}, ${ownerId}, ${patternId}, ${assetId},
            ${String(index + 1).repeat(64)}, 'visual-search-v2',
            'ready', 800, 600, '2026-10-28T02:00:00.000Z'
          )
        `;
        const palette = [
          ["#EEE8DA", 0.5, 0.92, 0.01, 0.03],
          ["#7A8B83", 0.3, 0.62, -0.03, 0.01],
          ["#303632", 0.2, 0.32, -0.01, 0.01],
        ] as const;
        for (const [colorIndex, color] of palette.entries()) {
          await sql`
            insert into visual_search_palette_colors (
              document_id, owner_id, pattern_id, color_index, display_hex,
              coverage, oklab_l, oklab_a, oklab_b
            ) values (
              ${documentId}, ${ownerId}, ${patternId}, ${colorIndex},
              ${color[0]}, ${color[1]}, ${color[2]}, ${color[3]}, ${color[4]}
            )
          `;
        }
      }

      await sql`
        insert into inspiration_analyses (
          id, owner_id, operation_id, prompt, title, status,
          sources, result, search_model, structure_model,
          completed_at, created_at, updated_at
        ) values (
          ${inspirationAnalysisId}, ${ownerId},
          '88888888-8888-4888-8888-888888888803',
          '分析近三十天都市轻通勤女装与柔和自然配色趋势',
          '都市轻通勤与柔和自然配色趋势研究', 'completed',
          ${JSON.stringify([inspirationSourceFixture])}::jsonb,
          ${JSON.stringify(inspirationResultFixture)}::jsonb,
          'qwen-plus', 'qwen3.8-flash',
          '2026-10-29T02:00:00.000Z',
          '2026-10-29T01:00:00.000Z',
          '2026-10-29T02:00:00.000Z'
        )
      `;
      await sql`
        insert into inspiration_visual_jobs (
          id, owner_id, analysis_id, operation_id, kind,
          direction_index, status, warnings,
          completed_at, created_at, updated_at
        ) values (
          ${inspirationVisualJobId}, ${ownerId}, ${inspirationAnalysisId},
          '88888888-8888-4888-8888-888888888804',
          'research_visuals', null, 'completed', '[]'::jsonb,
          '2026-10-20T02:05:00.000Z',
          '2026-10-20T02:04:00.000Z',
          '2026-10-20T02:05:00.000Z'
        )
      `;
      for (const [index, patternId] of inspirationPatternIds.entries()) {
        await sql`
          insert into inspiration_visual_assets (
            id, owner_id, analysis_id, job_id, kind, ordinal,
            direction_index, title, alt_text, pattern_id
          ) values (
            ${`88888888-8888-4888-8888-88888888884${index}`},
            ${ownerId}, ${inspirationAnalysisId}, ${inspirationVisualJobId},
            'library_match', ${index}, null,
            ${`柔和通勤图案 ${index + 1}`},
            ${`柔和通勤图案 ${index + 1} 的图库图案预览`},
            ${patternId}
          )
        `;
      }
    });
  } finally {
    await client.end();
  }
}

async function cleanupInspirationVisualWorkspace() {
  const client = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    await client.begin(async (sql) => {
      await sql`
        delete from inspiration_analyses
        where id = ${inspirationAnalysisId}
      `;
      for (const [index, patternId] of inspirationPatternIds.entries()) {
        const assetId = `88888888-8888-4888-8888-88888888882${index}`;
        await sql`delete from assets where id = ${assetId}`;
        await sql`delete from patterns where id = ${patternId}`;
      }
    });
  } finally {
    await client.end();
  }
}

async function interceptInspirationImages(
  page: Parameters<typeof loginAs>[0],
) {
  await page.route("**/api/assets/*/view", async (route) => {
    const ordinal = Number(route.request().url().match(/82(\d)\/view$/)?.[1] ?? 0);
    const palettes = [
      ["#EEE8DA", "#7A8B83", "#303632"],
      ["#D9D2C3", "#69766F", "#24302A"],
      ["#E7E3DC", "#89928D", "#38413C"],
      ["#F0E7D6", "#73847A", "#2D3933"],
    ];
    const [light, mid, dark] = palettes[ordinal % palettes.length]!;
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect width="800" height="600" fill="${light}"/><path d="M0 410 230 180l155 150 130-130 285 250v150H0Z" fill="${mid}"/><circle cx="610" cy="145" r="105" fill="${dark}" opacity=".92"/><path d="M-40 80 280 400M80 20l320 320M420 500l260-260" stroke="${dark}" stroke-width="22" opacity=".18"/></svg>`,
    });
  });
}

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

test("keeps the inspiration workspace at a readable desktop measure", async ({
  page,
}) => {
  await page.setViewportSize(viewports[0]);
  await page.goto("/login");
  await page.evaluate(() => localStorage.removeItem("melon:sidebar-mode"));
  await loginAs(page, E2E_USERS.designer);
  await page.getByRole("button", { name: "折叠主导航" }).click();
  await page.getByRole("link", { name: "灵感调研" }).click();

  const workspaceMain = page.locator(".workspace-main");
  const inspiration = page.getByRole("main", { name: "灵感调研" });
  await expect(inspiration).toBeVisible();
  const geometry = await page.evaluate(() => {
    const container = document.querySelector(".workspace-main");
    const content = document.querySelector(
      '[aria-label="研究详情"]',
    );
    if (!container || !content) throw new Error("INSPIRATION_LAYOUT_MISSING");
    const containerRect = container.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      contentWidth: contentRect.width,
      leftInset: contentRect.left - containerRect.left,
      rightInset: containerRect.right - contentRect.right,
    };
  });

  expect(geometry.contentWidth).toBeLessThanOrEqual(1180);
  expect(Math.abs(geometry.leftInset - geometry.rightInset)).toBeLessThanOrEqual(
    1,
  );
  await expect(workspaceMain).toBeVisible();
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

test.describe("inspiration visual workspace", () => {
  test.beforeEach(seedInspirationVisualWorkspace);
  test.afterEach(cleanupInspirationVisualWorkspace);

  test("stays usable across target sizes and disabled image search", async ({
    page,
  }) => {
    await interceptInspirationImages(page);
    await loginAs(page, E2E_USERS.designer);
    const libraryMatches = page
      .getByRole("region", { name: "素材库色彩匹配" })
      .getByRole("link");

    for (const viewport of viewports.slice(0, 2)) {
      await page.setViewportSize(viewport);
      await page.goto("/inspiration");
      await expect(
        page.getByRole("heading", {
          name: "都市轻通勤与柔和自然配色趋势研究",
        }),
      ).toBeVisible();
      await expect(libraryMatches).toHaveCount(8);
      await expectNoPageOverflow(page);
    }

    for (const viewport of viewports.slice(2)) {
      await page.setViewportSize(viewport);
      await page.goto("/inspiration");
      await expect(libraryMatches).toHaveCount(8);
      await expectNoPageOverflow(page);
    }
    await page.setViewportSize(viewports[1]);
    await page.goto("/inspiration");

    await expect(libraryMatches).toHaveCount(8);
    for (const link of await libraryMatches.all()) {
      await expect(link).toHaveAttribute(
        "href",
        /^\/library\?selected=88888888-8888-4888-8888-88888888881\d$/,
      );
    }

    const historyTrigger = page.getByRole("button", { name: "历史" });
    await historyTrigger.click();
    await expect(page.getByRole("dialog", { name: "研究历史" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "研究历史" })).toBeHidden();
    await expect(historyTrigger).toBeFocused();

    const newResearchTrigger = page.getByRole("button", { name: "新建调研" });
    await newResearchTrigger.click();
    await expect(
      page.getByRole("dialog", { name: "新建灵感调研" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "新建灵感调研" }),
    ).toBeHidden();
    await expect(newResearchTrigger).toBeFocused();

    const refresh = await page.request.post(
      `/api/inspiration-analyses/${inspirationAnalysisId}/visuals`,
      {
        data: { operationId: randomUUID() },
        headers: { Origin: new URL(page.url()).origin },
      },
    );
    expect(refresh.status()).toBe(503);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "都市轻通勤的柔和层次" }),
    ).toBeVisible();
    await expect(page.getByText("素材库色彩匹配暂未开启")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "重试视觉素材" }),
    ).toHaveCount(0);
    await expect(newResearchTrigger).toBeEnabled();
    await expect(libraryMatches).toHaveCount(8);
  });
});
