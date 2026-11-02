// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseDotEnv } from 'dotenv';
import sharp from 'sharp';
import { describe, it } from 'vitest';
import { parseServerEnv } from '@/lib/env/server';
import { UPLOAD_REQUEST_TIMEOUT_MS } from '@/features/storage/upload-timing';
import { createQwenImageProvider } from './qwen-image-provider';
import { createConceptObjectStore } from './object-store';
import { conceptOutputObjectKey } from './object-keys';
import { importConceptOutput } from './output-importer';
import { prepareConceptInput } from './image-input';
import { buildSketchPrompt, buildEffectPrompt, buildFlatPrompt } from './prompts';
import { conceptBriefFixture } from './test-fixtures';
const runReal = process.env.RUN_REAL_INSPIRATION_CONCEPT_TESTS === '1';
// No config loading, credentials, provider or storage initialization outside opt-in.
function realConfig() {
    const localPath = path.join(process.cwd(), '.env.local');
    const local = existsSync(localPath) ? parseDotEnv(readFileSync(localPath)) : {};
    const names = ['DASHSCOPE_API_KEY', 'DASHSCOPE_WORKSPACE_ID', 'DASHSCOPE_OPENAI_BASE_URL', 'DASHSCOPE_NATIVE_BASE_URL', 'ALIYUN_OSS_REGION', 'ALIYUN_OSS_BUCKET', 'ALIYUN_OSS_ENDPOINT', 'ALIYUN_OSS_CNAME', 'ALIYUN_STS_ROLE_ARN', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'] as const;
    const config: Record<string, string | undefined> = {};
    for (const name of names)
        config[name] = process.env[name] ?? local[name];
    for (const name of names.filter((name) => name.startsWith('ALIBABA_CLOUD_')))
        if (config[name])
            process.env[name] = config[name];
    return parseServerEnv({ ...config, NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/unused', AUTH_SECRET: 'real-smoke-unused-auth-secret-32-characters', APP_ORIGIN: 'http://localhost:3000', OSS_ADAPTER: 'real', INSPIRATION_ENABLED: 'true', INSPIRATION_CONCEPT_IMAGES_ENABLED: 'true' });
}
(runReal ? describe : describe.skip)('explicit billed Qwen Image three-stage smoke', () => {
    it('imports one sketch, effect and flat with bounded polling and removes every smoke object', async () => {
        let store: ReturnType<typeof createConceptObjectStore> | undefined;
        const keys: string[] = [];
        let failure = false;
        const signal = AbortSignal.timeout(12 * 60000);
        try {
            const env = realConfig();
            store = createConceptObjectStore({ region: env.ALIYUN_OSS_REGION, bucket: env.ALIYUN_OSS_BUCKET, endpoint: env.ALIYUN_OSS_ENDPOINT, cname: env.ALIYUN_OSS_CNAME });
            const provider = createQwenImageProvider({ apiKey: env.DASHSCOPE_API_KEY!, nativeBaseUrl: env.DASHSCOPE_NATIVE_BASE_URL! });
            const identity = { ownerId: randomUUID(), analysisId: randomUUID(), setId: randomUUID() };
            const brief = { ...conceptBriefFixture, referenceAssetIds: [randomUUID(), randomUUID()] };
            // Fixed local fashion swatches; no third-party images or private library inputs.
            const references = await Promise.all(['#8b9b82', '#ddc7a3'].map(async (color) => prepareConceptInput({ contentType: 'image/png', bytes: await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${color}"/><path d="M0 0L256 256M0 128L128 256M128 0L256 128" stroke="#fff" stroke-width="5"/></svg>`)).png().toBuffer() })));
            let master: string | undefined;
            const prompts = { sketch: buildSketchPrompt, effect: buildEffectPrompt, flat: buildFlatPrompt };
            for (const kind of ['sketch', 'effect', 'flat'] as const) {
                signal.throwIfAborted();
                const images = kind === 'sketch' ? references : [master!, ...references.slice(0, 2)];
                if (images.some((image) => !image) || images.length > 3)
                    throw new Error();
                // Exactly one paid submission per stage. Never retry an ambiguous submission.
                const task = await provider.createTask({ kind, prompt: prompts[kind](brief), images, signal });
                let temporaryImageUrl: string | undefined;
                for (let attempt = 0; attempt < 24; attempt++) {
                    const state = await provider.queryTask({ taskId: task.taskId, signal });
                    if (state.state === 'succeeded') {
                        temporaryImageUrl = state.temporaryImageUrl;
                        break;
                    }
                    if (state.state !== 'pending')
                        throw new Error();
                    await delay(Math.min(10000, 1000 * 2 ** Math.min(attempt, 4)), undefined, { signal });
                }
                if (!temporaryImageUrl)
                    throw new Error();
                const outputId = randomUUID();
                const key = conceptOutputObjectKey({ ...identity, outputId, outputKind: kind });
                keys.push(key); // Include ambiguous puts in finally cleanup.
                const imported = await importConceptOutput({ ...identity, outputId, outputKind: kind, temporaryImageUrl, title: 'Smoke concept', altText: 'Original linen clothing concept', signal }, { store });
                const object = await store.get(imported.writtenKey);
                const decoded = await sharp(object.bytes).raw().toBuffer({ resolveWithObject: true });
                if (decoded.info.width !== (kind === 'flat' ? 2048 : 1536) || decoded.info.height !== (kind === 'flat' ? 1536 : 2048) || new Set(decoded.data).size < 8)
                    throw new Error();
                if (kind === 'sketch')
                    master = await prepareConceptInput(object);
            }
        }
        catch {
            failure = true;
        }
        finally {
            if (store && keys.length) {
                try {
                    await store.delete(keys);
                }
                catch {
                    failure = true;
                }
            }
        }
        // Fixed failure prevents Vitest from serializing any cause, URL, key, prompt or ID.
        if (failure)
            throw new Error('REAL_CONCEPT_SMOKE_OR_CLEANUP_FAILED');
    // Leave room after the request deadline for an in-flight OSS operation,
    // importer compensation, credential refresh and the final delete batch.
    }, 12 * 60_000 + 4 * UPLOAD_REQUEST_TIMEOUT_MS + 60_000);
});
