import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";

const RETENTION_MS = 24 * 60 * 60 * 1_000;

export async function runAuthRateLimitCleanup(input: {
  now: Date;
  cleanup(cutoff: Date, now: Date): Promise<number>;
}) {
  const cutoff = new Date(input.now.getTime() - RETENTION_MS);
  return { deleted: await input.cleanup(cutoff, input.now) };
}

async function main() {
  nextEnv.loadEnvConfig(process.cwd());
  const [{ cleanupExpiredLoginRateLimits }, { closeDatabase }] =
    await Promise.all([
      import("@/features/auth/login-rate-limit-repository"),
      import("@/lib/db/client"),
    ]);

  try {
    const result = await runAuthRateLimitCleanup({
      now: new Date(),
      cleanup: (cutoff, now) =>
        cleanupExpiredLoginRateLimits({ cutoff, now }),
    });
    console.log(`Auth rate limit cleanup: ${result.deleted} deleted`);
  } finally {
    await closeDatabase();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch(() => {
    console.error("Auth rate limit cleanup failed.");
    process.exitCode = 1;
  });
}
