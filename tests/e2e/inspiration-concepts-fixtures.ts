import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import sharp from 'sharp';
import { conceptBriefFixture } from '../../src/features/inspiration-concepts/test-fixtures';
import { conceptOutputObjectKey } from '../../src/features/inspiration-concepts/object-keys';
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_METADATA_ONLY, E2E_USERS, e2eDatabaseName } from './environment';
import { test as documentTest, documentFixture, seedDocument, installDocumentBytes } from './inspiration-document-fixtures';
export { expect, revokeShare } from './inspiration-document-fixtures';
export const analysisId = documentFixture.detailPath.split('/').at(-1)!;
export const conceptPath = `${documentFixture.detailPath}/concept-sets`;
export const conceptFixture = { ...documentFixture, analysisId, conceptPath };
export type Stage = 'queued' | 'sketch' | 'derivatives' | 'partial' | 'completed';
const kinds = ['sketch', 'effect', 'flat'] as const;
export async function database<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    if (!E2E_METADATA_ONLY)
        throw new Error('CONCEPT_E2E_REQUIRES_METADATA_ONLY');
    e2eDatabaseName(E2E_DATABASE_URL);
    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
        return await run(sql);
    }
    finally {
        await sql.end();
    }
}
async function cleanupSets() {
    await database(async (sql) => { await sql `delete from inspiration_concept_sets where analysis_id=${analysisId} and owner_id=${E2E_USERS.designer.id}`; });
}
export const test = documentTest.extend({ page: async ({ page }, providePage) => {
        try {
            await providePage(page);
        }
        finally {
            await cleanupSets();
        }
    } });
export async function seedConceptDocument() { await cleanupSets(); await seedDocument(4); }
export async function retainedSets() {
    return database((sql) => sql<{
        id: string;
        version: number;
    }[]> `select id, version from inspiration_concept_sets where analysis_id=${analysisId} and owner_id=${E2E_USERS.designer.id} and deleted_at is null order by version`);
}
// Only worker lifecycle metadata is simulated. Mutations and authorization use real HTTP/DB.
export async function advanceSet(setId: string, stage: Stage) {
    await database(async (sql) => {
        await sql.begin(async (tx) => {
            const [set] = await tx `select id from inspiration_concept_sets where id=${setId} and analysis_id=${analysisId} and owner_id=${E2E_USERS.designer.id}`;
            if (!set)
                throw new Error('FIXTURE_SET_MISSING');
            for (const [index, kind] of kinds.entries()) {
                if (stage === 'queued' || (stage === 'sketch' && index > 0))
                    continue;
                let [task] = await tx `select id, status from inspiration_concept_tasks where set_id=${setId} and output_kind=${kind} order by attempt desc limit 1`;
                if (!task) {
                    [task] = await tx `insert into inspiration_concept_tasks (id,owner_id,set_id,operation_id,output_kind,attempt,status,available_at) values (${randomUUID()},${E2E_USERS.designer.id},${setId},${randomUUID()},${kind},1,'queued',now()) returning id,status`;
                }
                const pending = stage === 'derivatives' && index > 0;
                const failed = stage === 'partial' && kind === 'flat';
                await tx `update inspiration_concept_tasks set status=${pending ? 'submitted' : failed ? 'failed' : 'completed'}, submit_started_at=now(), provider_task_id='offline-fixture-task', completed_at=${pending ? null : new Date()}, error_code=${failed ? 'INSPIRATION_CONCEPT_TIMEOUT' : null}, lease_owner=null, lease_until=null where id=${task!.id}`;
                if (pending || failed)
                    continue;
                const outputId = randomUUID();
                const objectKey = conceptOutputObjectKey({ ownerId: E2E_USERS.designer.id, analysisId, setId, outputId, outputKind: kind });
                // Replacement changes the asset only once its task has completed.
                await tx `insert into inspiration_concept_outputs (id,owner_id,analysis_id,set_id,source_task_id,output_kind,title,alt_text,object_key,content_type,width,height) values (${outputId},${E2E_USERS.designer.id},${analysisId},${setId},${task!.id},${kind},${`离线${kind}成图`},${`原创棉麻 ${kind}`},${objectKey},'image/png',${kind === 'flat' ? 2048 : 1536},${kind === 'flat' ? 1536 : 2048}) on conflict (set_id,output_kind) do update set id=excluded.id, source_task_id=excluded.source_task_id, object_key=excluded.object_key where inspiration_concept_outputs.source_task_id<>excluded.source_task_id`;
            }
            const active = stage === 'queued' || stage === 'derivatives';
            await tx `update inspiration_concept_sets set status=${active ? 'generating' : stage === 'completed' ? 'completed' : 'partial'}, completed_at=${active ? null : new Date()} where id=${setId}`;
        });
    });
}
export async function seedSet(stage: Stage, version = 1) {
    const setId = randomUUID();
    await database(async (sql) => {
        await sql `insert into inspiration_concept_sets (id,owner_id,analysis_id,operation_id,direction_index,version,status,brief_snapshot,prompt_template_version,model) values (${setId},${E2E_USERS.designer.id},${analysisId},${randomUUID()},0,${version},'queued',${sql.json(conceptBriefFixture)},${conceptBriefFixture.promptTemplateVersion},${conceptBriefFixture.model})`;
        await sql `insert into inspiration_concept_tasks (id,owner_id,set_id,operation_id,output_kind,attempt,status,available_at) values (${randomUUID()},${E2E_USERS.designer.id},${setId},${randomUUID()},'sketch',1,'queued',now())`;
    });
    await advanceSet(setId, stage);
    return setId;
}
let portrait: Buffer, landscape: Buffer;
export async function localConceptBytes(flat = false) {
    if (!portrait) {
        const svg = (w: number, h: number) => Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ece7db"/><path d="M${w * .35},${h * .15} L${w * .65},${h * .15} L${w * .82},${h * .38} L${w * .7},${h * .46} L${w * .63},${h * .34} L${w * .7},${h * .88} L${w * .3},${h * .88} L${w * .37},${h * .34} L${w * .3},${h * .46} L${w * .18},${h * .38} Z" fill="#7f917a" stroke="#303c34" stroke-width="8"/><path d="M${w * .5},${h * .16} V${h * .87}" stroke="#e8d6b4" stroke-width="7"/></svg>`);
        portrait = await sharp(svg(1536, 2048)).png().toBuffer();
        landscape = await sharp(svg(2048, 1536)).png().toBuffer();
    }
    return flat ? landscape : portrait;
}
export async function installConceptBytes(page: Page) {
    await installDocumentBytes(page, 4);
    await page.route(/\/(?:api\/inspiration-concept-assets|share\/inspiration\/[^/]+\/assets)\/[^/?]+(?:\/download)?$/, async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== E2E_BASE_URL) {
            await route.fallback();
            return;
        }
        const parts = url.pathname.split('/');
        const assetId = parts.at(-1) === 'download' ? parts.at(-2)! : parts.at(-1)!;
        const [output] = await database((sql) => sql `select output_kind from inspiration_concept_outputs where id=${assetId} and owner_id=${E2E_USERS.designer.id} and analysis_id=${analysisId}`);
        if (!output) {
            await route.fallback();
            return;
        }
        const body = await localConceptBytes(output.output_kind === 'flat');
        await route.fulfill({ status: 200, body, headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', ...(url.pathname.endsWith('/download') ? { 'Content-Disposition': "attachment; filename=concept.png; filename*=UTF-8''concept.png" } : {}) } });
    });
}
