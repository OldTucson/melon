import path from "node:path";

import { config as loadDotEnv } from "dotenv";
import postgres from "postgres";

import { E2E_DATABASE_URL, E2E_USERS } from "./environment";
import { E2E_PATTERN_SEEDS } from "./fixtures";
import { resetAndSeed } from "./global-setup";
import { assertE2eOssListAccess } from "./oss-client";

loadDotEnv({ path: path.join(process.cwd(), ".env.local") });
await assertE2eOssListAccess();
await resetAndSeed();

const client = postgres(E2E_DATABASE_URL, { max: 1 });
try {
  const seeds = [
    ...E2E_PATTERN_SEEDS.folderWorkflow,
    E2E_PATTERN_SEEDS.isolationActor,
  ];
  for (const seed of seeds) {
    await client`
      insert into patterns (
        id,
        owner_id,
        name,
        original_filename,
        extension,
        detected_mime_type,
        size_bytes,
        status,
        preview_status
      ) values (
        ${seed.id},
        ${E2E_USERS.designer.id},
        ${seed.name},
        ${seed.originalFilename},
        'png',
        'image/png',
        1024,
        'ready',
        'unsupported'
      )
    `;
  }
} finally {
  await client.end();
}
