import { randomUUID } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { loginAs } from './fixtures';
import { E2E_BASE_URL, E2E_USERS } from './environment';
import { test, expect, seedConceptDocument, seedSet, advanceSet, retainedSets, installConceptBytes, conceptFixture as fixture, database, revokeShare } from './inspiration-concepts-fixtures';
const disabled = process.env.E2E_CONCEPTS_DISABLED === '1';
const viewports = [{ width: 1512, height: 982 }, { width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }];
const screenshotStyle = 'nextjs-portal { visibility:hidden!important; }';
const results = (page: Page) => page.locator('[data-concept-results]').first();
async function owner(page: Page) {
    await page.goto('/inspiration');
    await expect(page.getByRole('article', { name: fixture.title })).toBeVisible();
}
async function assertGeometry(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBe(true);
    const measure = (await page.getByRole('article', { name: fixture.title }).boundingBox())!.width;
    expect(measure).toBeLessThanOrEqual(961);
    if (page.viewportSize()!.width >= 1440)
        expect(measure).toBeGreaterThanOrEqual(950);
    const slots = page.locator('[data-concept-media]:visible');
    const boxes = await slots.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i]!;
        expect(a.w / a.h).toBeCloseTo(i % 3 === 2 ? 4 / 3 : 3 / 4, 2);
        for (let j = i + 1; j < boxes.length; j++) {
            const b = boxes[j]!;
            expect(a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1).toBe(true);
        }
    }
    expect(await results(page).locator('button, strong, figcaption').evaluateAll((els) => els.every((el) => {
        const s = getComputedStyle(el);
        return (s.letterSpacing === 'normal' || parseFloat(s.letterSpacing) >= 0) && el.scrollWidth <= el.clientWidth + 1;
    }))).toBe(true);
    for (const label of await results(page).locator('figcaption strong:visible').all())
        expect(await label.evaluate(el => getComputedStyle(el).fontSize)).toBe('12px');
    return boxes.map(({ w, h }) => ({ w, h }));
}
async function imagesDecode(scope: Locator) {
    for (const img of await scope.locator('img').all()) {
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
        const slot = img.locator('xpath=ancestor::figure[@aria-label]');
        if (await slot.count()) {
            const name = await slot.getAttribute('aria-label');
            if (['设计草图', '服装效果图', '服装款式图'].includes(name!))
                expect(await img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual(name === '服装款式图' ? [2048, 1536] : [1536, 2048]);
        }
        expect(await img.evaluate((el: HTMLImageElement) => {
            const c = document.createElement('canvas');
            c.width = 32;
            c.height = 32;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(el, 0, 0, 32, 32);
            const pixels = ctx.getImageData(0, 0, 32, 32).data;
            return new Set(Array.from({ length: 1024 }, (_, i) => Array.from(pixels.slice(i * 4, i * 4 + 3)).join(','))).size > 5;
        })).toBe(true);
    }
}
async function capture(page: Page, info: TestInfo, name: string) {
    await assertGeometry(page);
    await results(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${name}.png`), style: screenshotStyle });
}
async function sharedState(page: Page, info: TestInfo, name: string, count: number) {
    await page.goto(fixture.sharePath);
    await expect(page.getByRole('article', { name: fixture.title })).toBeVisible();
    await expect(results(page).locator('img')).toHaveCount(count);
    await expect(page.getByRole('button', { name: /生成整套|重试|方案操作/ })).toHaveCount(0);
    await expect(results(page).getByText(/排队中|生成失败|等待草图|正在重新生成/)).toHaveCount(0);
    await imagesDecode(results(page));
    await assertGeometry(page);
    await capture(page, info, `shared-${name}`);
    await owner(page);
}
async function dialogGeometry(page: Page) {
    const dialog = page.getByRole('dialog');
    const box = (await dialog.boundingBox())!;
    const size = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await dialog.locator('button, label, h2').evaluateAll(els => els.every(el => { const style = getComputedStyle(el); return el.scrollWidth <= el.clientWidth + 1 && (style.letterSpacing === 'normal' || parseFloat(style.letterSpacing) >= 0); }))).toBe(true);
}
async function dialogFocus(page: Page, trigger: Locator, close: string) {
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialogGeometry(page);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => { const el = document.activeElement!; const s = getComputedStyle(el); return el.matches(':focus-visible') && (s.outlineStyle !== 'none' || s.boxShadow !== 'none'); })).toBe(true);
    await page.getByRole('button', { name: close, exact: true }).click();
    await expect(trigger).toBeFocused();
}
async function newVersion(page: Page) {
    await results(page).getByRole('button', { name: '方案操作' }).click();
    await page.getByRole('menuitem', { name: '重新生成草图（新方案）' }).click();
    await dialogGeometry(page);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(results(page).getByRole('button', { name: '方案操作' })).toBeFocused();
    await results(page).getByRole('button', { name: '方案操作' }).click();
    await page.getByRole('menuitem', { name: '重新生成草图（新方案）' }).click();
    await page.getByRole('button', { name: '确认生成新方案' }).click();
    await expect.poll(() => results(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
}
for (const viewport of viewports)
    test(`offline workflow and visual QA ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
        test.skip(disabled, 'paid workflow runs only in the offline enabled server');
        test.setTimeout(180000);
        await page.setViewportSize(viewport);
        await seedConceptDocument();
        await installConceptBytes(page);
        await loginAs(page, E2E_USERS.designer);
        await owner(page);
        await assertGeometry(page);
        await capture(page, info, 'owner-zero');
        await sharedState(page, info, 'zero', 0);
        const create = page.getByRole('button', { name: '生成整套成图', exact: true }).first();
        await dialogFocus(page, create, '关闭生成面板');
        await create.click();
        const drawer = page.getByRole('dialog');
        await expect(drawer.getByRole('checkbox', { checked: true })).toHaveCount(3);
        await drawer.getByRole('checkbox').first().uncheck();
        await expect(drawer.getByText('已选 2 / 3')).toBeVisible();
        await imagesDecode(drawer);
        await page.screenshot({ path: info.outputPath('owner-drawer.png'), style: screenshotStyle });
        let creates = 0;
        page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === fixture.conceptPath)
            creates++; });
        await drawer.getByRole('button', { name: '生成整套成图', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(results(page).getByRole('tab', { name: '方案 01' })).toBeVisible();
        const projected = JSON.stringify(await (await page.request.get(fixture.conceptPath)).json());
        for (const field of ['briefSnapshot', 'providerTaskId', 'providerRequestId', 'objectKey', 'promptTemplateVersion'])
            expect(projected).not.toContain(field);
        expect(creates).toBe(1);
        const [set] = await retainedSets();
        expect(await retainedSets()).toHaveLength(1);
        expect(await database((sql) => sql `select ordinal from inspiration_concept_references where set_id=${set!.id}`)).toHaveLength(2);
        const initial = await assertGeometry(page);
        await capture(page, info, 'owner-queued');
        await sharedState(page, info, 'queued', 0);
        // Leave the report while work advances; revisit and read durable server state.
        await page.goto('/');
        await advanceSet(set!.id, 'sketch');
        await owner(page);
        await expect(results(page).locator('img')).toHaveCount(1);
        await imagesDecode(results(page));
        await advanceSet(set!.id, 'derivatives');
        await page.reload();
        await expect(results(page).getByText('生成中', { exact: true })).toHaveCount(2);
        expect(await assertGeometry(page)).toEqual(initial);
        await capture(page, info, 'owner-derivatives');
        await advanceSet(set!.id, 'partial');
        await expect(results(page).getByText('生成失败', { exact: true })).toBeVisible();
        await imagesDecode(results(page));
        expect(await assertGeometry(page)).toEqual(initial);
        await capture(page, info, 'owner-partial');
        await sharedState(page, info, 'partial', 2);
        const sibling = await results(page).getByRole('figure', { name: '服装效果图' }).locator('img').getAttribute('src');
        await results(page).getByRole('button', { name: '重试服装款式图' }).click();
        await expect(results(page).getByRole('figure', { name: '服装款式图' }).getByText('排队中')).toBeVisible();
        expect(await results(page).getByRole('figure', { name: '服装效果图' }).locator('img').getAttribute('src')).toBe(sibling);
        await capture(page, info, 'owner-retrying');
        await sharedState(page, info, 'retrying', 2);
        await advanceSet(set!.id, 'completed');
        await expect(results(page).locator('img')).toHaveCount(3);
        await imagesDecode(results(page));
        expect(await assertGeometry(page)).toEqual(initial);
        await capture(page, info, 'owner-completed');
        const current = await results(page).getByRole('figure', { name: '服装效果图' }).locator('img').getAttribute('src');
        await results(page).getByRole('button', { name: '重新生成服装效果图' }).click();
        await expect(results(page).getByText('正在重新生成')).toBeVisible();
        expect(await results(page).getByRole('figure', { name: '服装效果图' }).locator('img').getAttribute('src')).toBe(current);
        await advanceSet(set!.id, 'completed');
        await expect(results(page).getByText('正在重新生成')).toHaveCount(0);
        const preview = results(page).getByRole('button', { name: '预览：离线sketch成图' });
        await dialogFocus(page, preview, '关闭预览');
        await preview.click();
        await imagesDecode(page.getByRole('dialog'));
        await page.screenshot({ path: info.outputPath('owner-output-dialog.png'), style: screenshotStyle });
        const downloadUrl = await page.getByRole('link', { name: '下载图片' }).getAttribute('href');
        const download = await page.evaluate(async (url) => { const response = await fetch(url!); return { headers: Object.fromEntries(response.headers), bytes: Array.from(new Uint8Array(await response.arrayBuffer())) }; }, downloadUrl);
        expect(download.headers['content-type']).toBe('image/png');
        expect(download.headers['cache-control']).toBe('private, no-store');
        expect(download.headers['x-content-type-options']).toBe('nosniff');
        expect(download.headers['content-disposition']).toContain('attachment');
        expect(download.bytes.length).toBeGreaterThan(1000);
        expect(new Set(download.bytes).size).toBeGreaterThan(30);
        await page.getByRole('button', { name: '关闭预览' }).click();
        await expect(preview).toBeFocused();
        await newVersion(page);
        await expect(results(page).getByRole('tab', { name: '方案 02' })).toHaveAttribute('aria-selected', 'true');
        await advanceSet((await retainedSets())[1]!.id, 'completed');
        await page.reload();
        await newVersion(page);
        await expect(results(page).getByRole('tab', { name: '方案 03' })).toBeVisible();
        await advanceSet((await retainedSets())[2]!.id, 'completed');
        await page.reload();
        await expect(create).toBeDisabled();
        await expect(page.getByText('已保留 3 个方案，请先删除一个')).toBeVisible();
        const fourth = await page.request.post(fixture.conceptPath, { headers: { Origin: E2E_BASE_URL }, data: { operationId: randomUUID(), directionIndex: 0, visualJobId: null, referenceAssetIds: [] } });
        expect(fourth.status()).toBe(409);
        expect(await retainedSets()).toHaveLength(3);
        await capture(page, info, 'owner-three-version');
        await sharedState(page, info, 'three-version', 3);
        await results(page).getByRole('button', { name: '方案操作' }).click();
        await page.getByRole('menuitem', { name: '删除方案', exact: true }).click();
        await expect(results(page).getByRole('tab')).toHaveCount(2);
        await expect.poll(async () => (await retainedSets()).length).toBe(2);
        await page.goto(fixture.sharePath);
        await expect(page.getByRole('article', { name: fixture.title })).toBeVisible();
        await expect(results(page).getByText('AI 生成', { exact: true })).toHaveCount(3);
        await expect(page.getByRole('button', { name: /生成整套|重试|方案操作/ })).toHaveCount(0);
        await expect(page.getByText('方向内私有纹样', { exact: true })).toHaveCount(0);
        await imagesDecode(results(page));
        await assertGeometry(page);
        await capture(page, info, 'shared-completed');
        const sharedPreview = results(page).getByRole('button', { name: '预览：离线sketch成图' });
        await dialogFocus(page, sharedPreview, '关闭预览');
        await sharedPreview.click();
        await page.screenshot({ path: info.outputPath('shared-output-dialog.png'), style: screenshotStyle });
        await page.keyboard.press('Escape');
        await expect(sharedPreview).toBeFocused();
    });
