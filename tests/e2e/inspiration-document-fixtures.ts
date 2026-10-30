import type { Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";
import postgres from "postgres";
import { inspirationResultFixture, inspirationSourceFixture } from "../../src/features/inspiration/test-fixtures";
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_METADATA_ONLY, E2E_USERS, e2eDatabaseName } from "./environment";

// Stable, dedicated identities; no uploaded objects or provider requests exist.
const id = (suffix: number) => `12121212-1212-4121-8121-${String(suffix).padStart(12, "0")}`;
const analysisId = id(1);
const jobId = id(2);
const shareId = id(3);
const webId = (index: number) => id(100 + index);
const patternId = (index: number) => id(200 + index);
const previewId = (index: number) => id(300 + index);
const matchId = (index: number) => id(400 + index);
const sharePath = `/share/inspiration/${shareId}`;
export const documentFixture = {
  title: "棉麻通勤 · 编辑式研究门禁",
  sharePath,
  revokedSharePath: `/share/inspiration/${id(4)}`,
  detailPath: `/api/inspiration-analyses/${analysisId}`,
  visualsPath: `/api/inspiration-analyses/${analysisId}/visuals`,
  ownerAssetPath: `/api/inspiration-visual-assets/${webId(0)}`,
  sharedAssetPath: `${sharePath}/assets/${webId(0)}`,
  removedAssetPath: `${sharePath}/assets/${webId(7)}`,
  removedOwnerAssetPath: `/api/inspiration-visual-assets/${webId(7)}`,
  privateAssetPath: `/api/assets/${previewId(0)}/view`,
  privateMatchId: matchId(0),
};

function database() {
  if (!E2E_METADATA_ONLY) throw new Error("INSPIRATION_E2E_REQUIRES_METADATA_ONLY");
  e2eDatabaseName(E2E_DATABASE_URL);
  return postgres(E2E_DATABASE_URL, { max: 1 });
}

export async function cleanupDocument() {
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      await tx`delete from inspiration_analyses where id = ${analysisId} and owner_id = ${E2E_USERS.designer.id}`;
      for (let i = 0; i < 2; i++) {
        await tx`delete from assets where id = ${previewId(i)} and owner_id = ${E2E_USERS.designer.id}`;
        await tx`delete from patterns where id = ${patternId(i)} and owner_id = ${E2E_USERS.designer.id}`;
      }
    });
  } finally { await sql.end(); }
}

