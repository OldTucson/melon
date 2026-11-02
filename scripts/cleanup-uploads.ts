import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";

const BATCH_SIZE = 100;

async function main() {
  nextEnv.loadEnvConfig(process.cwd());
  const [{ expireStaleUploadSessions }, { closeDatabase }] =
    await Promise.all([
      import("@/features/uploads/upload-service"),
      import("@/lib/db/client"),
    ]);

  let expired = 0;
  try {
    for (;;) {
      const batch = await expireStaleUploadSessions({ limit: BATCH_SIZE });
      expired += batch;
      if (batch < BATCH_SIZE) break;
    }
    console.log(`Upload cleanup: ${expired} expired`);
  } finally {
    await closeDatabase();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch(() => {
    console.error("Upload cleanup failed.");
    process.exitCode = 1;
  });
}