test('shared projections omit pending outputs; revoked capability and cross-tenant return real 404', async ({ page }) => {
    await seedConceptDocument();
    await installConceptBytes(page);
    const set = await seedSet('partial');
    await page.goto(fixture.sharePath);
    await expect(results(page).locator('img')).toHaveCount(2);
    await expect(results(page).getByText(/排队中|生成失败|等待草图/)).toHaveCount(0);
    const [asset] = await database((sql) => sql `select id from inspiration_concept_outputs where set_id=${set} limit 1`);
    await loginAs(page, E2E_USERS.tenant);
    for (const path of [fixture.detailPath, fixture.conceptPath, `/api/inspiration-concept-assets/${asset!.id}`, `/api/inspiration-concept-assets/${asset!.id}/download`])
        expect((await page.request.get(path)).status()).toBe(404);
    await revokeShare();
    for (const path of [fixture.sharePath, `${fixture.sharePath}/assets/${asset!.id}`])
        expect((await page.request.get(path)).status()).toBe(404);
});
test('disabled generation keeps completed historical images and hides paid controls', async ({ page }, info) => {
    test.skip(!disabled, 'requires E2E_CONCEPTS_DISABLED=1 server');
    await seedConceptDocument();
    await seedSet('completed');
    await installConceptBytes(page);
    await loginAs(page, E2E_USERS.designer);
    await owner(page);
    await expect(results(page).locator('img')).toHaveCount(3);
    await imagesDecode(results(page));
    await expect(page.getByRole('button', { name: /生成整套|重新生成服装|重试服装/ })).toHaveCount(0);
    await results(page).getByRole('button', { name: '方案操作' }).click();
    await expect(page.getByRole('menuitem', { name: /重新生成/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect((await page.request.post(fixture.conceptPath, { headers: { Origin: E2E_BASE_URL }, data: { operationId: randomUUID(), directionIndex: 0, visualJobId: null, referenceAssetIds: [] } })).status()).toBe(503);
    for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await assertGeometry(page);
        await capture(page, info, `feature-disabled-history-${viewport.width}`);
        await page.goto(fixture.sharePath);
        await expect(results(page).locator('img')).toHaveCount(3);
        await imagesDecode(results(page));
        await assertGeometry(page);
        await capture(page, info, `feature-disabled-share-${viewport.width}`);
        await owner(page);
    }
});

test('closing the browser page does not lose durable queued work', async ({ page }) => {
    await seedConceptDocument();
    const setId = await seedSet('queued');
    await installConceptBytes(page);
    await loginAs(page, E2E_USERS.designer);
    await owner(page);
    await expect(results(page).getByText('排队中', { exact: true })).toBeVisible();
    const context = page.context();
    await page.close();
    await advanceSet(setId, 'completed');
    const reopened = await context.newPage();
    const errors: string[] = [];
    reopened.on('pageerror', () => errors.push('PAGE_ERROR'));
    reopened.on('console', (message) => { if (message.type() === 'error') errors.push('CONSOLE_ERROR'); });
    try {
        await installConceptBytes(reopened);
        await owner(reopened);
        await expect(results(reopened).locator('img')).toHaveCount(3);
        await imagesDecode(results(reopened));
        await expect(results(reopened).getByRole('tab', { name: '方案 01' })).toBeVisible();
        expect(await retainedSets()).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally {
        await reopened.close();
    }
});