export async function seedDocument(count: 0 | 1 | 4 | 8) {
  await cleanupDocument();
  const sql = database();
  const ownerId = E2E_USERS.designer.id;
  try {
    await sql.begin(async (tx) => {
      await tx`insert into inspiration_analyses
        (id, owner_id, operation_id, title, prompt, status, sources, result, search_model, structure_model, share_id, completed_at)
        values (${analysisId}, ${ownerId}, ${id(5)}, ${documentFixture.title},
        '研究棉麻、自然配色和轻盈通勤服装的设计方向', 'completed',
        ${JSON.stringify([inspirationSourceFixture])}::jsonb, ${JSON.stringify(inspirationResultFixture)}::jsonb,
        'offline-fixture', 'offline-fixture', ${shareId}, now())`;
      await tx`insert into inspiration_visual_jobs
        (id, owner_id, analysis_id, operation_id, kind, status, completed_at)
        values (${jobId}, ${ownerId}, ${analysisId}, ${id(6)}, 'research_visuals', 'completed', now())`;
      for (let i = 0; i < count; i++) {
        const role = i === 0 ? "hero" : i < (count === 4 ? 2 : 4) ? "evidence" : "product";
        const title = i === 0 ? "棉麻主视觉" : role === "product" ? `棉麻衬衫 ${i - (count === 4 ? 1 : 3)}` : `织物与廓形证据 ${i}`;
        await tx`insert into inspiration_visual_assets
          (id, owner_id, analysis_id, job_id, kind, ordinal, title, alt_text,
           document_role, source_indexes, source_page_url, source_site_name, source_query,
           product_name, brand, object_key, content_type, width, height)
          values (${webId(i)}, ${ownerId}, ${analysisId}, ${jobId}, 'web_evidence', ${i}, ${title}, ${title},
           ${role}, '[1]'::jsonb, ${`https://example.test/editorial/${i}`}, '本地示例时尚站', '固定离线棉麻意图',
           ${role === "product" ? title : null}, ${role === "product" ? "示例品牌" : null},
           ${`metadata-only-not-an-oss-object-${i}`}, 'image/png', 640, 480)`;
      }
      for (let i = 0; i < 2; i++) {
        const title = i === 0 ? "方向内私有纹样" : "未分配私有纹样";
        await tx`insert into patterns
          (id, owner_id, name, original_filename, extension, detected_mime_type, size_bytes, status, preview_status)
          values (${patternId(i)}, ${ownerId}, ${title}, 'local.png', 'png', 'image/png', 1024, 'ready', 'ready')`;
        // Metadata-only placeholder, removed before global teardown's strict assets-empty check.
        await tx`insert into assets
          (id, owner_id, pattern_id, role, object_key, original_filename, detected_mime_type, size_bytes, width, height)
          values (${previewId(i)}, ${ownerId}, ${patternId(i)}, 'preview', ${`metadata-only-not-an-oss-preview-${i}`},
          'local.png', 'image/png', 1024, 640, 480)`;
        await tx`insert into inspiration_visual_assets
          (id, owner_id, analysis_id, job_id, kind, ordinal, direction_index, title, alt_text, pattern_id)
          values (${matchId(i)}, ${ownerId}, ${analysisId}, ${jobId}, 'library_match', ${i}, ${i === 0 ? 0 : null},
          ${title}, ${title}, ${patternId(i)})`;
      }
    });
  } finally { await sql.end(); }
}

export async function revokeShare() {
  const sql = database();
  try { await sql`update inspiration_analyses set share_id = null where id = ${analysisId} and owner_id = ${E2E_USERS.designer.id}`; }
  finally { await sql.end(); }
}

export async function removeWebAsset() {
  const sql = database();
  try { await sql`delete from inspiration_visual_assets where id = ${webId(7)} and owner_id = ${E2E_USERS.designer.id}`; }
  finally { await sql.end(); }
}

// A fixed 640×480 raster textile illustration, embedded locally (never fetched).
const RASTER = Buffer.from("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", "base64");
const byteRoute = `${E2E_BASE_URL}/**`;
export async function installDocumentBytes(page: Page, count: number, brokenHero = false) {
  await page.unroute(byteRoute);
  const webPaths = Array.from({ length: count }, (_, index) => [
    `/api/inspiration-visual-assets/${webId(index)}`, `${sharePath}/assets/${webId(index)}`,
  ]).flat();
  const allowed = new Set([...webPaths, ...[0, 1].map((i) => `/api/assets/${previewId(i)}/view`)]);
  await page.route(byteRoute, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && request.resourceType() === "image" && allowed.has(url.pathname) && !url.search) {
      // Corrupt local image bytes exercise onError without an unrelated HTTP error.
      const broken = brokenHero && [documentFixture.ownerAssetPath, documentFixture.sharedAssetPath].includes(url.pathname);
      await route.fulfill({ status: 200, contentType: "image/png", body: broken ? Buffer.from("invalid-local-png") : RASTER });
    } else await route.continue();
  });
}

export const test = base.extend({
  page: async ({ page }, providePage) => {
    if (!E2E_METADATA_ONLY) throw new Error("INSPIRATION_E2E_REQUIRES_METADATA_ONLY");
    let externalRequests = 0;
    const errors: string[] = [];
    await page.context().route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== E2E_BASE_URL) {
        externalRequests++;
        await route.abort();
      } else await route.continue();
    });
    page.on("pageerror", () => errors.push("PAGE_ERROR"));
    page.on("console", (message) => { if (message.type() === "error") errors.push("CONSOLE_ERROR"); });
    try { await providePage(page); }
    finally {
      await cleanupDocument();
      expect(externalRequests, "no provider/remote image/OSS browser requests").toBe(0);
      expect(errors, "no browser errors").toEqual([]);
    }
  },
});
export { expect };
